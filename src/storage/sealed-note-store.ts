/**
 * Reading and writing private notes.
 *
 * v2 format (this version): the .sealed.md file body IS the encrypted note
 * envelope (an HTML comment wrapping JSON). Renaming, moving or syncing the
 * note can never separate it from its ciphertext: there is no sidecar file and
 * no reference annotation. Unlocking replaces the body with bare plaintext;
 * locking replaces it with the envelope again.
 *
 * v1 sidecar format (ref annotation + sealed-data/*.sealedpayload) is READABLE
 * for migration only. The `migrateToSingleFile` command converts it in place.
 *
 * Invariants: cipher bytes are backed up before an overwrite, plaintext never
 * is, and body writes go through vault.modify so the Obsidian editor buffer
 * stays in sync with disk.
 */

import { App, TFile, normalizePath } from "obsidian";
import {
  PAYLOAD_EXTENSION,
  KeyCopy,
  NoteEnvelope,
  noteBodyState,
  openNote,
  parseNoteEnvelope,
  parseNoteRef,
  parseRevealedBody,
  sealNote,
  serializeNoteEnvelope,
  serializeNotePayload,
  serializeNotePlain,
} from "../core/format";
import { KeyringData, keyCopyFromKeyringData } from "../core/keyring";
import { randomUuid } from "../core/crypto";
import { Err, describeError } from "../util/errors";
import { log } from "../util/log";

export const SEALED_EXTENSION = "sealed.md";
export const DEFAULT_PAYLOAD_DIR = "sealed-data";
const KEEP_BACKUPS = 5;

