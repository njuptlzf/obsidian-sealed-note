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
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";

import { DEFAULT_SETTINGS, SealedNoteSettings, normalizeSettings } from "./settings";
import type { LockPolicy } from "./settings";
import { setLanguage, t } from "./i18n";
import { SealedNoteSettingTab } from "./ui/settings";
import { NoteKeyringStore } from "./storage/note-keyring-store";
import { SealedNoteStore } from "./storage/sealed-note-store";
import { SessionStore } from "./core/session";
import { UnlockService } from "./services/unlock-service";
import { EncryptionService } from "./services/encryption-service";
import { ClipboardService } from "./services/clipboard";
import { ConfirmModal, RecoveryKeyModal, SetupModal, UnlockModal } from "./ui/modals";
import { registerEncryptedCodeBlocks } from "./inline/codeblock";
import { registerInlinePayloads } from "./inline/postprocessor";
import { registerLockedMarker } from "./notes/locked-marker";
import { applyExplorerBadges } from "./notes/explorer-badges";
import { ciphertextGuard, openCiphertextSyncWindow, setCiphertextGuardUnlockHandler } from "./editor/ciphertext-guard";
import { generateRecoveryKey } from "./core/recovery";
import { createKeyring, createKeyringWithoutPassword, formatKeyringFromCopy, keyFingerprint, newVaultId, SLOT_PASSWORD, SLOT_TOTP, SLOT_PASSWORD_TOTP, SLOT_RECOVERY, KeyringData, setSlot } from "./core/keyring";
import { describeError, Err, SealedNoteError } from "./util/errors";
import { log, setLogLevel } from "./util/log";
import { findUnsealedBlocks } from "./core/format";
import { TotpSetupModal } from "./ui/totp-modal";
import { CandidatePickerModal, SecretPromptModal } from "./ui/recovery-modals";
import { UnlockModeModal, PasswordPromptModal } from "./ui/mode-modals";
import { sealWithDevice } from "./core/device";
import { SeedImportModal } from "./ui/seed-import-modal";
import { VaultRecoveryService } from "./services/vault-recovery";
import type { RecoveryCandidate } from "./services/vault-recovery";
import { KeyCopyRefreshService } from "./services/key-copy-refresh";
import { NameModal } from "./ui/name-modal";
import { BusyOverlay } from "./ui/busy";
import type {
  SettingApp, ViewWithFile, EditorLike, MarkdownViewLike, SplitNode, WorkspaceInternals, CodedError,
} from "./util/internal-types";

const SEALED_ICON = "lock";

// Ambient binding (emits no JS): Obsidian defines it; the Node test harness
// only installs the plain `document` global.
declare const activeDocument: Document | undefined;
declare const document: Document;

