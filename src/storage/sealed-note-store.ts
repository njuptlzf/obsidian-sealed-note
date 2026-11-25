/**
 * Reading and writing private notes.
 *
 * New format: the Markdown file contains only a visible placeholder and an
 * opaque ID; the JSON envelope (keys, salt, IV, ciphertext) lives in a sidecar
 * payload file under `sealed-data/`. Moving or renaming the note cannot break
 * the link, and no envelope bytes ever appear in the note source.
 *
 * Legacy format (envelope inside an HTML comment, or bare JSON) is still
 * readable; saving a legacy note migrates it automatically.
 *
 * Invariants: plaintext is never written to disk, writes are atomic where the
 * file system allows it (with a plain-overwrite fallback, see atomicWrite), and
 * the previous bytes are backed up before an overwrite.
 */

import { App, TFile, normalizePath } from "obsidian";
import {
  PAYLOAD_EXTENSION,
  KeyCopy,
  NoteEnvelope,
  looksLikeNoteEnvelope,
  openNote,
  parseNoteEnvelope,
  parseNoteRef,
  parseRevealedBody,
  sealNote,
  serializeNoteEnvelope,
  serializeNotePayload,
  serializeNotePlaceholder,
  serializeNoteRevealed,
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
  /** payload file when the note uses the sidecar format */
  payload?: TFile;
  /** true when the envelope still lives inside the note */
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
  /** reuse an ID if the note write after payload creation failed */
  private readonly pendingRefs = new Map<string, string>();
  /** note path -> payload ID, survives the note being deleted */
  private readonly refByPath = new Map<string, string>();
  /** per-path write chain: two saves of one file must never interleave */
  private readonly writeChains = new Map<string, Promise<void>>();
  private placeholderHint = "🔒 这是一篇隐私笔记，请用插件解锁查看。";

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
    private readonly getPayloadDir: () => string = () => DEFAULT_PAYLOAD_DIR,
  ) {}

  setPlaceholderHint(text: string): void {
    if (text?.trim()) this.placeholderHint = text;
  }

  /** Full annotation body for a ref (used when restoring a deleted ref). */
  placeholderWithRef(ref: string): string {
    return serializeNotePlaceholder(ref, this.placeholderHint);
  }

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

  /** Create a placeholder note plus its encrypted payload. */
  async create(
    kr: { vaultId: string; kid: string; keyring?: KeyringData },
    dek: Uint8Array,
    path: string,
    title: string,
    placeholderHint?: string,
  ): Promise<TFile> {
    const normalized = normalizePath(this.withExtension(path));
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing) throw Err.io(`同名文件已存在：${normalized}`);

    const copy = kr.keyring ? keyCopyFromKeyringData(kr.keyring) : undefined;
    // Start with a truly empty body: the revealed note opens as a clean blank
    // editor, exactly like Obsidian's own "New note".
    const sealed = parseNoteEnvelope(await sealNote(dek, kr.vaultId, kr.kid, "", copy));
    if (!sealed) throw Err.io("无法生成加密笔记信封");
    const ref = randomUuid();
    this.refByPath.set(normalized, ref);

    await this.ensureFolder(normalized);
    await this.ensureFolder(this.payloadPath(ref));
    await this.createPayload(ref, serializeNotePayload(sealed));

    const noteContent = serializeNotePlaceholder(ref, placeholderHint ?? this.placeholderHint);
    try {
      const file = await this.app.vault.create(normalized, noteContent);
      this.log.info("sealed_note_created", { path: normalized, ref });
      return file;
    } catch (error) {
      // Do not leave an orphan payload behind on a failed create.
      await this.app.vault.adapter.remove(this.payloadPath(ref)).catch(() => undefined);
      this.refByPath.delete(normalized);
      throw error;
    }
  }

  /* ---------------- read -------------------------------------------------- */

  async readCiphertext(file: TFile): Promise<string> {
    return this.app.vault.read(file);
  }

  /** Envelope from either a payload file or a note (legacy or ref-based). */
  async tryReadEnvelope(file: TFile): Promise<NoteEnvelope | null> {
    if (this.isPayloadPath(file.path)) {
      return parseNoteEnvelope(await this.app.vault.read(file));
    }
    const raw = await this.app.vault.read(file);
    const ref = parseNoteRef(raw);
    if (ref) {
      this.refByPath.set(file.path, ref);
      const payload = this.getPayloadFile(ref);
      if (!payload) return null;
      return parseNoteEnvelope(await this.app.vault.read(payload));
    }
    return parseNoteEnvelope(raw);
  }

  async resolveEnvelope(file: TFile): Promise<EnvelopeSource> {
    if (this.isPayloadPath(file.path)) {
      const envelope = parseNoteEnvelope(await this.app.vault.read(file));
      if (!envelope) throw Err.badEnvelope(file.path);
      return { envelope, legacy: false };
    }
    const raw = await this.readCiphertext(file);
    const ref = parseNoteRef(raw);
    if (ref) {
      this.refByPath.set(file.path, ref);
      const path = this.payloadPath(ref);
      const payload = this.getPayloadFile(ref);
      if (!payload) throw Err.payloadMissing(path);
      const envelope = parseNoteEnvelope(await this.app.vault.read(payload));
      if (!envelope) throw Err.badEnvelope(path);
      return { envelope, payload, legacy: false, ref };
    }
    const envelope = parseNoteEnvelope(raw);
    if (!envelope) throw Err.badEnvelope(file.path);
    return { envelope, legacy: true };
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
   * Encrypt and write. A ref-based note keeps its payload and its Markdown
   * placeholder untouched; a legacy note is migrated on first save.
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
    const payloadText = serializeNotePayload(sealed);

    if (this.isPayloadPath(file.path)) {
      await this.atomicWrite(file, payloadText);
      return;
    }

    const raw = await this.app.vault.read(file).catch(() => "");
    const ref =
      parseNoteRef(raw) ?? this.pendingRefs.get(file.path) ?? undefined;
    if (ref) {
      this.refByPath.set(file.path, ref);
      const payload = this.getPayloadFile(ref);
      if (payload) await this.atomicWrite(payload, payloadText);
      else await this.createPayload(ref, payloadText);
      this.pendingRefs.delete(file.path);
      return;
    }

    // Legacy note: write the payload first, then replace the note body. If the
    // second write fails, the remembered ref lets the next save retry safely.
    const newRef = randomUuid();
    this.pendingRefs.set(file.path, newRef);
    this.refByPath.set(file.path, newRef);
    await this.createPayload(newRef, payloadText);
    await this.atomicWrite(file, serializeNotePlaceholder(newRef, this.placeholderHint));
    this.pendingRefs.delete(file.path);
    this.log.info("note_migrated_on_save", { path: file.path, ref: newRef });
  }

  /** Replace only the `keys` field; salt/IV/data are copied verbatim. */
  async updateKeyCopy(
    file: TFile,
    envelope: NoteEnvelope,
    keyCopy: KeyCopy,
  ): Promise<void> {
    const updated: NoteEnvelope = { ...envelope, keys: keyCopy };
    if (this.isPayloadPath(file.path)) {
      await this.atomicWrite(file, serializeNotePayload(updated));
      return;
    }
    const raw = await this.app.vault.read(file).catch(() => "");
    const ref = parseNoteRef(raw);
    if (ref) {
      const payload = this.getPayloadFile(ref);
      if (payload) await this.atomicWrite(payload, serializeNotePayload(updated));
      else await this.createPayload(ref, serializeNotePayload(updated));
      return;
    }
    // Old notes keep their hidden envelope until migrated.
    await this.atomicWrite(file, serializeNoteEnvelope(updated));
  }

  /** Move an old note's envelope into a payload and leave a clean placeholder. */
  async migrateLegacy(file: TFile, envelope?: NoteEnvelope): Promise<boolean> {
    if (this.isPayloadPath(file.path)) return false;
    const raw = await this.app.vault.read(file);
    if (parseNoteRef(raw)) return false;
    const env = envelope ?? parseNoteEnvelope(raw);
    if (!env) throw Err.badEnvelope(file.path);
    const ref = randomUuid();
    this.refByPath.set(file.path, ref);
    await this.createPayload(ref, serializeNotePayload(env));
    await this.atomicWrite(file, serializeNotePlaceholder(ref, this.placeholderHint));
    this.log.info("note_migrated", { path: file.path, ref });
    return true;
  }

  async createPayload(ref: string, content: string): Promise<TFile> {
    const path = this.payloadPath(ref);
    await this.ensureFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      const file = existing as TFile;
      await this.atomicWrite(file, content);
      return file;
    }
    return this.app.vault.create(path, content);
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.split("/").slice(0, -1).join("/");
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  /* ---------------- in-place reveal / reseal ------------------------------ */

  /**
   * In-place editing model: an unlocked note's body IS the plaintext (ref line
   * kept on top). No working-copy file is ever written - a plaintext file in
   * any folder is readable without a password, which defeats the point.
   */

  /** True when a note body currently holds revealed plaintext (unlocked). */
  isRevealedText(text: string): boolean {
    return parseRevealedBody(text) !== null;
  }

  /** Decrypt the payload and write the plaintext into the note body, in place. */
  async revealNote(file: TFile, dek: Uint8Array, vaultId: string): Promise<void> {
    const raw = await this.app.vault.read(file);
    const ref = parseNoteRef(raw);
    if (!ref) throw Err.io(`无法读取笔记 ID：${file.path}`);
    const plaintext = parseRevealedBody(raw);
    if (plaintext !== null) {
      // Already revealed; nothing to do (idempotent unlock).
      return;
    }
    const body = await this.readPlaintext(file, dek, vaultId);
    await this.app.vault.modify(file, serializeNoteRevealed(ref, body));
    this.log.info("note_revealed", { path: file.path });
  }

  /**
   * Encrypt the note's current plaintext into the payload, then restore the
   * placeholder body. Idempotent: a locked note with no plaintext is skipped.
   */
  async reSealNote(
    file: TFile,
    dek: Uint8Array,
    vaultId: string,
    kid: string,
    keyring?: KeyringData,
  ): Promise<void> {
    const raw = await this.app.vault.read(file);
    const ref = parseNoteRef(raw);
    if (!ref) throw Err.io(`无法读取笔记 ID：${file.path}`);
    const plaintext = parseRevealedBody(raw);
    if (plaintext === null) return; // already locked
    await this.writePlaintext(file, dek, vaultId, kid, plaintext, keyring);
    await this.app.vault.modify(file, serializeNotePlaceholder(ref, this.placeholderHint));
    this.log.info("note_resealed", { path: file.path });
  }

  /** Plaintext currently sitting in a revealed note body (not the payload). */
  async readRevealedBody(file: TFile): Promise<string> {
    const raw = await this.app.vault.read(file);
    const body = parseRevealedBody(raw);
    return body ?? "";
  }

  /* ---------------- lifecycle -------------------------------------------- */

  /** Remembered ID for a note, used when the delete event can no longer read it. */
  refForPath(path: string): string | undefined {
    return this.refByPath.get(path);
  }

  forgetPath(path: string): void {
    this.refByPath.delete(path);
    this.pendingRefs.delete(path);
  }

  /** Carry cached IDs/migration state across a vault rename. */
  moveRef(from: string, to: string): void {
    const ref = this.refByPath.get(from);
    if (ref) this.refByPath.set(to, ref);
    this.refByPath.delete(from);
    const pending = this.pendingRefs.get(from);
    if (pending) this.pendingRefs.set(to, pending);
    this.pendingRefs.delete(from);
  }

  async deletePayload(ref: string): Promise<boolean> {
    const path = this.payloadPath(ref);
    if (!(await this.app.vault.adapter.exists(path))) return false;
    await this.app.vault.adapter.remove(path);
    this.log.info("payload_deleted", { path });
    return true;
  }

  /** Payload files under the configured folder with no surviving note. */
  async orphanPayloads(): Promise<TFile[]> {
    const refs = new Set<string>(this.refByPath.values());
    for (const file of this.app.vault.getFiles()) {
      if (!this.isSealedPath(file.path)) continue;
      const raw = await this.app.vault.read(file).catch(() => "");
      const ref = parseNoteRef(raw);
      if (ref) refs.add(ref);
    }
    const prefix = normalizePath(`${this.payloadDir()}/`);
    return this.app.vault.getFiles().filter((file) => {
      if (!this.isPayloadPath(file.path) || !file.path.startsWith(prefix)) return false;
      const ref = file.path.slice(prefix.length, -PAYLOAD_EXTENSION.length);
      return !refs.has(ref);
    });
  }

  /**
   * Replace a file's contents, atomically where the file system allows it.
   *
   * Obsidian's `DataAdapter.rename` refuses to clobber an existing destination
   * ("Destination file already exists!", verified in obsidian.asar), so a live
   * file cannot be replaced by a single `rename(tmp, path)`. What works is a
   * two-step swap: move the target aside, move the new bytes in, drop the
   * sidecar. Every instant still has a complete file at `path`.
   *
   * Two rules make that swap survive the real world. Both were learned from a
   * bug that popped "Destination file already exists!" on EVERY save:
   *
   *  1. Scratch names are unique per write. With a fixed `<path>.tmp` and
   *     `<path>.old`, one leftover from a crashed write - or a sidecar a sync
   *     client still holds open, which Windows keeps in delete-pending so the
   *     NAME stays taken - makes every later write fail, permanently.
   *  2. Writes of the same path are serialised. An autosave flush racing the
   *     lock-on-blur re-seal would otherwise interleave the two renames and
   *     consume each other's scratch files.
   *
   * If the swap still cannot complete, a plain overwrite is the last resort:
   * the previous bytes are already in the backup, and a save that never lands
   * is worse than one that is not atomic.
   */
  private atomicWrite(file: TFile, content: string): Promise<void> {
    const path = normalizePath(file.path);
    const previous = this.writeChains.get(path) ?? Promise.resolve();
    const next = previous.then(() => this.writeAndSwap(path, content));
    // The chain continues after a failure (one bad write must not poison the
    // next one) and is dropped once this write is the last one queued.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(path, tail);
    void tail.then(() => {
      if (this.writeChains.get(path) === tail) this.writeChains.delete(path);
    });
    return next;
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

  /** Keep the last few versions; ciphertext only. */
  private async backupBeforeOverwrite(path: string): Promise<void> {
    try {
      const current = await this.app.vault.adapter.read(path);
      if (!current) return;
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
      return looksLikeNoteEnvelope(await this.app.vault.read(file));
    } catch {
      return false;
    }
  }
}
