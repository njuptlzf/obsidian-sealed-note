/**
 * Reading and writing ".sealed" notes.
 *
 * Everything that touches a private note's bytes goes through here, so the
 * invariants live in one place:
 *   - plaintext is never written to disk, not even briefly
 *   - writes are atomic (temp + rename)
 *   - the previous ciphertext is kept as a backup before an overwrite
 */

import { App, TFile, normalizePath } from "obsidian";
import {
  parseNoteEnvelope,
  sealNote,
  openNote,
  looksLikeNoteEnvelope,
  makeKeyCopy,
  KeyCopy,
  NoteEnvelope,
} from "../core/format";
import { KeyringData } from "../core/keyring";
import { Err } from "../util/errors";
import { log } from "../util/log";

export const SEALED_EXTENSION = "sealed.md";
const KEEP_BACKUPS = 5;

/**
 * Snapshot the wrapped key for embedding into a note.
 *
 * The keyring carries `totp.seedRef`, which is sealed with a device key that is
 * NOT in the vault, so copying it is pointless on another machine. We copy only
 * the slots that are portable: password and recovery.
 */
export function keyCopyFromKeyring(keyring: KeyringData): KeyCopy {
  const slots: KeyCopy["slots"] = {};
  for (const name of ["password", "recovery"] as const) {
    const cell = keyring.slots[name];
    if (!cell) continue;
    slots[name] = { gen: cell.gen, salt: cell.salt, wrap: cell.wrap };
  }
  return makeKeyCopy(keyring.vaultId, keyring.kdf, keyring.epoch, slots);
}

export class SealedNoteStore {
  private readonly log = log.child("sealed-note-store");

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
  ) {}

  isSealedPath(path: string): boolean {
    return path.toLowerCase().endsWith(`.${SEALED_EXTENSION}`);
  }

  /* ---------------- create ------------------------------------------------ */

  /** Create an empty sealed note. The initial body is encrypted immediately. */
  async create(
    kr: { vaultId: string; kid: string; keyring?: KeyringData },
    dek: Uint8Array,
    path: string,
    title: string,
  ): Promise<TFile> {
    const normalized = normalizePath(this.withExtension(path));
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) throw Err.io(`同名文件已存在：${normalized}`);

    const initial = `# ${title}\n\n`;
    const copy = kr.keyring ? keyCopyFromKeyring(kr.keyring) : undefined;
    const cipher = await sealNote(dek, kr.vaultId, kr.kid, initial, copy);
    const dir = normalized.split("/").slice(0, -1).join("/");
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const file = await this.app.vault.create(normalized, cipher);
    this.log.info("sealed_note_created", { path: normalized });
    return file;
  }

  withExtension(path: string): string {
    return this.isSealedPath(path) ? path : `${path}.${SEALED_EXTENSION}`;
  }

  /* ---------------- read -------------------------------------------------- */

  async readCiphertext(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  /** Decrypt a note. Throws if the file is not a sealed envelope. */
  async readPlaintext(file: TFile, dek: Uint8Array, vaultId: string): Promise<string> {
    const raw = await this.readCiphertext(file);
    const envelope = parseNoteEnvelope(raw);
    if (!envelope) throw Err.badEnvelope(file.path);
    if (envelope.kid && envelope.kid !== vaultId) {
      // Not fatal on its own (a vault can be copied), but worth surfacing: the
      // AAD check below will fail anyway if it is genuinely another keyring.
      this.log.warn("note_kid_mismatch", { path: file.path, kid: envelope.kid, vaultId });
    }
    return openNote(dek, vaultId, envelope);
  }

  /* ---------------- write ------------------------------------------------- */

  /**
   * Encrypt and write. `keyring` is used to embed a fresh key copy on every
   * save, so a note created under an older password generation carries the
   * current one without needing a separate migration pass.
   */
  async writePlaintext(
    file: TFile,
    dek: Uint8Array,
    vaultId: string,
    kid: string,
    plaintext: string,
    keyring?: KeyringData,
  ): Promise<void> {
    const copy = keyring ? keyCopyFromKeyring(keyring) : undefined;
    const cipher = await sealNote(dek, vaultId, kid, plaintext, copy);
    await this.atomicWrite(file, cipher);
  }

  /**
   * Replace ONLY the `keys` field of a note envelope. The ciphertext, salt and
   * IV are copied through byte for byte, so an interrupted batch can never
   * damage note contents - the worst case is a stale key copy, which is exactly
   * what the next run will fix.
   */
  async updateKeyCopy(
    file: TFile,
    envelope: NoteEnvelope,
    keyCopy: KeyCopy,
  ): Promise<void> {
    const updated: NoteEnvelope = { ...envelope, keys: keyCopy };
    await this.atomicWrite(file, JSON.stringify(updated, null, 2) + "\n");
  }

  private async atomicWrite(file: TFile, content: string): Promise<void> {
    await this.backupBeforeOverwrite(file);
    const tmp = normalizePath(`${file.path}.tmp`);
    // adapter.write + rename is atomic on every platform Obsidian supports.
    await this.app.vault.adapter.write(tmp, content);
    await this.app.vault.adapter.rename(tmp, file.path);
  }

  /**
   * Keep the last few ciphertext versions. Cheap (ciphertext only), and it is
   * the difference between "a bug ate my note" and "I lost a week".
   */
  private async backupBeforeOverwrite(file: TFile): Promise<void> {
    try {
      const current = await this.app.vault.adapter.read(file.path);
      if (!current) return;
      const dir = normalizePath(`${this.pluginDir}/backups/notes`);
      if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeName = file.path.replace(/[\\/]/g, "_");
      await this.app.vault.adapter.write(normalizePath(`${dir}/${safeName}.${stamp}.bak`), current);
      await this.pruneBackups(dir, safeName);
    } catch (error) {
      // A failed backup must never block the save the user asked for.
      this.log.warn("backup_failed", { path: file.path, error: String(error) });
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
    if (this.isSealedPath(file.path)) return true;
    // Also honour a .md file whose whole content is an envelope, so a renamed
    // file does not silently show as gibberish.
    if (file.extension !== "md") return false;
    try {
      return looksLikeNoteEnvelope(await this.app.vault.read(file));
    } catch {
      return false;
    }
  }
}