export interface EnvelopeSource {
  envelope: NoteEnvelope;
  /** old sidecar file, only present while migrating a v1 note */
  payload?: TFile;
  /** true when the note is still in the old sidecar format */
  legacy: boolean;
  ref?: string;
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

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
    private readonly getPayloadDir: () => string = () => DEFAULT_PAYLOAD_DIR,
  ) {}

  /** Retained so existing callers keep working; v2 has no annotation hint. */
  setPlaceholderHint(_text: string): void {}

  /* ---------------- paths ------------------------------------------------- */

  isSealedPath(path: string): boolean {
    return path.toLowerCase().endsWith(`.${SEALED_EXTENSION}`);
  }

  isPayloadPath(path: string): boolean {
    return path.toLowerCase().endsWith(PAYLOAD_EXTENSION);
  }

  /** Notes and payloads both carry key copies; both are key sources. */
  isKeySourcePath(path: string): boolean {
    return this.isPayloadPath(path) || this.isSealedPath(path);
  }

  payloadDir(): string {
    return normalizePath(this.getPayloadDir().trim() || DEFAULT_PAYLOAD_DIR);
  }

  payloadPath(ref: string): string {
    return normalizePath(`${this.payloadDir()}/${ref}${PAYLOAD_EXTENSION}`);
  }

  private getPayloadFile(ref: string): TFile | null {
    return (this.app.vault.getAbstractFileByPath(this.payloadPath(ref)) as TFile) ?? null;
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
    if (existing) throw Err.io(`同名文件已存在：${normalized}`);

    const copy = kr.keyring ? keyCopyFromKeyringData(kr.keyring) : undefined;
    // The revealed note will open as a clean blank editor, exactly like
    // Obsidian's own "New note". Locked body already carries the ciphertext.
    const sealed = parseNoteEnvelope(await sealNote(dek, kr.vaultId, kr.kid, "", copy));
    if (!sealed) throw Err.io("无法生成加密笔记信封");

    await this.ensureFolder(normalized);
    const file = await this.app.vault.create(normalized, serializeNoteEnvelope(sealed));
    this.log.info("sealed_note_created", { path: normalized });
    return file;
  }

  /* ---------------- read -------------------------------------------------- */

  async readCiphertext(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  /** Envelope from the note body itself; v1 sidecars stay readable for migration. */
  async tryReadEnvelope(file: TFile): Promise<NoteEnvelope | null> {
    const raw = await this.app.vault.read(file).catch(() => "");
    const state = noteBodyState(raw);
    if (state === "sealed") return parseNoteEnvelope(raw);
    if (state === "sidecar-ref") {
      const payload = this.getPayloadFile(parseNoteRef(raw)!);
      if (!payload) return null;
      return parseNoteEnvelope(await this.app.vault.read(payload));
    }
    if (this.isPayloadPath(file.path)) return parseNoteEnvelope(raw);
    return null;
  }

  async resolveEnvelope(file: TFile): Promise<EnvelopeSource> {
    const raw = await this.readCiphertext(file);
    const state = noteBodyState(raw);
    if (state === "sealed") {
      const envelope = parseNoteEnvelope(raw);
      if (!envelope) throw Err.badEnvelope(file.path);
      return { envelope, legacy: false };
    }
    if (state === "sidecar-ref") {
      const ref = parseNoteRef(raw)!;
      const path = this.payloadPath(ref);
      const payload = this.getPayloadFile(ref);
      if (!payload) throw Err.payloadMissing(path);
      const envelope = parseNoteEnvelope(await this.app.vault.read(payload));
      if (!envelope) throw Err.badEnvelope(path);
      return { envelope, payload, legacy: true, ref };
    }
    if (this.isPayloadPath(file.path)) {
      const envelope = parseNoteEnvelope(raw);
      if (!envelope) throw Err.badEnvelope(file.path);
      return { envelope, legacy: true };
    }
    throw Err.badEnvelope(file.path);
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
    if (!sealed) throw Err.io("无法生成加密笔记信封");
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

  /**
   * A pre-key-copy note whose envelope sits bare in the body is already v2
   * shaped: just re-serialise it with the comment wrapper. No sidecar involved.
   */
  async migrateLegacy(file: TFile, envelope?: NoteEnvelope): Promise<boolean> {
    const raw = await this.app.vault.read(file);
    if (noteBodyState(raw) !== "revealed") return false;
    const env = envelope ?? parseNoteEnvelope(raw);
    if (!env) throw Err.badEnvelope(file.path);
    await this.chainWrite(file.path, () => this.app.vault.modify(file, serializeNoteEnvelope(env)));
    this.log.info("note_migrated", { path: file.path });
    return true;
  }

  /** v1 migration helper: read-only source payload; never created by v2. */
  async readPayload(ref: string): Promise<{ file: TFile; envelope: NoteEnvelope } | null> {
    const payload = this.getPayloadFile(ref);
    if (!payload) return null;
    const envelope = parseNoteEnvelope(await this.app.vault.read(payload));
    return envelope ? { file: payload, envelope } : null;
  }

  /** v1 migration: replace a ref annotation body with the envelope body. */
  async replaceBodyWithEnvelope(file: TFile, envelope: NoteEnvelope): Promise<void> {
    await this.chainWrite(file.path, () =>
      this.app.vault.modify(file, serializeNoteEnvelope(envelope)),
    );
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
    // A v1 placeholder is a locked note too; only real plaintext counts.
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

  /** v1 migration only: remove a sidecar payload after its envelope was moved. */
  async deletePayload(ref: string): Promise<boolean> {
    const path = this.payloadPath(ref);
    if (!(await this.app.vault.adapter.exists(path))) return false;
    await this.app.vault.adapter.remove(path);
    this.log.info("payload_deleted", { path });
    return true;
  }

  /**
   * Serialise writes to one path. An autosave flush racing a lock re-seal must
   * never interleave; the chain keeps a strict order per file. Unlike v1's
   * adapter swap there are no scratch files here: body writes go through
   * vault.modify so the editor buffer stays in sync with disk.
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

  private async writeAndSwap(path: string, content: string): Promise<void> {
    await this.backupBeforeOverwrite(path);
    const adapter = this.app.vault.adapter;
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = normalizePath(`${path}.${token}.tmp`);
    const prev = normalizePath(`${path}.${token}.old`);
    let moved = false;

    await adapter.write(tmp, content);
    try {
      if (!(await adapter.exists(path))) {
        await adapter.rename(tmp, path);
        return;
      }
      await adapter.rename(path, prev);
      moved = true;
      await adapter.rename(tmp, path);
    } catch (error) {
      if (moved) await adapter.rename(prev, path).catch(() => undefined);
      this.log.warn("atomic_write_fallback", { path, error: String(error) });
      await this.overwrite(path, content);
    } finally {
      await adapter.remove(tmp).catch(() => undefined);
      if (moved) await adapter.remove(prev).catch(() => undefined);
      await this.sweepScratchFiles(path);
    }
  }

  private async overwrite(path: string, content: string): Promise<void> {
    try {
      await this.app.vault.adapter.write(path, content);
    } catch (error) {
      throw Err.io(`无法写入加密数据（${path}）：${describeError(error)}`, { path });
    }
  }

  /**
   * Remove the fixed-name scratch files older builds left behind. Best effort:
   * a sidecar another process still holds open is retried on the next write.
   */
  private async sweepScratchFiles(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    for (const legacy of [`${path}.tmp`, `${path}.old`]) {
      const full = normalizePath(legacy);
      try {
        if (await adapter.exists(full)) await adapter.remove(full);
      } catch {
        /* still open elsewhere - harmless */
      }
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
    if (this.isSealedPath(file.path)) return true;
    if (this.isPayloadPath(file.path)) return false;
    if (file.extension !== "md") return false;
    try {
      return noteBodyState(await this.app.vault.read(file)) === "sealed";
    } catch {
      return false;
    }
  }
}
