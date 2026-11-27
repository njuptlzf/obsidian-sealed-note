/**
 * Reading and writing private notes.
 *
 * The .sealed.md file body IS the encrypted note envelope (an HTML comment
 * wrapping JSON). Renaming, moving or syncing the note can never separate it
 * from its ciphertext: there is no sidecar file and no reference annotation.
 * Unlocking replaces the body with bare plaintext; locking replaces it with
 * the envelope again.
 *
 * Invariants: cipher bytes are backed up before an overwrite, plaintext never
 * is, and body writes go through vault.modify so the Obsidian editor buffer
 * stays in sync with disk.
 */

import { t } from "../i18n";
import { App, TFile, normalizePath } from "obsidian";
import {
  KeyCopy,
  NoteEnvelope,
  looksLikeNoteEnvelope,
  noteBodyState,
  openNote,
  parseNoteEnvelope,
  sealNote,
  serializeNoteEnvelope,
  serializeNotePlain,
} from "../core/format";
import { KeyringData, keyCopyFromKeyringData } from "../core/keyring";
import { Err } from "../util/errors";
import { log } from "../util/log";

export const SEALED_EXTENSION = "sealed.md";
const KEEP_BACKUPS = 5;

export interface EnvelopeSource {
  envelope: NoteEnvelope;
}

/**
 * Exactly one key-copy builder exists: the wrapped key in a payload IS the
 * keyring in this design. It must keep the TOTP slot and TOTP mode, or the
 * configured unlock method disappears after a restart.
 */
