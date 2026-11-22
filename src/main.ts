/**
 * Sealed Note - private notes and inline encrypted blocks for Obsidian.
 *
 * Layering: main.ts wires things together and owns commands/menus. Business rules
 * live in services/, algorithms in core/, disk in storage/, DOM in ui/ + notes/ +
 * inline/. Nothing below services/ knows an Obsidian Modal exists.
 */

import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";

import { DEFAULT_SETTINGS, SealedNoteSettings, normalizeSettings } from "./settings";
import { setLanguage, t } from "./i18n";
import { SealedNoteSettingTab } from "./ui/settings";
import { SealedNoteView, SEALED_VIEW_TYPE } from "./notes/sealed-view";
import { NoteKeyringStore } from "./storage/note-keyring-store";
import { SealedNoteStore, SEALED_EXTENSION } from "./storage/sealed-note-store";
import { SessionStore } from "./core/session";
import { UnlockService } from "./services/unlock-service";
import { EncryptionService } from "./services/encryption-service";
import { ClipboardService } from "./services/clipboard";
import { ConfirmModal, RecoveryKeyModal, SetupModal, UnlockModal } from "./ui/modals";
import { registerEncryptedCodeBlocks } from "./inline/codeblock";
import { registerInlinePayloads } from "./inline/postprocessor";
import { generateRecoveryKey, recoveryKeyText, groupRecovery } from "./core/recovery";
import { createKeyring, createKeyringWithoutPassword, keyFingerprint, newVaultId, SLOT_PASSWORD, SLOT_TOTP, SLOT_PASSWORD_TOTP, KeyringData, setSlot } from "./core/keyring";
import { generateTotpSecret, totpUri, formatSecret } from "./core/totp";
import { describeError, Err } from "./util/errors";
import { log, setLogLevel } from "./util/log";
import { openInline } from "./core/format";
import { TotpSetupModal } from "./ui/totp-modal";
import { CandidatePickerModal, SecretPromptModal } from "./ui/recovery-modals";
import { UnlockModeModal, PasswordPromptModal } from "./ui/mode-modals";
import { sealWithDevice } from "./core/device";
import { SeedImportModal } from "./ui/seed-import-modal";
import { VaultRecoveryService } from "./services/vault-recovery";
import { KeyCopyRefreshService } from "./services/key-copy-refresh";

const SEALED_ICON = "lock";

export default class SealedNotePlugin extends Plugin {
  private readonly log = log.child("plugin");

  settingsData: SealedNoteSettings = { ...DEFAULT_SETTINGS };

  keyringStore!: NoteKeyringStore;
  notes!: SealedNoteStore;
  sessions!: SessionStore;
  unlockService!: UnlockService;
  encryption!: EncryptionService;
  clipboard!: ClipboardService;
  recovery!: VaultRecoveryService;
  keyCopies!: KeyCopyRefreshService;

  private vaultIdentifier = "";
  /** initial keyring, held in memory until the first note can carry it */
  private pendingKeyring: KeyringData | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async onload(): Promise<void> {
    setLogLevel("info");
    this.log.info("loading", { version: this.manifest.version });

    await this.loadSettings();
    setLanguage(this.settingsData.language);

    const dataDir = normalizePath(`${this.manifest.dir ?? ""}`);
    this.vaultIdentifier = newVaultId();

    // Order matters: NoteKeyringStore depends on SealedNoteStore for the
    // ".sealed.md" path rule. Construct the store first.
    this.notes = new SealedNoteStore(this.app, dataDir);
    this.keyringStore = new NoteKeyringStore(this.app, this.notes);
    this.sessions = new SessionStore({ keepMs: this.settingsData.keepUnlockedSeconds * 1000 });
    this.encryption = new EncryptionService(() => this.vaultId());
    this.clipboard = new ClipboardService(() => this.settingsData.clipboardClearSeconds);
    this.recovery = new VaultRecoveryService(this.app, this.notes);
    this.keyCopies = new KeyCopyRefreshService(this.app, this.notes);

    this.unlockService = new UnlockService(this.keyringStore, this.sessions, () => this.settingsData);
    this.unlockService.setUi(() => ({
      prompt: (request) =>
        new Promise((resolve) => {
          new UnlockModal(this.app, request, resolve, async () => {
            const kr = await this.unlockService.keyring();
            return kr ? this.unlockService.hasLocalSeed(kr) : false;
          }).open();
        }),
    }));

    // Existing keyring decides the vault id; otherwise the id is minted on first setup.
    const existing = await this.keyringStore.load().catch((error) => {
      this.log.error("keyring_load_failed", { error: String(error) });
      new Notice(describeError(error), 10000);
      return null;
    });
    if (existing) this.vaultIdentifier = existing.vaultId;

    this.registerView(SEALED_VIEW_TYPE, (leaf) => new SealedNoteView(leaf, this));
    // For a compound name like "note.sealed.md", Obsidian's registerExtensions
    // matches the MIDDLE segment ("sealed"), not the full string and not "md".
    // This is the same pattern Excalidraw uses for ".excalidraw.md".
    this.registerExtensions([this.extensionToken()], SEALED_VIEW_TYPE);

    registerEncryptedCodeBlocks(this);
    registerInlinePayloads(this);

    this.addSettingTab(new SealedNoteSettingTab(this.app, this));
    this.setupRibbon();
    this.setupStatusBar();
    this.registerCommands();
    this.registerMenus();
    this.registerLockHooks();

    this.log.info("loaded", { vault: this.app.vault.getName() });
  }