/** Document of the focused window, falling back to the headless test global. */
function hostDocument(): Document {
  return typeof activeDocument !== "undefined" ? activeDocument : document;
}

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
  /** note being created + opened by newSealedNote; file-open hook must skip it */
  private creatingNotePath: string | null = null;
  private statusBarEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;

  /**
   * In-place editing model. A note is "unlocked" exactly while its body holds
   * plaintext (sessions) - no working-copy files exist anywhere, so nothing
   * outside the unlock flow can read plaintext without a password. Any focus
   * loss (tab switch, window blur, plugin unload) re-seals immediately.
   */
  private readonly savingNotes = new Set<string>();
  /** notes whose unlock is in progress; prevents double prompts */
  private readonly unlockingNotes = new Set<string>();
  /** note paths whose body we just rewrote; ignore the resulting modify event */
  private readonly selfWrites = new Set<string>();
  /**
   * path -> the leaf that was showing it at unlock time. The "close" policy
   * locks a note exactly when THIS leaf is destroyed (tab closed). A leaf that
   * survives but shows another file means the note was switched away from,
   * which the close policy deliberately does not lock.
   */
  private readonly unlockedLeaves = new Map<string, WorkspaceLeaf>();
  /** per-note autosave timers */
  private readonly saveTimers = new Map<string, number>();
  /**
   * Plain notes containing unsealed plaintext fences (a hand-typed
   * ```encrypted_txt block whose body is not sn1.*). The entry is the trail:
   * status bar shows it, every leaving point (blur/close per the SAME
   * lockPolicy as private notes) attempts the seal, and a cancelled dialog
   * keeps the entry so the next visit nags again. Nothing is ever deleted.
   */
  private readonly unsealedNotes = new Set<string>();
  /** trail paths whose Notice has already been shown (status bar keeps nagging) */
  private readonly warnedUnsealed = new Set<string>();
  /** path -> leaf showing it, for the "close" policy's tab-close sweep */
  private readonly unsealedLeaves = new Map<string, WorkspaceLeaf>();
  /** anti-reentrancy: the unlock dialog itself fires blur/leaf events */
  private readonly sealingNotes = new Set<string>();
  /** top level progress pill; one at a time, whoever owns busyPath controls it */
  private readonly busy = new BusyOverlay();
  private busyPath: string | null = null;

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
    // Locked notes can have any filename, so build the registry from note
    // bodies before any hook asks isSealedPath(). Awaiting here keeps the
    // startup state deterministic; content remains the source of truth.
    await this.notes.refreshVaultPaths();
    // Old builds kept plaintext working copies in a visible folder; wipe the
    // leftovers and warn about notes still revealed from a crash.
    void this.guard(() => this.recoverAfterCrash());
    this.keyringStore = new NoteKeyringStore(this.app, this.notes);
    this.sessions = new SessionStore();
    this.encryption = new EncryptionService(() => this.vaultId());
    this.clipboard = new ClipboardService();
    this.recovery = new VaultRecoveryService(this.app, this.notes);
    this.keyCopies = new KeyCopyRefreshService(this.app, this.notes);

    this.unlockService = new UnlockService(this.keyringStore, this.sessions);
    // A DEK cache for a plain note (reading-view block/pill decrypt) must know
    // which leaf showed it, or the close-policy sweep cannot see the tab close
    // and the cache outlives its note (reopened note reveals without a prompt).
    this.unlockService.onSessionCached = (path) => this.rememberLeafFor(path);
    this.unlockService.setUi(() => ({
      prompt: (request) =>
        new Promise((resolve) => {
          // The dialog itself is the feedback from here on; leave no spinner
          // sitting behind it.
          this.busy.hide();
          new UnlockModal(this.app, request, resolve, async () => {
            const kr = await this.unlockService.keyring();
            return kr ? this.unlockService.hasLocalSeed(kr) : false;
          }).open();
        }),
      busy: (state, label) => {
        if (state === "verifying") this.busy.show(label ?? t("busy.verifying"));
        else this.busy.hide();
      },
    }));

    // Existing keyring decides the vault id; otherwise the id is minted on first setup.
    const existing = await this.keyringStore.load().catch((error) => {
      this.log.error("keyring_load_failed", { error: String(error) });
      new Notice(describeError(error), 10000);
      return null;
    });
    if (existing) this.vaultIdentifier = existing.vaultId;

    // Locked notes are ordinary Markdown files whose body holds the envelope.
    // There is no custom view: opening one shows the ciphertext in the native
    // editor and the user starts an unlock explicitly (menu / reading-view
    // marker). This keeps Obsidian's own navigation, history and sync intact.

    registerEncryptedCodeBlocks(this);
    registerInlinePayloads(this);
    registerLockedMarker(this);
    // Content-based ciphertext guard: while the buffer holds an envelope the
    // editor refuses user edits (typing/paste/drop), so a stray keystroke
    // cannot corrupt it. Works for any filename, unlike the old view routing.
    setCiphertextGuardUnlockHandler(() => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.guard(() => this.unlockNote(file));
    });
    this.registerEditorExtension(ciphertextGuard());

    this.addSettingTab(new SealedNoteSettingTab(this.app, this));
    this.setupRibbon();
    this.setupStatusBar();
    this.registerCommands();
    this.registerMenus();
    this.registerLockHooks();
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) =>
        void this.guard(async () => this.onNoteDeleted(file)),
      ),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) =>
        void this.guard(async () => this.onNoteRenamed(file, oldPath)),
      ),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (this.selfWrites.has(file.path)) return; // our own re-seal write
        // Only private notes have a plaintext body to flush into a payload.
        // A plain note may hold a DEK *cache* session (inline-block unlock),
        // and treating that body as a revealed note would seal the whole
        // note through the legacy-migration path - destroying the user's
        // file. Plain notes never go through flushNote, period.
        if (this.notes.isSealedPath(file.path)) {
          if (this.isUnlocked(file.path)) this.scheduleFlush(file.path);
          return;
        }
        // A modify on an unknown path may be a synced-in or renamed envelope:
        // content decides. Healing here restores badges and menus without
        // waiting for the user to press unlock.
        void this.guard(async () => {
          if (await this.notes.healIdentity(file)) {
            this.refreshExplorerBadges();
            return;
          }
          await this.trackUnsealed(file.path);
        });
      }),
    );

    this.log.info("loaded", { vault: this.app.vault.getName() });
  }

  onunload(): void {
    this.busy.hide();
    // Best-effort: flush every unlocked note back into its payload so no
    // plaintext body survives in the file. Without a DEK we must NOT encrypt
    // (that would corrupt the payload) - the boot scan handles those notes.
    // Non-sealed paths in the session map are only DEK caches for inline
    // blocks - they hold no plaintext body and must never go through the
    // document re-seal (that would overwrite a normal note with a placeholder).
    for (const path of this.sessions.unlockedPaths()) {
      if (!this.notes.isSealedPath(path)) continue;
      const dek = this.sessions.get(path)?.dek ?? null;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (dek && file instanceof TFile) {
        const vaultId = this.vaultIdentifier;
        void this.notes.reSealNote(file, dek, vaultId, vaultId).catch(() => undefined);
      }
    }
    // Plain notes on the unsealed-block trail: seal silently on the way out,
    // cached DEK only. A dialog during unload would strand the app. Whatever
    // is left stays visible plaintext (status bar flagged it); never deleted.
    for (const path of this.unsealedNotes) {
      void this.sealPlainNote(path, { interactive: false }).catch(() => undefined);
    }
    this.sessions?.lockAll();
    this.log.info("unloaded", {});
  }

  /**
   * After a crash (or an old-version install) some note bodies may still hold
   * plaintext, and the legacy `sealed-note-work/` folder may hold copies.
   * Re-seal what we can, delete the legacy folder, and tell the user about
   * notes that need a credential to close safely.
   */
  private async recoverAfterCrash(): Promise<void> {
    // 1. Legacy working-copy folder from the previous architecture.
    try {
      const listed = await this.app.vault.adapter.list("sealed-note-work");
      for (const path of listed.files ?? []) {
        await this.app.vault.adapter.remove(path).catch(() => undefined);
      }
      if ((listed.files ?? []).length || (listed.folders ?? []).length) {
        await this.app.vault.adapter.rmdir("sealed-note-work", false).catch(() => undefined);
        this.log.info("legacy_work_dir_removed");
      }
    } catch {
      /* folder absent - nothing to do */
    }

    // 2. Notes still revealed on disk (crash while unlocked).
    const revealed: string[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.notes.isSealedPath(file.path)) continue;
      const raw = await this.app.vault.cachedRead(file).catch(() => "");
      if (raw && this.notes.isRevealedText(raw)) revealed.push(file.path);
    }
    if (revealed.length) {
      this.log.warn("plaintext_notes_recovered", { count: revealed.length });
      new Notice(
        t("notice.plaintextRecovered", { n: revealed.length }),
        10000,
      );
      // No flag to set: their ciphertext is intact, so opening asks for the
      // credential and the first save re-seals. Just make it visible.
    }
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

  /** `app.setting` is internal; a missing or changed shape degrades to a no-op. */
  private get settingApp(): SettingApp | null {
    return (this.app as unknown as { setting?: SettingApp }).setting ?? null;
  }

  /** Open the settings pane on this plugin's tab (internal API, best effort). */
  private openSettingsTab(): void {
    const setting = this.settingApp;
    if (!setting) return;
    setting.open();
    setting.openTabById?.(this.manifest.id);
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
    this.refreshStatusBar();
  }

  /** Which event re-locks an unlocked note. */
  private lockPolicy(): LockPolicy {
    return this.settingsData.lockPolicy;
  }

  vaultId(): string {
    return this.vaultIdentifier;
  }

  /* ------------------------------------------------------------------ */
  /* keyring access                                                      */
  /* ------------------------------------------------------------------ */

  async hasKeyring(): Promise<boolean> {
    // A newly created note is revealed (no envelope on disk) until its first
    // lock, so a live in-memory keyring also counts as initialized.
    return (await this.keyringStore.exists()) || this.unlockService.hasKeyringLoaded();
  }

  /**
   * Settings entry point for first-run setup. Reuses the same wizard as the
   * ribbon/command path so a keyring is never minted without a note to hold
   * its key copy.
   */
  async setupFromSettings(): Promise<void> {
    await this.runSetup();
    this.refreshStatusBar();
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
    let passwordHint: string | undefined;
    if (mode !== "totp") {
      const credentials = await new Promise<{ password: string; hint: string } | null>((resolve) => {
        new SetupModal(this.app, resolve).open();
      });
      if (!credentials) return null;
      password = credentials.password;
      passwordHint = credentials.hint || undefined;
    }

    const recoveryKey = generateRecoveryKey();
    const vaultId = newVaultId();
    // Combined mode deliberately does NOT get a standalone password slot.
    // createKeyring() wraps the DEK under the password alone; using it here
    // would leave a "主密码" tab in the dialog that opens the vault without
    // the second factor, which contradicts "两把钥匙缺一不可". The combined
    // slot below is the only password-shaped door.
    const withStandalonePassword = mode === "password";
    const { keyring, dek } = withStandalonePassword
      ? await createKeyring(vaultId, password!, recoveryKey, { hint: passwordHint })
      : await createKeyringWithoutPassword(vaultId, recoveryKey, { hint: passwordHint });
    this.vaultIdentifier = vaultId;
    this.unlockService.rememberKeyring(keyring);

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
      callback: () => void this.guard(async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        if (this.notes.isSealedPath(file.path) && this.isUnlocked(file.path)) {
          await this.lockNote(file.path);
          return;
        }
        this.lockFile(file.path);
      }),
    });

    this.addCommand({
      id: "lock-all",
      name: t("cmd.lockAll.name"),
      callback: () => void this.guard(async () => {
        const count = await this.lockAllNotes();
        this.refreshStatusBar();
        this.refreshActiveView();
        new Notice(count > 0 ? t("notice.lockedCount", { n: count }) : t("notice.noUnlocked"));
      }),
    });

    this.addCommand({
      id: "lock-document",
      name: t("cmd.lockDocument.name"),
      callback: () => void this.guard(() => this.lockDocument(this.app.workspace.getActiveFile())),
    });

    this.addCommand({
      id: "demote-note",
      name: t("cmd.demote.name"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.notes.isSealedPath(file.path)) return false;
        if (!checking) void this.guard(() => this.demoteToPlain(file));
        return true;
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
        this.openSettingsTab();
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
        const file = this.app.workspace.getActiveFile();
        menu.addSeparator();
        // Always available in source mode, for both sealed and plain notes.
        if (file) {
          menu.addItem((item) =>
            item
              .setTitle(t("cmd.decrypt.document.name"))
              .setIcon("file-output")
              .onClick(() => void this.guard(() => this.decryptDocument(file))),
          );
        }
        const selection = editor.getSelection();
        if (selection.trim()) {
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

    // File menu: fires for both files and folders. A folder gets "new note"
    // only (created inside it); a file gets the full set of actions.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addSeparator();
          menu.addItem((item) =>
            item
              .setTitle(t("cmd.new.name"))
              .setIcon("lock")
              .onClick(() => void this.guard(() => this.newSealedNote(file.path))),
          );
          return;
        }
        if (!(file instanceof TFile)) return;
        const isSealed = this.notes.isSealedPath(file.path);

        // Like Obsidian's own "New note": the create action lives on folders,
        // not on files, so a file right-click only offers decryption actions.
        // "Decrypt document" works on sealed notes and plain notes alike.
          menu.addSeparator();
          if (!isSealed && file.extension === "md") {
            menu.addItem((item) =>
              item
                .setTitle(t("cmd.lockDocument.name"))
                .setIcon("lock")
                .onClick(() => void this.guard(() => this.lockDocument(file))),
            );
          }
          menu.addItem((item) =>
            item
              .setTitle(t("cmd.decrypt.document.name"))
              .setIcon("file-output")
              .onClick(() => void this.guard(() => this.decryptDocument(file))),
          );

          if (isSealed) {
          const unlocked = this.isUnlocked(file.path);
          menu.addItem((item) =>
            item
              .setTitle(unlocked ? t("menu.lockNote") : t("prompt.enter"))
              .setIcon(unlocked ? "lock" : "unlock")
              .onClick(() => {
                if (unlocked) void this.guard(() => this.lockNote(file.path));
                else void this.guard(() => this.unlockNote(file));
              }),
          );
          menu.addItem((item) =>
            item
              .setTitle(t("cmd.demote.name"))
              .setIcon("file-minus")
              .onClick(() => void this.guard(() => this.demoteToPlain(file))),
          );
        }
      }),
    );

    // Reading view context menu for rendered blocks.
    this.registerDomEvent(hostDocument(), "contextmenu", (event) => {
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
          .onClick(() => void this.guard(async () => {
            const count = await this.lockAllNotes();
            this.refreshStatusBar();
            this.refreshActiveView();
            new Notice(count ? t("notice.lockedCount", { n: count }) : t("notice.noUnlocked"));
          })),
      );
      menu.addItem((item) =>
        item
          .setTitle(t("settings.configure"))
          .setIcon("settings")
          .onClick(() => {
            this.openSettingsTab();
          }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private setupStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("sealed-status");
    this.statusBarEl.addEventListener("click", () => void this.guard(async () => {
      const count = await this.lockAllNotes();
      this.refreshStatusBar();
      this.refreshActiveView();
      new Notice(count ? t("notice.lockedN", { n: count }) : t("status.clickLockAll"));
    }));
    this.refreshStatusBar();
  }

  refreshStatusBar(): void {
    if (!this.statusBarEl) return;
    // Every state change that reaches the status bar also changes badges.
    this.refreshExplorerBadges();
    const count = this.unlockService.unlockedCount();
    this.statusBarEl.empty();
    if (this.unsealedNotes.size > 0) {
      // Warning trail: a plaintext ```encrypted_txt block exists somewhere
      // and its seal was skipped, cancelled, or not attempted yet.
      this.statusBarEl.setText(`⚠️ ${t("status.unsealed", { n: this.unsealedNotes.size })}`);
      this.statusBarEl.setAttribute("aria-label", t("status.unsealedHint"));
      this.statusBarEl.addClass("sealed-status-warn");
      return;
    }
    this.statusBarEl.removeClass("sealed-status-warn");
    if (!this.vaultIdentifier || count === 0) {
      this.statusBarEl.setText(t("status.locked"));
      this.statusBarEl.setAttribute("aria-label", t("status.noneUnlocked2"));
    } else {
      this.statusBarEl.setText(t("status.unlockedN", { n: count }));
      this.statusBarEl.setAttribute("aria-label", t("status.clickLockAll2"));
    }
  }

  /**
   * File-explorer badges: a 🔒 prefix on every vault note, so a locked note
   * is recognisable before opening it. The explorer is a virtual list - it
   * re-renders rows on scroll/expand and wipes our spans - so the first
   * pass also installs a debounced MutationObserver on each explorer root
   * that re-applies whenever its DOM changes. The registry, not the badge,
   * is the truth; a missing or restructured explorer must never break the
   * plugin, hence the whole thing is decoration-only.
   */
  refreshExplorerBadges(): void {
    try {
      const leaves = this.app.workspace.getLeavesOfType?.("file-explorer") ?? [];
      const sealed = new Set(this.notes.vaultNotePaths());
      for (const leaf of leaves) {
        const root = (leaf.view as unknown as { contentEl?: HTMLElement }).contentEl;
        if (!root || typeof root.find !== "function") continue;
        applyExplorerBadges(root, sealed);
        this.observeExplorer(root);
      }
    } catch {
      // decoration only - never fail an operation over a badge
    }
  }

  /** One observer per explorer root; re-created if the view was rebuilt. */
  private explorerObservers = new WeakMap<object, MutationObserver>();

  private observeExplorer(root: HTMLElement): void {
    if (this.explorerObservers.has(root)) return;
    if (typeof MutationObserver === "undefined") return;
    let timer: number | null = null;
    const observer = new MutationObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        try {
          applyExplorerBadges(root, new Set(this.notes.vaultNotePaths()));
        } catch {
          /* decoration only */
        }
      }, 60);
    });
    observer.observe(root, { childList: true, subtree: true });
    this.explorerObservers.set(root, observer);
    this.register(() => observer.disconnect());
  }

  private registerLockHooks(): void {
    // Leaving a note: every unlocked note other than the file now on screen
    // gets re-sealed - but ONLY at the strictest level. "close" deliberately
    // keeps notes unlocked while you switch around; it locks on tab close
    // (see sweepClosedNoteTabs). All tabs closed (null) counts as leaving too.
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        // Seal and lock MUST run in ONE serialized guard: both are async, and
        // two independent fire-and-forget guards race - the lock loop can drop
        // the cached DEK before sealing ever reads it (the user would get a
        // surprise password prompt at every tab switch).
        void this.guard(async () => {
          if (this.shouldSealOnLeave()) {
            await this.sealLeftNotes(file?.path ?? null);
          }
          if (this.lockPolicy() === "blur") {
            for (const path of this.sessions.unlockedPaths()) {
              if (file && path === file.path) continue;
              await this.lockNote(path);
            }
          }
        });
        if (!file) return;
        if (!this.notes.isSealedPath(file.path)) {
          // Opening a note whose body is an envelope but whose identity was
          // lost (external rename, missed event): heal before deciding it is
          // a plain note, so the editor, badges and menus all agree.
          void this.guard(async () => {
            if (await this.notes.healIdentity(file)) {
              this.refreshExplorerBadges();
              return;
            }
            await this.trackUnsealed(file.path);
          });
          return;
        }
        // A workspace-restored tab can point at a note deleted while closed.
        if (!this.app.vault.getAbstractFileByPath(file.path)) {
          this.sessions.lock(file.path);
          return;
        }
        // The safety net for every leak path (crash, quit-before-async-write,
        // a note renamed off .sealed.md): a vault note whose body is still
        // plaintext must never be readable as plaintext again. Re-seal it
        // before the user sees a word, which needs the credential.
        void this.guard(() => this.sealRevealedOnOpen(file));
      }),
    );

    // Tab/leaf switches still fire active-leaf-change, and some of them do NOT
    // fire file-open (moving focus between leaves showing the same file, side
    // panes taking focus). The same blur-level loop runs here as a backstop;
    // lockNote is idempotent, so the overlap with file-open is harmless.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const active = this.app.workspace.getActiveFile();
        // A null active file is a transient state (modal closing, tab swap,
        // layout restore). Locking here would close the editor the instant it
        // opens; the file-open event owns the real transitions.
        if (!active) return;
        // Same serialization as file-open: seal before the lock loop drops
        // the cached DEK. (See the file-open hook for the race details.)
        void this.guard(async () => {
          if (this.shouldSealOnLeave()) {
            await this.sealLeftNotes(active.path);
          }
          if (this.lockPolicy() === "blur") {
            for (const path of this.sessions.unlockedPaths()) {
              if (path === active.path) continue;
              await this.lockNote(path);
            }
          }
        });
        // Switched ONTO a plain note with a stale trail (sealed elsewhere or
        // the file was fixed): recompute so the status bar stops nagging.
        if (!this.notes.isSealedPath(active.path)) {
          void this.guard(() => this.trackUnsealed(active.path));
        }
        this.sweepClosedNoteTabs();
        this.sweepUnsealedClosedTabs();
      }),
    );

    // Closing a tab destroys its leaf; switching to another note in the same
    // leaf does not. That is the only way to tell "the note was closed" from
    // "the note was switched away from", and the "close" policy locks exactly
    // on the former: a note you merely navigated past stays unlocked (its
    // plaintext stays in the body until its own tab closes).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.sweepClosedNoteTabs();
        this.sweepUnsealedClosedTabs();
        void this.guard(() => this.sealReadingView());
        this.refreshExplorerBadges();
      }),
    );

    // Window blur = focus loss = lock everything. Only the strictest policy
    // treats "another window" as a reason to drop the key: the whole point of
    // the lower levels is to stop asking the moment you look away.
    this.registerDomEvent(window, "blur", () => {
      if (this.lockPolicy() !== "blur") return;
      void this.guard(async () => {
        // Seal blocks BEFORE locking: the seal runs on the cached DEK.
        await this.sealLeftNotes(null);
        await this.lockAllNotes();
        this.refreshStatusBar();
        this.refreshActiveView();
      });
    });

    // Obsidian's settings pane is not a leaf, so no leaf-change event fires for
    // it. Patch its opener so "switch to the settings page" counts as leaving
    // the note at the strictest level.
    this.hookSettingsOpen();
    this.app.workspace.onLayoutReady?.(() => this.hookSettingsOpen());
  }

  /**
   * Lock everything when Obsidian's settings pane opens.
   *
   * There is no public event for it, and it is not a workspace leaf, so the
   * only place to hook is `app.setting.open`. Internal API: a missing or
   * changed shape must never break loading, hence the try/catch and the flag.
   */
  private hookSettingsOpen(): void {
    try {
      const setting = this.settingApp;
      if (!setting || typeof setting.open !== "function" || setting.__sealedNotePatched) return;
      const open = setting.open.bind(setting);
      setting.open = (...args: unknown[]) => {
        if (this.lockPolicy() === "blur") {
          void this.guard(async () => {
            await this.sealLeftNotes(null);
            await this.lockAllNotes();
            this.refreshStatusBar();
          });
        }
        return open(...args);
      };
      setting.__sealedNotePatched = true;
    } catch (error) {
      this.log.warn("settings_hook_failed", { error: String(error) });
    }
  }

  private refreshActiveView(): void {
    // There is no custom view to repaint. The reading-view marker is refreshed
    // by Obsidian's own re-render when the note body is rewritten on lock.
  }

  /**
   * Remember which leaf is showing a note right after it was unlocked.
   *
   * The "close" policy needs to tell "its tab was closed" (leaf destroyed)
   * from "it was switched away in the same leaf" (leaf alive, showing another
   * file). The recorded leaf is what makes that distinction.
   */
  private rememberLeafFor(path: string): void {
    const leaves: WorkspaceLeaf[] = [
      ...(this.app.workspace.getLeavesOfType?.("markdown") ?? []),
    ];
    for (const leaf of leaves) {
      if (this.viewPath(leaf) === path) {
        this.unlockedLeaves.set(path, leaf);
        return;
      }
    }
    // Not found (unexpected right after showAsMarkdown): no reliable leaf to
    // watch, so the sweep will not guess - the blur/unload paths still lock it.
    this.unlockedLeaves.delete(path);
  }

  /**
   * The "close" policy locks a note exactly when the tab that was showing it
   * is destroyed. A leaf that survives but shows another file means the note
   * was switched away from, which stays unlocked by design - that is the whole
   * difference from "blur".
   */
  private sweepClosedNoteTabs(): void {
    if (this.lockPolicy() !== "close") return;
    if (!this.app.workspace.iterateAllLeaves) return; // unknown API: do not guess
    for (const path of this.sessions.unlockedPaths()) {
      if (this.anyLeafShows(path)) continue; // its tab is still open somewhere
      if (this.unsealedNotes.has(path)) continue; // plaintext blocks: the seal
      // sweep owns this path's end-of-life (seal first, then drop the cache),
      // locking here first would strand the seal without its cached key.
      const leaf = this.unlockedLeaves.get(path);
      if (!leaf) continue; // no reliable leaf: do not guess, other hooks still lock
      if (this.leafAlive(leaf)) continue; // switched away, not closed
      this.unlockedLeaves.delete(path);
      void this.guard(() => this.lockNote(path));
    }
  }

  private anyLeafShows(path: string): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      if (this.viewPath(leaf) === path) found = true;
    });
    return found;
  }

  private leafAlive(leaf: WorkspaceLeaf): boolean {
    let alive = false;
    this.app.workspace.iterateAllLeaves((candidate: WorkspaceLeaf) => {
      if (candidate === leaf) alive = true;
    });
    return alive;
  }

  private lockFile(path: string): void {
    this.unlockService.lock(path);
    this.refreshStatusBar();
    new Notice(t("notice.locked"));
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */

  /** Wrap every action so a thrown error becomes a readable notice, never a crash. */
  async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      // SealedNoteError carries its stable identifier in `code`; `name` is
      // always "SealedNoteError", so checking `name` never matched a cancel.
      if (error instanceof SealedNoteError && error.code === "E_CANCELLED") return;
      this.log.error("action_failed", { error: String(error), stack: error instanceof Error ? error.stack : undefined });
      new Notice(describeError(error), 8000);
    }
  }

  async newSealedNote(folderOverride?: string, givenName?: string): Promise<void> {
    // Ask for a name first (skip when supplied by a test/caller). The plugin
    // adds .sealed.md itself; the user just types "Daily" etc.
    const stamp = new Date();
    const defaultName = t("note.untitled", {
      n: `${stamp.getHours()}${String(stamp.getMinutes()).padStart(2, "0")}`,
    });
    const name = givenName ?? (await new Promise<string | null>((resolve) => {
      new NameModal(
        this.app,
        t("note.nameTitle"),
        t("note.nameLabel"),
        defaultName,
        t("note.nameHint"),
        resolve,
      ).open();
    }));
    if (!name) return;
    // Normalize whatever the user typed: strip any .sealed[.md] / .md they
    // included - we always append exactly one canonical .sealed.md ourselves.
    const cleanName = name.replace(/\.sealed\.md$/i, "").replace(/\.sealed$/i, "").replace(/\.md$/i, "");

    // Creating a NEW note needs the real DEK up front.
    //
    // The alternative - create with a throwaway key and ask on the first save -
    // meant a window where the note existed but was not encrypted. Every bug
    // that window produced (text parked in a draft when the user cancelled, a
    // stale throwaway envelope that could never be decrypted, crash recovery for
    // bodies left revealed) came from it. Asking before the file exists deletes
    // the whole state machine: cancelling leaves nothing behind.
    let kr: KeyringData;
    let dek: Uint8Array | null = null;
    let providerId = "create";
    if (!(await this.hasKeyring())) {
      // First run: the wizard mints the keyring and hands back its DEK.
      dek = await this.runSetup();
      if (!dek) return;
      kr = this.pendingKeyring!;
      providerId = "setup";
      } else {
        kr = await this.unlockService.requireKeyring();
        this.vaultIdentifier = kr.vaultId;
        this.unlockService.rememberKeyring(kr);
        // Reuse a DEK already in memory: same vault, same key.
      for (const open of this.sessions.unlockedPaths()) {
        const entry = this.sessions.get(open);
        if (entry) {
          dek = entry.dek;
          providerId = entry.providerId;
          break;
        }
      }
    }

    // Match Obsidian's own "New note": create next to the active file, at the
    // vault root when nothing is focused, or in the folder that was right-
    // clicked. No separate folder setting.
    const folder = folderOverride ?? this.currentNoteFolder();
    const path = normalizePath(folder ? `${folder}/${cleanName}` : cleanName);
    const targetPath = this.notes.withExtension(path);

    if (!dek) {
      this.claimBusy(targetPath, t("busy.encrypting"));
      try {
        dek = await this.unlockService.dekFor(targetPath, { subject: name, verb: "encrypt" });
      } finally {
        this.releaseBusy(targetPath);
      }
      if (!dek) {
        // Cancelled: no note, no empty file, nothing to clean up later.
        new Notice(t("notice.createCancelled"), 6000);
        this.log.info("note_create_cancelled");
        return;
      }
    }

    this.creatingNotePath = targetPath;
    try {
      const file = await this.notes.create(
        { vaultId: kr.vaultId, kid: kr.vaultId, keyring: kr },
        dek,
        path,
        name,
      );
      this.pendingKeyring = null;
      this.sessions.put(file.path, dek, providerId);
      // Reveal the (empty) body in place and open the native editor, exactly
      // like Obsidian's own "new note". No working copy, no second prompt.
      await this.revealBlank(file);
      await this.showAsMarkdown(file.path);
      this.rememberLeafFor(file.path);
      // The tab switch fires active-leaf-change; make sure the create itself
      // is not treated as "left the note".
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      this.refreshStatusBar();
    } finally {
      this.creatingNotePath = null;
    }
    new Notice(t("notice.created"));
  }

  /** Write an empty revealed body for a brand-new note. */
  private async revealBlank(file: TFile): Promise<void> {
    // "Blank" describes the expected state, it is not a licence to clear the
    // body. Only called right after create() now, so this can never fire - kept
    // as a guard because writing "" over a body that holds text is the one
    // mistake this file must never make.
    const existing = await this.notes.readRevealedBody(file).catch(() => "");
    if (existing) {
      this.log.warn("reveal_blank_on_nonempty_body", { note: file.path, chars: existing.length });
      return;
    }
    await this.markSelfWrite(file.path, () => this.app.vault.modify(file, ""));
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

  /**
   * Whether a leaf lives in the main editor area rather than a side dock.
   *
   * Do NOT use leaf.getRoot()/getContainer(): both return the TOP-LEVEL
   * container (WorkspaceRoot / WorkspaceWindow), which is the SAME object for
   * a sidebar leaf - so `=== rootSplit` is always true and the check never
   * filters anything. leaf.isSideLeaf() is not an API either. The reliable
   * test is walking `parent` up to the split containers.
   */
  private isMainAreaLeaf(leaf: unknown): boolean {
    try {
      const ws = this.app.workspace as unknown as WorkspaceInternals;
      let node: SplitNode | null | undefined = leaf as SplitNode;
      let guard = 0;
      while (node && guard++ < 64) {
        if (node === ws.leftSplit || node === ws.rightSplit) return false;
        if (ws.rootSplit && node === ws.rootSplit) return true;
        node = node.parent;
      }
      // Unknown tree (typically the test stub): assume main area so calls that
      // open a tab still succeed rather than silently doing nothing.
      return true;
    } catch {
      return true;
    }
  }

  /** Inverse of isMainAreaLeaf; kept for call sites that skip side panes. */
  private isSideLeaf(leaf: unknown): boolean {
    return !this.isMainAreaLeaf(leaf);
  }

  /** Path shown by a leaf's view, if it has a file (decoration-only helper). */
  private viewPath(leaf: WorkspaceLeaf): string | undefined {
    const view = leaf.view as unknown as ViewWithFile | null;
    return view?.file?.path ?? undefined;
  }

  /** Reveal a leaf through the public API; no-op if the host does not support it. */
  private async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const reveal = (this.app.workspace as unknown as { revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> }).revealLeaf;
    if (reveal) await reveal.call(this.app.workspace, leaf);
  }

  /* ---------------- in-place unlock / lock ------------------------------- */

  /** A note is unlocked exactly while its DEK is in the session store. */
  isUnlocked(path: string): boolean {
    return !!this.sessions.get(path);
  }

  /**
   * Unlock a sealed note IN PLACE: decrypt the payload into the note's own
   * body and switch its tab to the native Markdown editor. No working-copy
   * file exists anywhere - plaintext lives in the note only while unlocked,
   * and every focus-loss path re-seals it. This is what makes "open the file
   * from the tree without a password" impossible.
   */
  async unlockNote(noteFile: TFile | null): Promise<void> {
    if (!noteFile) return;
    // Identity from path/registry first (cheap); content is the fallback.
    // A renamed or externally-synced note can hold a perfect envelope while
    // the suffix and registry both lost it - heal rather than refuse.
    if (!this.notes.isSealedPath(noteFile.path)) {
      if (!(await this.notes.healIdentity(noteFile))) {
        new Notice(t("notice.notSealed"), 6000);
        return;
      }
      this.refreshExplorerBadges();
    }
    if (this.unlockingNotes.has(noteFile.path)) return;

    this.unlockingNotes.add(noteFile.path);
    try {
      // Reuse a live session's DEK if we have one; otherwise ask. We ALWAYS run
      // the reveal step, even when a session exists, because a crash or a
      // half-finished lock can leave a session with a still-placeholder body.
      // revealNote is idempotent - a revealed body is left untouched, which is
      // also what keeps text typed before a crash from being overwritten.
      const existingSession = this.sessions.get(noteFile.path);
      const dek = existingSession?.dek ?? (await this.unlockService.dekFor(noteFile.path, { subject: noteFile.basename }));
      if (!dek) return; // user cancelled

      // Capture the key copy from the locked envelope BEFORE reveal replaces
      // it with plaintext. Once a lone note is unlocked there is no key source
      // left on disk, so lock/flush must reuse this in-memory copy.
      let sessionKr = existingSession?.keyring ?? null;
      const envelope = await this.notes.tryReadEnvelope(noteFile);
      if (envelope?.keys) {
        sessionKr = formatKeyringFromCopy(envelope.keys);
        this.vaultIdentifier = envelope.keys.vaultId;
        this.unlockService.rememberKeyring(sessionKr);
      }

      // The reveal (and any bad-envelope repair) is ONE self-write window:
      // the buffer sync at its end must see the final disk state, not the
      // intermediate envelope the repair writes first.
      await this.markSelfWrite(noteFile.path, async () => {
        try {
          await this.notes.revealNote(noteFile, dek, this.vaultId());
        } catch (error) {
          if ((error as CodedError).code !== "E_BAD_ENVELOPE") throw error;
          // A note damaged by an external editor: seal its bytes first, then
          // reveal them. writePlaintext now writes the envelope into THIS
          // file, so the following revealNote turns it back into editable
          // plaintext.
          const raw = await this.notes.readCiphertext(noteFile);
          const kr = await this.unlockService.requireKeyring();
          await this.notes.writePlaintext(noteFile, dek, this.vaultId(), this.vaultId(), raw, kr);
          await this.notes.revealNote(noteFile, dek, this.vaultId());
          new Notice(t("notice.badEnvelopeRepaired"), 10000);
        }
      });
      this.sessions.put(noteFile.path, dek, "unlock", sessionKr ?? undefined);
      await this.showAsMarkdown(noteFile.path);
      this.rememberLeafFor(noteFile.path);
      this.refreshStatusBar();
      this.log.info("note_unlocked", { note: noteFile.path });
    } finally {
      this.unlockingNotes.delete(noteFile.path);
    }
  }

  /**
   * Open-time safety net: a vault note (registry member) whose body is still
   * plaintext has leaked - a crash, a quit that beat the async re-seal, or a
   * rename that stripped the suffix. Re-seal it before the user reads a word,
   * which requires the credential. A legitimately unlocked note (live session)
   * is left alone; cancelling the prompt keeps the note flagged and asks again
   * on the next open rather than showing stale plaintext as if it were safe.
   */
  private async sealRevealedOnOpen(file: TFile): Promise<void> {
    if (this.sessions.get(file.path)) return; // unlocked on purpose
    if (file.path === this.creatingNotePath) return;
    const raw = await this.app.vault.cachedRead(file).catch(() => "");
    if (!this.notes.isRevealedText(raw)) return; // envelope: nothing leaked
    if (!(await this.hasKeyring())) return; // nothing to seal against yet

    const dek = await this.unlockService.dekFor(file.path, {
      subject: file.basename,
      verb: "encrypt",
    });
    if (!dek) {
      new Notice(t("notice.resealSkipped", { name: file.basename }), 10000);
      this.log.warn("reseal_on_open_cancelled", { path: file.path });
      return;
    }
    const kr = await this.unlockService.requireKeyring();
    await this.markSelfWrite(file.path, () =>
      this.notes.reSealNote(file, dek, kr.vaultId, kr.vaultId, kr),
    );
    // The note is ciphertext again; the dekFor call cached a session for the
    // path, but nothing here is open for editing, so drop it.
    this.sessions.lock(file.path);
    new Notice(t("notice.resealedOnOpen", { name: file.basename }), 8000);
    this.log.info("note_resealed_on_open", { path: file.path });
    this.refreshStatusBar();
  }

  /**
   * Lock a note: flush plaintext into the payload, restore the placeholder
   * body, drop the DEK.
   *
   * Never prompts. This runs from background hooks (tab switch, window blur,
   * unload), and a credential dialog appearing because the user clicked another
   * tab would be worse than the alternative. If the key is somehow gone, the
   * note stays open with a warning instead of being reported as locked while its
   * body is still plaintext.
   */
  async lockNote(notePath: string): Promise<void> {
    const timer = this.saveTimers.get(notePath);
    if (timer) window.clearTimeout(timer);
    this.saveTimers.delete(notePath);
    this.unlockedLeaves.delete(notePath);
    // Locking ends the editing session, so any pill claimed by a debounced flush
    // must go with it.
    const release = () => this.releaseBusy(notePath);

    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      this.sessions.lock(notePath);
      release();
      return;
    }
    if (!this.isUnlocked(notePath)) {
      release();
      return; // already locked
    }

    // A plain note can hold a session entry only as a DEK cache (inline block
    // unlock). Its body is NOT revealed note plaintext: running it through
    // reSealNote hits the legacy-migration path and replaces the whole file
    // with a placeholder comment. Drop the cache, touch nothing on disk.
    if (!this.notes.isSealedPath(notePath)) {
      this.sessions.lock(notePath);
      this.refreshStatusBar();
      this.log.info("dek_cache_dropped", { note: notePath });
      return;
    }

    const dek = this.sessions.get(notePath)?.dek ?? null;
    try {
      if (!dek) {
        // Only reachable if the session expired between the two checks above.
        this.log.warn("lock_without_key", { note: notePath });
        new Notice(t("notice.lockNoKey"), 8000);
        return;
      }
      // Prefer the copy captured at unlock: this note's own body is plaintext
      // now, so a vault with only this one note has no on-disk key source.
      const kr = this.sessions.get(notePath)?.keyring ?? (await this.unlockService.requireKeyring());
      this.vaultIdentifier = kr.vaultId;

      await this.markSelfWrite(notePath, () => this.notes.reSealNote(file, dek, kr.vaultId, kr.vaultId, kr));
      this.sessions.lock(notePath);
      this.refreshStatusBar();
      this.log.info("note_locked", { note: notePath });
    } finally {
      release();
    }
  }

  /**
   * No-op in the single-file layout: the revealed body IS the live document
   * that Obsidian autosaves. There is no second location to flush into, and
   * encrypting here would overwrite what the user is still typing. The only
   * moment that writes ciphertext is lockNote().
   */
  async flushNote(_notePath: string): Promise<void> {
    return;
  }

  private scheduleFlush(notePath: string): void {
    const prev = this.saveTimers.get(notePath);
    if (prev) window.clearTimeout(prev);
    // Silent by design: an unlocked note always has its DEK, so the flush below
    // is a 3ms write that never needs the user. No progress pill, no dialog.
    const timer = window.setTimeout(() => {
      this.saveTimers.delete(notePath);
      void this.guard(() => this.flushNote(notePath));
    }, this.settingsData.autoSaveMs ?? 1500);
    this.saveTimers.set(notePath, timer);
  }

  /**
   * Take ownership of the progress pill for one note. Ownership matters because
   * a stale release (from a slower, older save) must not hide the indicator a
   * newer save just put up.
   */
  private claimBusy(notePath: string, label: string): void {
    this.busyPath = notePath;
    this.busy.show(label);
  }

  private releaseBusy(notePath: string): void {
    // Ownership check: a stale release from an older operation must not hide a
    // pill a newer one just put up.
    if (this.busyPath !== null && this.busyPath !== notePath) return;
    this.busyPath = null;
    this.busy.hide();
  }

  /** Run a vault write we made ourselves, suppressing our modify handler. */
  private async markSelfWrite(path: string, write: () => Promise<void>): Promise<void> {
    this.selfWrites.add(path);
    // The buffer must be allowed to follow the disk during this window;
    // see openCiphertextSyncWindow in the guard.
    openCiphertextSyncWindow();
    try {
      await write();
    } finally {
      // modify events fire async; keep the guard alive briefly.
      window.setTimeout(() => this.selfWrites.delete(path), 300);
      // Obsidian's own buffer sync is not guaranteed to win the race (a stale
      // dirty buffer autosaves the OLD body over our fresh one - the exact
      // "unlock showed no plaintext" bug). Push the disk content into every
      // editor showing this path ourselves, so buffer == disk by construction.
      this.syncBufferToDisk(path);
    }
  }

  /**
   * Force the open editor(s) showing `path` to hold exactly what is on disk.
   * setValue on an already-matching buffer is skipped; a mismatch is the
   * reveal/lock swap we just performed.
   */
  private syncBufferToDisk(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const view = this.markdownViewFor(path);
    const editor = (view as unknown as { editor?: EditorLike } | null)?.editor;
    if (!editor || typeof editor.getValue !== "function") return;
    void this.app.vault
      .read(file)
      .then((disk) => {
        try {
          if (editor.getValue() !== disk) editor.setValue(disk);
        } catch (error) {
          this.log.warn("buffer_sync_failed", { path, error: String(error) });
        }
      })
      .catch(() => undefined);
  }

  /**
   * Reveal the native Markdown editor for `path`. Unlocking from a menu may
   * happen while no tab shows the note, so open one in a main-area leaf;
   * getLeaf(false)/activeLeaf can be the file explorer, hence the leaf check.
   */
  private async showAsMarkdown(path: string): Promise<void> {
    const mdLeaves = this.app.workspace.getLeavesOfType("markdown") ?? [];
    for (const leaf of mdLeaves) {
      if (this.viewPath(leaf) === path && !this.isSideLeaf(leaf)) {
        await this.revealLeaf(leaf);
        return;
      }
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;
    const internals = this.app.workspace as unknown as WorkspaceInternals;
    const active = internals.activeLeaf;
    const leaf = active && this.isMainAreaLeaf(active) ? active : this.app.workspace.getLeaf(true);
    if (!leaf) throw Err.io(t("error.noEditorLeaf"));
    await leaf.setViewState({ type: "markdown", state: { file: path }, active: true });
    await this.revealLeaf(leaf);
  }

  /** The Markdown view currently showing `path`, if any. */
  private markdownViewFor(path: string): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === path) return active;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown") ?? []) {
      if (this.viewPath(leaf) === path) return leaf.view as MarkdownView;
    }
    return null;
  }

  /** Lock every unlocked note; returns how many were locked. */
  private async lockAllNotes(): Promise<number> {
    const paths = new Set<string>(this.sessions.unlockedPaths());
    let locked = 0;
    for (const path of paths) {
      const before = this.isUnlocked(path);
      await this.lockNote(path);
      if (before && !this.isUnlocked(path)) locked++;
    }
    this.unlockService.lockAll();
    return locked;
  }

  private async openFile(file: TFile): Promise<void> {
    // A locked note is just a Markdown file holding a ciphertext envelope.
    // Open it natively; the reading-view marker explains the lock and offers
    // unlock. getLeaf(true) avoids replacing the file-explorer sidebar.
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  /* ---------------- inline-block sealing ------------------------------- */

  /**
   * Recompute whether a PLAIN note holds unsealed plaintext fences (a
   * hand-typed ```encrypted_txt whose body is not sn1.*). The result is the
   * trail that drives the status bar and the leaving-point seal attempts.
   */
  private async trackUnsealed(path: string): Promise<void> {
    if (this.notes.isSealedPath(path)) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (this.unsealedNotes.delete(path)) this.refreshStatusBar();
      return;
    }
    const raw = await this.app.vault.cachedRead(file).catch(() => "");
    const had = this.unsealedNotes.has(path);
    const has = findUnsealedBlocks(raw).length > 0;
    if (has) this.unsealedNotes.add(path);
    else this.unsealedNotes.delete(path);
    if (has !== had) {
      if (has) this.rememberUnsealedLeaf(path);
      else this.unsealedLeaves.delete(path);
      this.refreshStatusBar();
      // Deliberately NO seal here: modify fires while the user is still
      // typing in the block. Sealing on a keystroke would rewrite the
      // buffer mid-sentence and destroy the draft. Every seal happens at
      // leaving points (blur, switch, reading-view render, tab close,
      // unload) or on the user's own click in the rendered card.
    }
  }

  /**
   * A DEK usable for sealing without asking. One vault key wraps everything,
   * so ANY live session holds it. Its lifetime already follows lockPolicy
   * (blur drops sessions on leaving, close/session keep them).
   */
  private cachedSealDek(path: string): Uint8Array | null {
    const own = this.sessions.get(path)?.dek ?? null;
    if (own) return own;
    for (const open of this.sessions.unlockedPaths()) {
      const entry = this.sessions.get(open);
      if (entry) return entry.dek;
    }
    return null;
  }

  /**
   * Seal every unsealed plaintext fence in a plain note, in place.
   *
   * interactive=true: user-driven (blur point, card button) - may ask for the
   * credential once. On cancel or failure NOTHING is deleted: the block stays
   * plaintext, the trail keeps the status bar warning, and the next visit
   * asks again (Obsidian cannot block the view switch itself).
   * interactive=false: silent opportunistic seal (unload), cached key only,
   * never a dialog.
   * notify=false: the CALLER reports the outcome (the reading-view card shows
   * its own notice); background hooks announce the lingering plaintext once.
   */
  async sealPlainNote(
    path: string,
    opts: { interactive: boolean; notify?: boolean } = { interactive: true },
  ): Promise<number> {
    if (this.sealingNotes.has(path)) return 0;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || this.notes.isSealedPath(path)) return 0;
    const raw = await this.app.vault.read(file).catch(() => "");
    if (findUnsealedBlocks(raw).length === 0) {
      if (this.unsealedNotes.delete(path)) {
        this.warnedUnsealed.delete(path);
        this.refreshStatusBar();
      }
      return 0; // nothing to seal counts as success upstream; 0 = "sealed nothing"
    }
    this.sealingNotes.add(path);
    try {
      let dek = this.cachedSealDek(path);
      if (!dek) {
        if (!opts.interactive) return -1; // silent pass: no key, no seal, no noise
        this.claimBusy(path, t("busy.sealing"));
        try {
          dek = await this.unlockService.dekFor(path, { subject: file.basename, verb: "encrypt" });
        } finally {
          this.releaseBusy(path);
        }
      }
      if (!dek) {
        // user cancelled: plaintext stays, trail stays, nothing deleted
        if (opts.notify !== false) this.warnUnsealed(path, null);
        return -1;
      }
      const kr = await this.unlockService.requireKeyring();
      this.vaultIdentifier = kr.vaultId;
      const { text, sealed } = await this.encryption.sealUnsealedBlocks(dek, raw);
      if (sealed > 0) {
        await this.markSelfWrite(path, () => this.app.vault.modify(file, text));
      }
      this.unsealedNotes.delete(path);
      this.unsealedLeaves.delete(path);
      this.warnedUnsealed.delete(path);
      this.refreshStatusBar();
      if (sealed > 0) this.log.info("plain_note_sealed", { path, sealed });
      return sealed;
    } catch (error) {
      // Honest failure: keep the bytes, leave the trail, explain once.
      this.log.warn("block_seal_failed", { path, error: String(error) });
      if (opts.notify !== false) this.warnUnsealed(path, describeError(error));
      return -1;
    } finally {
      this.sealingNotes.delete(path);
    }
  }

  /** Warning trail: block stays plaintext, status bar nags, notice explains. */
  private warnUnsealed(path: string, reason: string | null, forceNotice = false): void {
    const isNew = !this.unsealedNotes.has(path);
    this.unsealedNotes.add(path);
    if (isNew) this.rememberUnsealedLeaf(path);
    this.refreshStatusBar();
    // Background hooks (blur loops) may fire many times; one Notice per trail
    // entry keeps the warning loud but not spammy. Explicit user clicks pass
    // forceNotice=true and always hear back.
    if (forceNotice || !this.warnedUnsealed.has(path)) {
      this.warnedUnsealed.add(path);
      new Notice(t("notice.unsealedKept", { name: path.split("/").pop() ?? path, reason: reason ?? "" }), 8000);
    }
  }

  /**
   * Seal the notes the user has LEFT (blur-level hooks). Runs BEFORE the
   * session lock loop: sealing needs the cached DEK that locking drops.
   */
  private async sealLeftNotes(exceptPath: string | null): Promise<void> {
    for (const path of [...this.unsealedNotes]) {
      if (exceptPath && path === exceptPath) continue;
      await this.sealPlainNote(path, { interactive: true });
    }
  }

  /** Which event re-locks/asks about an unlocked NOTE also governs blocks. */
  private shouldSealOnLeave(): boolean {
    return this.lockPolicy() === "blur";
  }

  private rememberUnsealedLeaf(path: string): void {
    const leaves: WorkspaceLeaf[] = [
      ...(this.app.workspace.getLeavesOfType?.("markdown") ?? []),
    ];
    for (const leaf of leaves) {
      if (this.viewPath(leaf) === path) {
        this.unsealedLeaves.set(path, leaf);
        return;
      }
    }
    this.unsealedLeaves.delete(path);
  }

  /**
   * Close-level sweep: a trail note whose tabs are ALL destroyed gets one
   * seal attempt (interactive, same as a private note locking on close).
   */
  private sweepUnsealedClosedTabs(): void {
    if (this.lockPolicy() !== "close") return;
    for (const path of [...this.unsealedNotes]) {
      if (this.anyLeafShows(path)) continue; // still open somewhere: not left yet
      const leaf = this.unsealedLeaves.get(path);
      if (!leaf) continue; // no reliable leaf: leaving hooks / card still cover it
      if (this.leafAlive(leaf)) continue; // switched away, not closed
      this.unsealedLeaves.delete(path);
      void this.guard(async () => {
        await this.sealPlainNote(path, { interactive: true });
        // The tab is gone, so the note's DEK cache retires with it - even if
        // the seal was cancelled and the trail stays. The session sweep above
        // deliberately skipped this path so the seal could run on the cached
        // key; without this drop the cache would outlive its tab and a
        // reopened note would decrypt blocks without asking. (Sealing its
        // own blocks on a live session is covered by the blur-path tests;
        // each session holds a private DEK copy, so wiping this entry cannot
        // damage another note's session.)
        this.sessions.lock(path);
        this.refreshStatusBar();
      });
    }
  }

  /**
   * Reading-view sweep. Toggling a note to reading view fires layout-change;
   * an editor-mode toggle to PREVIEW also renders our card, but that is a
   * live-preview render, not "left". For every trail note that is now shown
   * ONLY in reading mode, attempt a seal. This is the user's requested
   * "switch to reading view must not silently leave plaintext".
   */
  private async sealReadingView(): Promise<void> {
    if (this.lockPolicy() !== "blur") return;
    for (const path of [...this.unsealedNotes]) {
      let inEditor = false;
      let inReading = false;
      this.app.workspace.iterateAllLeaves?.((leaf: WorkspaceLeaf) => {
        const view = leaf.view as unknown as MarkdownViewLike | null;
        if (view?.getViewType?.() !== "markdown") return;
        if (view.file?.path !== path) return;
        if (typeof view.getMode === "function" && view.getMode() === "reading") inReading = true;
        else inEditor = true;
      });
      if (inReading && !inEditor) {
        await this.sealPlainNote(path, { interactive: true });
      }
    }
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
    openCiphertextSyncWindow();
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
    // The replacement INTERSECTS the ciphertext regions the guard protects:
    // open the sync window so our own intended rewrite passes the filters.
    openCiphertextSyncWindow();
    editor.replaceSelection(plain);
    new Notice(t("notice.decrypted"), 6000);
    // A decrypted FENCE leaves plaintext inside an encrypted_txt block. The
    // buffer may not have reached cachedRead yet, so register the trail
    // directly instead of re-scanning - honest and race-free. (An inline
    // `sn1.x` payload becomes bare text, not a tracked block.)
    if (fenced) {
      this.unsealedNotes.add(file.path);
      this.rememberUnsealedLeaf(file.path);
      this.refreshStatusBar();
    }
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
      throw Err.io(t("error.fileExists", { path: target }));
    }
    // The plaintext copy is created WITHOUT nesting inline decryption, so any
    // encrypted blocks inside stay encrypted.
    const created = await this.app.vault.create(target, plaintext);
    await this.openFile(created);
    new Notice(t("notice.plainCopyCreated", { path: target }), 8000);
    this.log.info("whole_note_decrypted", { source: file.path, target });
  }

  /**
   * One "Decrypt document" entry for both note kinds:
   *   - sealed note -> create a plaintext .md copy (ciphertext stays intact)
   *   - plain note  -> decrypt every encrypted block inline, in place
   */
  /**
   * Lock an ordinary Markdown note in place. The filename stays exactly as it
   * is; only the body becomes the ciphertext envelope. Afterwards the note is
   * a vault note like any other, unlocked explicitly from the menu or the
   * reading-view marker.
   */
  async lockDocument(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") return;
    if (this.notes.isSealedPath(file.path) || !this.notes.isRevealedText(await this.app.vault.read(file).catch(() => ""))) {
      new Notice(t("notice.alreadyLocked"));
      return;
    }
    if (!(await this.hasKeyring())) {
      new Notice(t("settings.noKey"));
      return;
    }
    const dek = await this.requireInitialised();
    if (!dek) return;
    const kr = await this.unlockService.requireKeyring();
    const raw = await this.app.vault.read(file);
    await this.markSelfWrite(file.path, () =>
      this.notes.writePlaintext(file, dek, kr.vaultId, kr.vaultId, raw, kr),
    );
    await this.notes.markSealed(file.path);
    this.sessions.lock(file.path);
    this.unlockedLeaves.delete(file.path);
    new Notice(t("notice.documentLocked"));
    this.log.info("document_locked", { path: file.path });
    this.refreshStatusBar();
  }

  /**
   * Demote a vault note back to an ordinary note - the inverse of
   * lockDocument. The credential must be proven first (demoting without the
   * key would let anyone strip protection off a stolen sync copy). A suffixed
   * note keeps its content and loses the .sealed.md tail; an in-place note
   * just gets its plaintext body back. Either way the registry forgets it,
   * so future opens never ask for a password again.
   */
  async demoteToPlain(file: TFile | null): Promise<void> {
    if (!file || !this.notes.isSealedPath(file.path)) {
      new Notice(t("notice.notSealed"));
      return;
    }
    const dek = await this.unlockService.dekFor(file.path, { subject: file.basename });
    if (!dek) return;
    const kr = await this.unlockService.requireKeyring();

    const raw = await this.app.vault.read(file);
    const plaintext = this.notes.isRevealedText(raw)
      ? raw
      : await this.notes.readPlaintext(file, dek, kr.vaultId);

    let finalPath = file.path;
    if (/\.sealed(\.md)?$/i.test(file.path)) {
      finalPath = normalizePath(file.path.replace(/\.sealed\.md$/i, ".md").replace(/\.sealed$/i, ".md"));
      if (this.app.vault.getAbstractFileByPath(finalPath)) {
        throw Err.io(t("error.fileExists", { path: finalPath }));
      }
      await this.markSelfWrite(file.path, () => this.app.vault.rename(file, finalPath));
      // The rename event may carry the registry entry to the new path; make
      // sure it does not survive either way (both calls are convergent).
      await this.notes.renameVaultPath(file.path, finalPath);
    }
    const target = this.app.vault.getAbstractFileByPath(finalPath);
    if (!(target instanceof TFile)) return;
    await this.markSelfWrite(finalPath, () => this.app.vault.modify(target, plaintext));
    await this.notes.unmarkSealed(finalPath);

    this.sessions.lock(file.path);
    this.sessions.lock(finalPath);
    this.unlockedLeaves.delete(file.path);
    this.unlockedLeaves.delete(finalPath);
    new Notice(t("notice.demoted", { path: finalPath }), 8000);
    this.log.info("note_demoted", { from: file.path, to: finalPath });
    this.refreshExplorerBadges();
    this.refreshStatusBar();
  }

  async decryptDocument(file: TFile): Promise<void> {
    if (this.notes.isSealedPath(file.path)) {
      await this.decryptWholeFile(file);
      return;
    }
    const dek = await this.unlockService.dekFor(file.path, { subject: file.basename });
    if (!dek) return;
    const source = await this.app.vault.read(file);
    const result = await this.encryption.decryptAll(dek, source);
    if (result.fenced + result.inline === 0) {
      new Notice(t("notice.notEncrypted"));
      return;
    }
    await this.app.vault.modify(file, result.text);
    new Notice(t("notice.decryptedDocument"));
    this.log.info("document_decrypted", { path: file.path, ...{ fenced: result.fenced, inline: result.inline } });
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

    let details = "";
    if (result.withoutCopy) details += t("notice.copiesWithout", { n: result.withoutCopy });
    if (result.failed) details += t("notice.copiesFailed", { n: result.failed });
    new Notice(
      t("notice.copiesRefreshDone", {
        updated: result.updated,
        current: result.current,
        without: result.withoutCopy ? t("notice.copiesWithout", { n: result.withoutCopy }) : "",
        failed: result.failed ? t("notice.copiesFailed", { n: result.failed }) : "",
      }),
      result.failed ? 12000 : 8000,
    );
    void details;

    if (result.failures.length) {
      this.log.warn("key_copy_refresh_partial", { failures: result.failures });
    }
  }

  /**
   * A private note is identified by the .sealed.md suffix. If the user renames
   * one and drops that suffix, it would silently become an ordinary note and
   * lose its unlock entry point. Put the suffix back automatically, and carry
   * all internal state (ID cache, session, pending flag) to the new path.
   */
  private async onNoteRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!file || typeof file.path !== "string") return;
    // atomicWrite swaps a note through "<path>.old" before putting the new
    // bytes in place, so Obsidian reports renames that are ours, not the user's.
    // Treating those as a real rename would rewrite the suffix of the scratch
    // file and could re-key our caches onto it.
    if (/(\.tmp|\.old)$/i.test(file.path) || /(\.tmp|\.old)$/i.test(oldPath)) return;

    const wasSealed = this.notes.isSealedPath(oldPath);
    if (!wasSealed) {
      // A plain note: the only state we keep for it is the unsealed-block
      // trail, which must follow the rename or the warning points at a dead
      // path while the new one goes unsealed.
      if (this.unsealedNotes.has(oldPath)) {
        this.unsealedNotes.delete(oldPath);
        this.unsealedNotes.add(file.path);
        const leaf = this.unsealedLeaves.get(oldPath);
        this.unsealedLeaves.delete(oldPath);
        if (leaf) this.unsealedLeaves.set(file.path, leaf);
        this.refreshStatusBar();
      }
      return; // not a private note before the rename
    }

    // Notes created by the wizard keep the canonical .sealed.md suffix; notes
    // locked in place keep whatever filename the user chose. Either way the
    // ciphertext is in the body, so a rename only moves in-memory state.
    const finalPath = file.path;
    await this.notes.renameVaultPath(oldPath, finalPath);

    const session = this.sessions.get(oldPath);
    if (session) {
      this.sessions.put(finalPath, session.dek, session.providerId);
      this.sessions.lock(oldPath);
    }
    if (this.busyPath === oldPath) this.busyPath = finalPath;
  }

  /** Drop in-memory state for a deleted note; ciphertext died with the file. */
  private async onNoteDeleted(file: TAbstractFile): Promise<void> {
    if (!file || typeof file.path !== "string") return;
    if (!this.notes.isSealedPath(file.path)) {
      // Plain note gone: its trail entry would nag for a file that no longer
      // exists. Drop it.
      if (this.unsealedNotes.delete(file.path)) {
        this.unsealedLeaves.delete(file.path);
        this.refreshStatusBar();
      }
      return;
    }
    const timer = this.saveTimers.get(file.path);
    if (timer) window.clearTimeout(timer);
    this.saveTimers.delete(file.path);
    void this.notes.unmarkSealed(file.path);
    this.sessions.lock(file.path);
    this.releaseBusy(file.path);
    this.refreshStatusBar();
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

    const picked = await new Promise<RecoveryCandidate | null>((resolve) => {
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
      t("notice.keyringRebuilt", { source: result.source, epoch: result.keyring.epoch, slot: result.slot }),
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
        ? t("notice.passwordChangedFull", { n: result.updated })
        : t("notice.passwordChangedPartialNotice", { n: result.failed }),
      result.failed ? 12000 : 9000,
    );
    this.refreshStatusBar();
  }

  async replaceRecoveryAndRefresh(dek: Uint8Array, newRecovery: string): Promise<void> {
    await this.unlockService.replaceRecovery(dek, newRecovery);
    const kr = await this.unlockService.requireKeyring();
    await this.keyCopies.refreshAll(kr);
  }

  /**
   * Save the recovery key from settings. Works whether or not one exists yet:
   * "set" and "reset" are the same operation, only the confirmation differs.
   * Re-auth follows the configured mode (TOTP -> code, password -> password,
   * both -> both); a master password is never required just to reach this flow.
   */
  async setOrResetRecoveryKey(): Promise<void> {
    if (!(await this.hasKeyring())) {
      new Notice(t("settings.noKey"), 8000);
      return;
    }
    const kr = await this.unlockService.requireKeyring();
    const alreadySet = !!kr.slots[SLOT_RECOVERY];
    if (alreadySet) {
      const ok = await new Promise<boolean>((resolve) => {
        new ConfirmModal(
          this.app,
          {
            title: t("notice.recoveryRegenTitle"),
            body: `${t("notice.recoveryRegenBody")}\n\n${t("recovery.shareWarning")}`,
            confirmText: t("notice.recoveryRegenOk"),
            danger: true,
          },
          resolve,
        ).open();
      });
      if (!ok) return;
    }

    const reauth = await this.unlockService.reauthForSettings(t("settings.recovery"));
    if (!reauth) {
      new Notice(t("settings.modeNoCredential"), 10000);
      return;
    }
    const key = generateRecoveryKey();
    await this.unlockService.replaceRecovery(reauth.dek, key);
    const fingerprint = await keyFingerprint(reauth.dek);
    await new Promise<boolean>((resolve) => {
      new RecoveryKeyModal(this.app, key, fingerprint, this.app.vault.getName(), resolve).open();
    });
    new Notice(alreadySet ? t("notice.recoveryDone") : t("notice.recoverySaved"), 8000);
  }

  async showRecoveryKey(): Promise<void> {
    await this.setOrResetRecoveryKey();
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
    await this.applyUnlockMode(dek, kr, mode);
  }

  /**
   * Switch the vault's decryption mode from the settings page. Re-authenticate
   * with the CURRENT mode's credential first, so a walk-up cannot downgrade the
   * unlock requirements, then reuse the existing TOTP seed when one is on this
   * device (no QR re-scan for password <-> TOTP <-> both).
   */
  async switchUnlockMode(mode: "password" | "totp" | "password+totp"): Promise<void> {
    const reauth = await this.unlockService.reauthForSettings(t("mode.title"));
    if (!reauth) {
      new Notice(t("settings.modeNoCredential"), 10000);
      return;
    }
    const applied = await this.applyUnlockMode(reauth.dek, reauth.kr, mode);
    if (applied) this.refreshStatusBar();
  }

  /** Collect the credentials the target mode needs and hand them to configureMode. */
  private async applyUnlockMode(
    dek: Uint8Array,
    kr: KeyringData,
    mode: "password" | "totp" | "password+totp",
  ): Promise<boolean> {
    if (mode === "password") {
      // From a strict two-factor vault the standalone password slot no longer
      // exists (and in TOTP-only mode it never did). configureMode("password")
      // with no password would then leave a "password mode" with no password
      // door - only recovery could get back in. Ask for one whenever the vault
      // currently has no standalone password to keep.
      const hasPasswordDoor = !!kr.slots[SLOT_PASSWORD];
      const credentials = hasPasswordDoor
        ? null
        : await new Promise<{ password: string; hint: string } | null>((resolve) => {
            new SetupModal(this.app, resolve).open();
          });
      if (!hasPasswordDoor && !credentials) return false;
      await this.unlockService.configureMode(dek, mode, { password: credentials?.password });
      new Notice(t("notice.modePassword"));
      this.log.info("unlock_mode_configured", { mode });
      return true;
    }

    let password: string | undefined;
    if (mode === "password+totp") {
      // A TOTP-only (or already strict combined) vault has no standalone
      // password to confirm. Ask for a NEW one there; otherwise confirm the
      // existing password that will be folded into the combined slot.
      if (kr.slots[SLOT_PASSWORD]) {
        const confirmed = await new Promise<string | null>((resolve) => {
          new PasswordPromptModal(this.app, t("mode.confirmPw"), resolve).open();
        });
        password = confirmed ?? undefined;
      } else {
        const credentials = await new Promise<{ password: string; hint: string } | null>((resolve) => {
          new SetupModal(this.app, resolve).open();
        });
        password = credentials ? credentials.password : undefined;
      }
      if (!password) return false;
    }

    // Reuse the existing seed when switching between TOTP-bearing modes; only
    // enrol a new authenticator when this device has no seed at all.
    let seed = await this.unlockService.currentSeed(kr);
    if (!seed) {
      const account = this.app.vault.getName();
      const result = await new Promise<{ seed: string; otpauth: string } | null>((resolve) => {
        new TotpSetupModal(this.app, account, resolve).open();
      });
      if (!result) return false;
      seed = result.seed;
    }

    await this.unlockService.configureMode(dek, mode, { password: password ?? undefined, seed });
    await this.keyCopies.refreshAll(await this.unlockService.requireKeyring());
    new Notice(t("notice.totpDone"), 12000);
    this.log.info("unlock_mode_configured", { mode });
    return true;
  }

}