export class SealedNoteStore {
  private readonly log = log.child("sealed-note-store");
  /** per-path write chain: two saves of one file must never interleave */
  private readonly writeChains = new Map<string, Promise<void>>();
  /**
   * Ordinary notes locked in place keep their filename, so the `.sealed.md`
   * suffix alone cannot identify them. This set is the content-detected
   * registry: populated at startup by scanning note bodies, and updated on
   * lock/reveal/create/delete. Callers get a synchronous isSealedPath while
   * the source of truth remains the envelope in each note.
   */
  private readonly vaultPaths = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
  ) {}

  /* ---------------- paths ------------------------------------------------- */

  isSealedPath(path: string): boolean {
    return this.vaultPaths.has(path) || path.toLowerCase().endsWith(`.${SEALED_EXTENSION}`);
  }

  /** Path of the persisted registry, inside the plugin's own (hidden) dir. */
  private get vaultIndexPath(): string {
    return normalizePath(`${this.pluginDir}/vault-notes.json`);
  }

  /**
   * Rebuild the registry at startup from two sources: the persisted list (which
   * keeps a note recognised even after a crash left its body as plaintext) and
   * a content scan (which catches notes added by sync while Obsidian was off).
   * Entries whose file no longer exists are pruned.
   */
  async refreshVaultPaths(): Promise<void> {
    this.vaultPaths.clear();
    try {
      const index = await this.app.vault.adapter.read(this.vaultIndexPath);
      const paths = JSON.parse(index);
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (typeof p === "string" && this.app.vault.getAbstractFileByPath(p)) {
            this.vaultPaths.add(p);
          }
        }
      }
    } catch {
      // No index yet (first run) or corrupt: the content scan below rebuilds it.
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file.path.toLowerCase().endsWith(`.${SEALED_EXTENSION}`)) {
        this.vaultPaths.add(file.path);
        continue;
      }
      try {
        const raw = await this.app.vault.cachedRead(file);
        if (looksLikeNoteEnvelope(raw)) this.vaultPaths.add(file.path);
      } catch {
        // unreadable file: leave it out, it cannot be opened either
      }
    }
    await this.persistVaultPaths();
    this.log.info("vault_paths_scanned", { count: this.vaultPaths.size });
  }

  /** Persist the registry so arbitrary-named notes survive a crash while revealed. */
  private persistVaultPaths(): Promise<void> {
    // Serialize through the same per-path chain used for note bodies: a boot
    // scan and a later markSealed() must not land their index writes out of
    // order (a stale empty index would lose the newly registered path).
    return this.chainWrite(this.vaultIndexPath, async () => {
      try {
        const dir = this.pluginDir;
        if (dir && !(await this.app.vault.adapter.exists(dir))) {
          await this.app.vault.adapter.mkdir(dir);
        }
        await this.app.vault.adapter.write(
          this.vaultIndexPath,
          JSON.stringify([...this.vaultPaths].sort(), null, 2),
        );
      } catch (error) {
        this.log.warn("vault_index_write_failed", { error: String(error) });
      }
    });
  }

  /** Register a path after sealing a note in place. Awaited by create(). */
  markSealed(path: string): Promise<void> {
    this.vaultPaths.add(path);
    return this.persistVaultPaths();
  }

  /**
   * Content is the source of truth for what a private note IS; the suffix and
   * the registry are only how we recognise it cheaply. A note can lose both
   * while keeping its envelope: renamed outside the plugin (sync client,
   * another device, a lost rename event), or registered before a crash wiped
   * the index. When that happens, the body itself still says "sealed" - so
   * re-register from the content instead of treating the note as ordinary.
   * Returns true when the note was healed (or already known).
   */
  async healIdentity(file: TFile): Promise<boolean> {
    if (this.isSealedPath(file.path)) return true;
    // Only a parseable envelope counts. A plaintext body is NOT registered:
    // it may be an ordinary note, and a leaked revealed note is handled by
    // the plugin's re-seal safety net, not by silently changing its identity.
    // cachedRead: this runs on open/modify for EVERY note, so it must not
    // force a disk read.
    const raw = await this.app.vault.cachedRead(file).catch(() => "");
    if (noteBodyState(raw) !== "sealed") return false;
    if (!parseNoteEnvelope(raw)) return false;
    await this.markSealed(file.path);
    this.log.info("identity_healed_from_content", { path: file.path });
    return true;
  }

  /** Every known vault note path, for the file-explorer badges. */
  vaultNotePaths(): string[] {
    return [...this.vaultPaths];
  }

  /** Drop a path when a note is deleted or permanently unlocked. */
  unmarkSealed(path: string): Promise<void> {
    this.vaultPaths.delete(path);
    return this.persistVaultPaths();
  }

  /**
   * Carry registry membership across a user rename. Only when the old path
   * was registered: a plain note renamed to bar.md must not become a vault
   * note, and a demoted note must stay demoted.
   */
  renameVaultPath(oldPath: string, newPath: string): Promise<void> {
    const was = this.vaultPaths.delete(oldPath);
    if (was) this.vaultPaths.add(newPath);
    return this.persistVaultPaths();
  }

  /** Every locked note carries a key copy in its own body. */
  isKeySourcePath(path: string): boolean {
    return this.isSealedPath(path);
  }

  withExtension(path: string): string {
    return this.isSealedPath(path) ? path : `${path}.${SEALED_EXTENSION}`;
  }

  /* ---------------- create ------------------------------------------------ */

  /** Create a single file whose body is the envelope for an empty note. */
  async create(
    kr: { vaultId: string; kid: string; keyring?: KeyringData },
    dek: Uint8Array,
    path: string,
    _title: string,
    _placeholderHint?: string,
  ): Promise<TFile> {
    const normalized = normalizePath(this.withExtension(path));
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) throw Err.io(t("error.fileExists", { path: normalized }));

    const copy = kr.keyring ? keyCopyFromKeyringData(kr.keyring) : undefined;
    // The revealed note will open as a clean blank editor, exactly like
    // Obsidian's own "New note". Locked body already carries the ciphertext.
    const sealed = parseNoteEnvelope(await sealNote(dek, kr.vaultId, kr.kid, "", copy));
    if (!sealed) throw Err.io(t("error.envelopeFail"));

    await this.ensureFolder(normalized);
    const file = await this.app.vault.create(normalized, serializeNoteEnvelope(sealed));
    // Persist, not just remember: the body is revealed immediately after
    // creation, so the envelope (and with it the suffix-free identity of this
    // note) exists on disk only for a moment. If the registry were only
    // rebuilt from bodies at next boot, a renamed or crash-revealed note would
    // silently stop being a vault note.
    await this.markSealed(normalized);
    this.log.info("sealed_note_created", { path: normalized });
    return file;
  }

  /* ---------------- read -------------------------------------------------- */

  async readCiphertext(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  /** Envelope from the note body itself. No sidecar is ever consulted. */
  async tryReadEnvelope(file: TFile): Promise<NoteEnvelope | null> {
    const raw = await this.app.vault.read(file).catch(() => "");
    if (noteBodyState(raw) !== "sealed") return null;
    return parseNoteEnvelope(raw);
  }

  async resolveEnvelope(file: TFile): Promise<EnvelopeSource> {
    const raw = await this.readCiphertext(file);
    if (noteBodyState(raw) !== "sealed") throw Err.badEnvelope(file.path);
    const envelope = parseNoteEnvelope(raw);
    if (!envelope) throw Err.badEnvelope(file.path);
    return { envelope };
  }

  /** Decrypt a note. Throws if the envelope is missing or damaged. */
  async readPlaintext(file: TFile, dek: Uint8Array, vaultId: string): Promise<string> {
    const { envelope } = await this.resolveEnvelope(file);
    if (envelope.kid && envelope.kid !== vaultId) {
      this.log.warn("note_kid_mismatch", { path: file.path, kid: envelope.kid, vaultId });
    }
    return openNote(dek, vaultId, envelope);
  }

  /* ---------------- write ------------------------------------------------- */

  /**
   * Encrypt plaintext and write the envelope into the SAME file body.
   * vault.modify keeps Obsidian's editor buffer in sync; adapter-level swaps
   * would leave a stale buffer that overwrites the ciphertext on the next key.
   */
  async writePlaintext(
    file: TFile,
    dek: Uint8Array,
    vaultId: string,
    kid: string,
    plaintext: string,
    keyring?: KeyringData,
  ): Promise<void> {
    const copy = keyring ? keyCopyFromKeyringData(keyring) : undefined;
    const sealed = parseNoteEnvelope(await sealNote(dek, vaultId, kid, plaintext, copy));
    if (!sealed) throw Err.io(t("error.envelopeFail"));
    const body = serializeNoteEnvelope(sealed);

    await this.chainWrite(file.path, async () => {
      await this.backupCiphertext(file.path);
      await this.app.vault.modify(file, body);
    });
  }

  /** Replace only the `keys` field; salt/IV/data are copied verbatim. */
  async updateKeyCopy(
    file: TFile,
    envelope: NoteEnvelope,
    keyCopy: KeyCopy,
  ): Promise<void> {
    const updated: NoteEnvelope = { ...envelope, keys: keyCopy };
    await this.chainWrite(file.path, async () => {
      await this.backupCiphertext(file.path);
      await this.app.vault.modify(file, serializeNoteEnvelope(updated));
    });
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.split("/").slice(0, -1).join("/");
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  /* ---------------- in-place reveal / reseal ------------------------------ */

  /**
   * In-place editing: an unlocked note's body IS the plaintext, with no
   * annotation at all. Locked, the very same body is the encrypted envelope.
   */

  /** True when a note body currently holds revealed plaintext (unlocked). */
  isRevealedText(text: string): boolean {
    const state = noteBodyState(text);
    return state === "revealed" || state === "empty";
  }

  /** Decrypt the body envelope and replace it with bare plaintext. */
  async revealNote(file: TFile, dek: Uint8Array, vaultId: string): Promise<void> {
    const raw = await this.app.vault.read(file);
    if (this.isRevealedText(raw)) return; // idempotent unlock
    const plaintext = await this.readPlaintext(file, dek, vaultId);
    await this.chainWrite(file.path, () => this.app.vault.modify(file, serializeNotePlain(plaintext)));
    this.log.info("note_revealed", { path: file.path });
  }

  /**
   * Encrypt the note's current plaintext body into that same body. Idempotent:
   * a locked note (envelope body) is skipped.
   */
  async reSealNote(
    file: TFile,
    dek: Uint8Array,
    vaultId: string,
    kid: string,
    keyring?: KeyringData,
  ): Promise<void> {
    const raw = await this.app.vault.read(file);
    if (!this.isRevealedText(raw)) return; // already locked
    await this.writePlaintext(file, dek, vaultId, kid, serializeNotePlain(raw), keyring);
    this.log.info("note_resealed", { path: file.path });
  }

  /** Plaintext currently sitting in a revealed note body (not the envelope). */
  async readRevealedBody(file: TFile): Promise<string> {
    const raw = await this.app.vault.read(file);
    return this.isRevealedText(raw) ? serializeNotePlain(raw) : "";
  }

  /* ---------------- lifecycle -------------------------------------------- */

  /**
   * Serialise writes to one path. An autosave flush racing a lock re-seal must
   * never interleave; the chain keeps a strict order per file. Body writes go
   * through vault.modify so the editor buffer stays in sync with disk.
   */
  private chainWrite(path: string, write: () => Promise<void>): Promise<void> {
    const normalized = normalizePath(path);
    const previous = this.writeChains.get(normalized) ?? Promise.resolve();
    const next = previous.then(write);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(normalized, tail);
    void tail.then(() => {
      if (this.writeChains.get(normalized) === tail) this.writeChains.delete(normalized);
    });
    return next;
  }

  /** Backup ONLY cipher bodies. A plaintext body must never reach the backup dir. */
  private async backupCiphertext(path: string): Promise<void> {
    try {
      const current = await this.app.vault.adapter.read(path);
      if (!current || noteBodyState(current) !== "sealed") return;
      await this.backupBeforeOverwrite(path);
    } catch {
      /* backup is best effort */
    }
  }

  /** Keep the last few versions; cipher bodies only, never plaintext. */
  private async backupBeforeOverwrite(path: string): Promise<void> {
    try {
      const current = await this.app.vault.adapter.read(path);
      if (!current || noteBodyState(current) !== "sealed") return;
      const dir = normalizePath(`${this.pluginDir}/backups/notes`);
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = path.replace(/[\\/]/g, "_");
      await this.app.vault.adapter.write(normalizePath(`${dir}/${safeName}.${stamp}.bak`), current);
      await this.pruneBackups(dir, safeName);
    } catch (error) {
      this.log.warn("backup_failed", { path, error: String(error) });
    }
  }

  private async pruneBackups(dir: string, safeName: string): Promise<void> {
    const prefix = `${safeName}.`;
    const all = (await this.app.vault.adapter.list(dir)).files
      .filter((f) => f.startsWith(`${dir}/${prefix}`))
      .sort();
    for (const stale of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
      await this.app.vault.adapter.remove(stale);
    }
  }

  /* ---------------- detection --------------------------------------------- */

  async isSealedFile(file: TFile): Promise<boolean> {
    if (file.extension !== "md") return false;
    if (this.isSealedPath(file.path)) return true;
    try {
      return noteBodyState(await this.app.vault.read(file)) === "sealed";
    } catch {
      return false;
    }
  }
}