  onunload(): void {
    this.clipboard?.dispose();
    this.sessions?.lockAll();
    this.log.info("unloaded", {});
  }

  /* ------------------------------------------------------------------ */
  /* settings                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Accessor for the settings object.
   * Deliberately NOT called `settings`: Obsidian's Plugin base class already
   * declares a `settings` member, and overriding it as a function would shadow
   * that property at runtime.
   */
  config(): SealedNoteSettings {
    return this.settingsData;
  }

  /** The token Obsidian uses to route ".sealed.md" files to our view. */
  extensionToken(): string {
    return this.settingsData.extension.split(".")[0];
  }

  async loadSettings(): Promise<void> {
    this.settingsData = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settingsData);
    setLanguage(this.settingsData.language);
    this.sessions?.setOptions({ keepMs: this.settingsData.keepUnlockedSeconds * 1000 });
    this.refreshStatusBar();
  }

  vaultId(): string {
    return this.vaultIdentifier;
  }

  /* ------------------------------------------------------------------ */
  /* keyring access                                                      */
  /* ------------------------------------------------------------------ */

  async hasKeyring(): Promise<boolean> {
    return this.keyringStore.exists();
  }

  /** Ensure a keyring exists, running the setup wizard if needed. Returns the DEK. */
  async requireInitialised(): Promise<Uint8Array | null> {
    if (!(await this.hasKeyring())) {
      return this.runSetup();
    }
    const kr = await this.unlockService.requireKeyring();
    this.vaultIdentifier = kr.vaultId;
    // Already unlocked somewhere? Reuse it, so a command does not re-prompt.
    for (const path of this.sessions.unlockedPaths()) {
      const entry = this.sessions.get(path);
      if (entry) return entry.dek;
    }
    return this.unlockForCommand(t("misc.unlockContinue"));
  }

  private async unlockForCommand(subject: string): Promise<Uint8Array | null> {
    const sentinel = `__command__/${subject}`;
    return this.unlockService.dekFor(sentinel, { subject });
  }

  /* ------------------------------------------------------------------ */
  /* first run                                                           */
  /* ------------------------------------------------------------------ */

  private async runSetup(): Promise<Uint8Array | null> {
    // First ask HOW the user wants to unlock. Previously this wizard demanded a
    // master password unconditionally, which contradicted the promise that TOTP
    // can be used alone.
    const mode = await new Promise<"password" | "totp" | "password+totp" | null>((resolve) => {
      new UnlockModeModal(this.app, resolve).open();
    });
    if (!mode) return null;

    let password: string | undefined;
    if (mode !== "totp") {
      const credentials = await new Promise<{ password: string; hint: string } | null>((resolve) => {
        new SetupModal(this.app, resolve).open();
      });
      if (!credentials) return null;
      password = credentials.password;
    }

    const recoveryKey = generateRecoveryKey();
    const vaultId = newVaultId();
    const { keyring, dek } = password
      ? await createKeyring(vaultId, password, recoveryKey, {})
      : await createKeyringWithoutPassword(vaultId, recoveryKey, {});
    this.vaultIdentifier = vaultId;

    // If TOTP is part of the mode, enrol it now: generate a seed, show the QR,
    // verify a code, then wrap the DEK with the right credential.
    let totpSeed: string | undefined;
    if (mode !== "password") {
      const account = this.app.vault.getName();
      const result = await new Promise<{ seed: string; otpauth: string } | null>((resolve) => {
        new TotpSetupModal(this.app, account, resolve).open();
      });
      if (!result) return null;
      totpSeed = result.seed;
      if (mode === "totp") {
        await setSlot(keyring, dek, SLOT_TOTP, `sn-totp|${totpSeed}`);
      } else {
        await setSlot(keyring, dek, SLOT_PASSWORD_TOTP, `sn-pwd-totp|${password}|${totpSeed}`);
      }
      keyring.totp.enabled = true;
      keyring.totp.mode = mode;
      keyring.totp.seedRef = (await sealWithDevice(vaultId, totpSeed)) ?? undefined;
    }

    // No notes exist yet, so there is nowhere to put the wrapped key. Keep it
    // in memory until the first private note is created (see newSealedNote).
    this.pendingKeyring = keyring;

    const fingerprint = await keyFingerprint(dek);
    const saved = await new Promise<boolean>((resolve) => {
      new RecoveryKeyModal(this.app, recoveryKey, fingerprint, this.app.vault.getName(), resolve).open();
    });

    if (!saved) {
      new Notice(t("misc.recoveryNotSavedLong"), 12000);
      this.log.warn("recovery_key_not_acknowledged", {});
    } else {
      new Notice(t("notice.recoverySaved"), 8000);
    }

    this.refreshStatusBar();
    return dek;
  }

  /* ------------------------------------------------------------------ */
  /* commands                                                            */
  /* ------------------------------------------------------------------ */

  private registerCommands(): void {
    this.addCommand({
      id: "new-sealed-note",
      name: t("cmd.new.name"),
      callback: () => void this.guard(() => this.newSealedNote()),
    });

    this.addCommand({
      id: "encrypt-selection-fence",
      name: t("cmd.encrypt.fence.name"),
      editorCallback: (editor) => void this.guard(() => this.encryptSelection(editor, "fence")),
    });

    this.addCommand({
      id: "encrypt-selection-inline",
      name: t("cmd.encrypt.inline.name"),
      editorCallback: (editor) => void this.guard(() => this.encryptSelection(editor, "inline")),
    });

    this.addCommand({
      id: "decrypt-selection",
      name: t("cmd.decrypt.name"),
      editorCallback: (editor) => void this.guard(() => this.decryptSelection(editor, false)),
    });

    this.addCommand({
      id: "decrypt-selection-to-clipboard",
      name: t("cmd.decrypt.clipboard.name"),
      editorCallback: (editor) => void this.guard(() => this.decryptSelection(editor, true)),
    });

    this.addCommand({
      id: "decrypt-whole-note",
      name: t("cmd.decrypt.whole.name"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.notes.isSealedPath(file.path)) return false;
        if (!checking) void this.guard(() => this.decryptWholeFile(file));
        return true;
      },
    });

    this.addCommand({
      id: "lock-current",
      name: t("cmd.lock.name"),
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.lockFile(file.path);
      },
    });

    this.addCommand({
      id: "lock-all",
      name: t("cmd.lockAll.name"),
      callback: () => {
        const count = this.unlockService.lockAll();
        this.refreshStatusBar();
        this.refreshActiveView();
        new Notice(count > 0 ? t("notice.lockedCount", { n: count }) : t("notice.noUnlocked"));
      },
    });

    this.addCommand({
      id: "show-recovery-key",
      name: t("cmd.recovery.name"),
      callback: () => void this.guard(() => this.showRecoveryKey()),
    });

    this.addCommand({
      id: "rebuild-keyring-from-note",
      name: t("cmd.rebuild.name"),
      callback: () => void this.guard(() => this.rebuildKeyringFromNote()),
    });

    this.addCommand({
      id: "refresh-key-copies",
      name: t("cmd.refreshCopies.name"),
      callback: () => void this.guard(() => this.refreshKeyCopies()),
    });

    this.addCommand({
      id: "setup-totp",
      name: t("cmd.totp.name"),
      callback: () => void this.guard(() => this.setupTotp()),
    });

    this.addCommand({
      id: "open-settings",
      name: t("cmd.settings.name"),
      callback: () => {
        (this.app as any).setting?.open?.();
        (this.app as any).setting?.openTabById?.(this.manifest.id);
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* menus                                                               */
  /* ------------------------------------------------------------------ */

  private registerMenus(): void {
    // Editor context menu: encrypt / decrypt selection.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        const selection = editor.getSelection();
        if (selection.trim()) {
          menu.addSeparator();
          menu.addItem((item) =>
            item
              .setTitle(t("menu.encrypt"))
              .setIcon("lock")
              .onClick(() => void this.guard(() => this.encryptSelection(editor, "fence"))),
          );
        }
        if (this.selectionHasEncrypted(editor.getSelection())) {
          menu.addItem((item) =>
            item
              .setTitle(t("cmd.decrypt.name"))
              .setIcon("unlock")
              .onClick(() => void this.guard(() => this.decryptSelection(editor, false))),
          );
          menu.addItem((item) =>
            item
              .setTitle(t("menu.decryptClipboard"))
              .setIcon("clipboard-copy")
              .onClick(() => void this.guard(() => this.decryptSelection(editor, true))),
          );
        }
      }),
    );

    // File menu: sealed note actions.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (!(file instanceof TFile)) return;
        const isSealed = this.notes.isSealedPath(file.path);

        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle(t("cmd.new.name"))
            .setIcon("lock")
            .onClick(() => void this.guard(() => this.newSealedNote())),
        );

        if (isSealed) {
          const unlocked = this.sessions.has(file.path);
          menu.addItem((item) =>
            item
              .setTitle(unlocked ? t("menu.lockNote") : t("prompt.enter"))
              .setIcon(unlocked ? "lock" : "unlock")
              .onClick(() => {
                if (unlocked) this.lockFile(file.path);
                else void this.guard(() => this.openFile(file));
              }),
          );
          menu.addItem((item) =>
            item
              .setTitle(t("menu.decryptWhole"))
              .setIcon("file-output")
              .onClick(() => void this.guard(() => this.decryptWholeFile(file))),
          );
        }
      }),
    );

    // Reading view context menu for rendered blocks.
    this.registerDomEvent(document, "contextmenu", (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".sealed-block, .sealed-pill")) return;
      // handled by the global app menu; nothing to do here beyond stopping
      // Obsidian from offering "copy" on ciphertext, which would be useless.
    });
  }

  private setupRibbon(): void {
    this.ribbonEl = this.addRibbonIcon(SEALED_ICON, "Sealed Note", (event) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle(t("cmd.new.name"))
          .setIcon("file-plus")
          .onClick(() => void this.guard(() => this.newSealedNote())),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("settings.lockAll"))
          .setIcon("lock")
          .onClick(() => {
            const count = this.unlockService.lockAll();
            this.refreshStatusBar();
            this.refreshActiveView();
            new Notice(count ? t("notice.lockedCount", { n: count }) : t("notice.noUnlocked"));
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("settings.configure"))
          .setIcon("settings")
          .onClick(() => {
            (this.app as any).setting?.open?.();
            (this.app as any).setting?.openTabById?.(this.manifest.id);
          }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private setupStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("sealed-status");
    this.statusBarEl.addEventListener("click", () => {
      const count = this.unlockService.lockAll();
      this.refreshStatusBar();
      this.refreshActiveView();
      new Notice(count ? `已锁定 ${count} 篇笔记` : t("status.clickLockAll"));
    });
    this.refreshStatusBar();
  }

  refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    const count = this.unlockService.unlockedCount();
    this.statusBarEl.empty();
    if (!this.vaultIdentifier || count === 0) {
      this.statusBarEl.setText(t("status.locked"));
      this.statusBarEl.setAttribute("aria-label", t("status.noneUnlocked2"));
    } else {
      this.statusBarEl.setText(`🔓 已解锁 ${count} 篇`);
      this.statusBarEl.setAttribute("aria-label", t("status.clickLockAll2"));
    }
  }

  private registerLockHooks(): void {
    // Switching notes locks the one you left, so coming back asks again.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const active = this.app.workspace.getActiveFile();
        const keep = active?.path ?? null;
        const locked = this.sessions.lockExcept(keep);
        if (locked.length) {
          this.refreshStatusBar();
          this.log.info("auto_locked", { count: locked.length });
        }
      }),
    );

    if (this.settingsData.lockOnBlur) {
      this.registerDomEvent(window, "blur", () => {
        this.unlockService.lockAll();
        this.refreshStatusBar();
        this.refreshActiveView();
      });
    }
  }

  private refreshActiveView(): void {
    const view = this.app.workspace.getActiveViewOfType(SealedNoteView);
    if (view && view.file) {
      // Re-render through a reload so the locked state is accurate.
      void view.onLoadFile(view.file);
    }
  }

  private lockFile(path: string): void {
    this.unlockService.lock(path);
    this.refreshStatusBar();
    const view = this.app.workspace.getActiveViewOfType(SealedNoteView);
    if (view && view.file?.path === path) void view.onLoadFile(view.file);
    new Notice(t("notice.locked"));
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */

  /** Wrap every action so a thrown error becomes a readable notice, never a crash. */
  private async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error && (error as any).name === "E_CANCELLED") return;
      this.log.error("action_failed", { error: String(error) });
      new Notice(describeError(error), 8000);
    }
  }

  async newSealedNote(): Promise<void> {
    const dek = await this.requireInitialised();
    if (!dek) return;

    // Match Obsidian's own "New note": create next to the active file, or at
    // the vault root when nothing is focused. No separate folder setting.
    const folder = this.currentNoteFolder();
    const stamp = new Date();
    const name = `${t("note.defaultName")} ${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(
      stamp.getDate(),
    ).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}`;
    const path = normalizePath(folder ? `${folder}/${name}` : name);

    const kr = this.pendingKeyring ?? (await this.unlockService.requireKeyring());
    const file = await this.notes.create({ vaultId: kr.vaultId, kid: kr.vaultId, keyring: kr }, dek, path, name);
    this.pendingKeyring = null;
    this.sessions.put(file.path, dek, "setup");
    await this.openFile(file);
    new Notice(t("notice.created"));
  }

  /**
   * Folder of the currently active note, if any. This mirrors Obsidian's
   * native new-note behaviour and removes a redundant setting.
   */
  private currentNoteFolder(): string {
    const active = this.app.workspace.getActiveFile();
    if (!active) return "";
    const slash = active.path.lastIndexOf("/");
    return slash < 0 ? "" : active.path.slice(0, slash);
  }

  private async openFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  /* ---------------- selection actions ---------------- */

  private selectionHasEncrypted(selection: string): boolean {
    return /```(encrypted_txt|txt_encrypted|sealed)/.test(selection) || /sn1\.[A-Za-z0-9+/=]{40,}/.test(selection);
  }

  async encryptSelection(editor: Editor, as: "fence" | "inline"): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.noSelection"));
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    if (this.notes.isSealedPath(file.path)) {
      new Notice(t("notice.alreadyEncrypted"));
      return;
    }

    const dek = await this.unlockService.dekFor(file.path, { subject: file.basename });
    if (!dek) return;

    const result = await this.encryption.encryptInline(dek, selection, as);
    editor.replaceSelection(result.snippet);
    new Notice(as === "fence" ? t("notice.encryptedFence") : t("notice.encryptedInline"));
    this.log.info("selection_encrypted", { path: file.path, as });
  }

  async decryptSelection(editor: Editor, toClipboard: boolean): Promise<void> {
    const selection = editor.getSelection();
    if (!selection.trim()) {
      new Notice(t("notice.noSelectionDecrypt"));
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const dek = await this.unlockService.dekFor(file.path, { subject: file.basename });
    if (!dek) return;

    // Whole fenced block selected? Strip the fence before decrypting.
    const fenced = /```(?:encrypted_txt|txt_encrypted|sealed)\s*\n([\s\S]*?)\n?```/.exec(selection);
    const payload = (fenced ? fenced[1] : selection).replace(/^`|`$/g, "").trim();

    const plain = await this.encryption.decryptInline(dek, payload);
    if (toClipboard) {
      await this.clipboard.copy(plain, { label: t("notice.decryptCopied") });
      this.log.info("selection_decrypted_to_clipboard", { path: file.path });
      return;
    }
    editor.replaceSelection(plain);
    new Notice(t("notice.decrypted"), 6000);
    this.log.info("selection_decrypted", { path: file.path });
  }

  /**
   * Turn a sealed note into a plain .md file, leaving the sealed original in
   * place. We create a new file rather than overwriting, because "decrypt in
   * place" is exactly the operation that destroys the guarantee the plugin
   * makes. The user can delete the original afterwards.
   */
  async decryptWholeFile(file: TFile): Promise<void> {
    if (!this.notes.isSealedPath(file.path)) {
      new Notice(t("notice.notSealed"));
      return;
    }

    if (this.settingsData.confirmWholeNoteDecrypt) {
      const ok = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          {
            title: t("menu.decryptWholeTitle"),
            body:
              t("notice.decryptConfirmBody"),
            confirmText: t("notice.decryptConfirmOk"),
            danger: true,
          },
          resolve,
        ).open();
      });
      if (!ok) return;
    }

    const dek = await this.unlockService.dekFor(file.path, { subject: file.basename });
    if (!dek) return;

    const kr = await this.unlockService.requireKeyring();
    const plaintext = await this.notes.readPlaintext(file, dek, kr.vaultId);
    const target = normalizePath(file.path.replace(/\.sealed\.md$/i, ".md").replace(/\.sealed$/i, ".md"));
    if (this.app.vault.getAbstractFileByPath(target)) {
      throw Err.io(`目标文件已存在：${target}`);
    }
    // The plaintext copy is created WITHOUT nesting inline decryption, so any
    // encrypted blocks inside stay encrypted.
    const created = await this.app.vault.create(target, plaintext);
    await this.openFile(created);
    new Notice(`已创建明文副本：${target}`, 8000);
    this.log.info("whole_note_decrypted", { source: file.path, target });
  }

  /* ---------------- recovery / totp ---------------- */

  /**
   * Bring every private note's embedded key copy up to date.
   *
   * Only the `keys` field changes - note contents are copied through byte for
   * byte. Idempotent: notes already current are skipped, so a re-run after an
   * interruption only handles what is left.
   */
  async refreshKeyCopies(): Promise<void> {
    const kr = await this.unlockService.requireKeyring();
    const result = await this.keyCopies.refreshAll(kr);

    const parts = [
      `${result.updated} 篇已更新`,
      `${result.current} 篇已是最新`,
    ];
    if (result.withoutCopy) parts.push(`${result.withoutCopy} 篇是旧格式、没有密钥副本`);
    if (result.failed) parts.push(`${result.failed} 篇失败`);
    new Notice(`密钥副本刷新完成：${parts.join("，")}。`, result.failed ? 12000 : 8000);

    if (result.failures.length) {
      this.log.warn("key_copy_refresh_partial", { failures: result.failures });
    }
  }

  /**
   * Rebuild the keyring from the key copy embedded in a note.
   *
   * This is the answer to "I excluded .obsidian from my sync tool and now every
   * private note is noise". Any note that carries a key copy can restore the
   * whole vault, because they all wrap the same data key.
   */
  async rebuildKeyringFromNote(): Promise<void> {
    if (await this.hasKeyring()) {
      const proceed = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          {
            title: t("notice.keyringExistsTitle"),
            body:
              t("notice.keyringExistsBody"),
            confirmText: t("notice.keyringExistsOk"),
            danger: true,
            typeToConfirm: "REBUILD",
          },
          resolve,
        ).open();
      });
      if (!proceed) return;
    }

    const candidates = await this.recovery.findCandidates();
    if (candidates.length === 0) {
      new Notice(
        t("notice.noCandidates"),
        10000,
      );
      return;
    }

    const picked = await new Promise<any | null>((resolve) => {
      new CandidatePickerModal(this.app, candidates, (c) => resolve(c)).open();
    });
    if (!picked) return;

    const secret = await new Promise<string | null>((resolve) => {
      new SecretPromptModal(
        this.app,
        t("prompt.recovery"),
        t("prompt.recoveryDesc"),
        resolve,
      ).open();
    });
    if (!secret) return;

    const result = await this.recovery.rebuild(picked, secret);

    if (await this.hasKeyring()) await this.keyringStore.backupCurrent();
    await this.keyringStore.save(result.keyring);
    await this.keyringStore.acknowledgeRollback(result.keyring);
    this.vaultIdentifier = result.vaultId;

    new Notice(
      `密钥库已从「${result.source}」重建（第 ${result.keyring.epoch} 代，匹配 ${result.slot} 槽）。现在可以打开所有笔记了。`,
      12000,
    );
    this.log.info("keyring_rebuilt", { source: result.source, slot: result.slot });
  }

  /**
   * Password change = two independent steps:
   *   1. update the keyring (atomic, instant, all notes use the new password)
   *   2. refresh key copies in encrypted notes (idempotent, resumable)
   *
   * Step 2 is NOT re-encryption: the `data` field is copied through unchanged.
   * If step 2 is interrupted, the notes still open with the new password via
   * the keyring, and re-running "refresh key copies" finishes the job.
   */
  async changePasswordAndRefresh(dek: Uint8Array, newPassword: string): Promise<void> {
    await this.unlockService.changePassword(dek, newPassword);
    const kr = await this.unlockService.requireKeyring();
    const result = await this.keyCopies.refreshAll(kr);

    new Notice(
      result.failed === 0
        ? `主密码已更新。${result.updated} 篇笔记的密钥副本已同步，笔记内容未重新加密。`
        : `主密码已更新，但 ${result.failed} 篇笔记的副本刷新失败。笔记仍可用新密码打开；请重跑「刷新所有加密笔记里的密钥副本」。`,
      result.failed ? 12000 : 9000,
    );
    this.refreshStatusBar();
  }

  async replaceRecoveryAndRefresh(dek: Uint8Array, newRecovery: string): Promise<void> {
    await this.unlockService.replaceRecovery(dek, newRecovery);
    const kr = await this.unlockService.requireKeyring();
    await this.keyCopies.refreshAll(kr);
  }

  async showRecoveryKey(): Promise<void> {
    const dek = await this.requireInitialised();
    if (!dek) return;
    const ok = await new Promise<boolean>((resolve) => {
      new ConfirmModal(
        this.app,
        {
          title: t("notice.recoveryRegenTitle"),
          body:
            t("notice.recoveryRegenBody"),
          confirmText: t("notice.recoveryRegenOk"),
          danger: true,
        },
        resolve,
      ).open();
    });
    if (!ok) return;

    const key = generateRecoveryKey();
    await this.unlockService.replaceRecovery(dek, key);
    const fingerprint = await keyFingerprint(dek);
    await new Promise<boolean>((resolve) => {
      new RecoveryKeyModal(this.app, key, fingerprint, this.app.vault.getName(), resolve).open();
    });
    new Notice(t("notice.recoveryDone"), 8000);
  }

  /** Restore the local seed cache from the phone's otpauth URI, no re-scan needed. */
  async restoreLocalTotpSeed(): Promise<void> {
    const uri = await new Promise<string | null>((resolve) => {
      new SeedImportModal(this.app, resolve).open();
    });
    if (!uri) return;
    try {
      await this.unlockService.restoreLocalSeed(uri);
      new Notice(t("seedImport.ok"), 10000);
    } catch (error) {
      new Notice(this.unlockService.describe(error), 12000);
      return;
    }
  }

  async setupTotp(): Promise<void> {
    const dek = await this.requireInitialised();
    if (!dek) return;
    const kr = await this.unlockService.requireKeyring();

    const mode = await new Promise<"password" | "totp" | "password+totp" | null>((resolve) => {
      new UnlockModeModal(this.app, resolve).open();
    });
    if (!mode) return;

    if (mode === "password") {
      await this.unlockService.configureMode(dek, mode, { password: undefined });
      new Notice(t("notice.modePassword"));
      return;
    }

    const password = mode === "password+totp"
      ? await new Promise<string | null>((resolve) => {
          new PasswordPromptModal(this.app, t("mode.confirmPw"), resolve).open();
        })
      : undefined;
    if (mode === "password+totp" && !password) return;

    const account = this.app.vault.getName();
    const result = await new Promise<{ seed: string; otpauth: string } | null>((resolve) => {
      new TotpSetupModal(this.app, account, resolve).open();
    });
    if (!result) return;

    await this.unlockService.configureMode(dek, mode, { password: password ?? undefined, seed: result.seed });
    await this.keyCopies.refreshAll(await this.unlockService.requireKeyring());
    new Notice(
      t("notice.totpDone"),
      12000,
    );
    this.log.info("unlock_mode_configured", { mode });
  }

}