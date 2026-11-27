/**
 * On disk formats. Two envelopes, all versioned, all JSON or base64 text so a
 * human can audit them and tools/decrypt.html can reproduce them byte for byte.
 *
 *   1. note   - one ".sealed.md" file per private note, body IS the envelope
 *   2. inline - "sn1.<base64>" payloads inside normal markdown
 *
 * Nothing in here touches Obsidian APIs, so the tests and the offline decryptor
 * can use the exact same functions.
 */

import {
  SALT_BYTES,
  fromBase64,
  hkdfKey,
  open,
  seal,
  toBase64,
  fromUtf8,
  utf8,
} from "./crypto";

export const FORMAT_KEYRING = "sealed-note/keyring/1";
export const FORMAT_NOTE = "sealed-note/note/1";
export const INLINE_VERSION = "sn1";

/**
 * The envelope is wrapped in an HTML comment so it stays invisible in reading
 * view while remaining a single, self-contained file.
 */
export const NOTE_COMMENT_PREFIX = `<!-- ${FORMAT_NOTE}`;
export const NOTE_COMMENT_SUFFIX = "-->";

/** fenced code block languages we accept as an encrypted block */
export const INLINE_LANGS = ["encrypted_txt", "txt_encrypted", "sealed"];

/* ------------------------------------------------------------------ */
/* AAD - additional authenticated data                                 */
/* ------------------------------------------------------------------ */

/** Binds a wrapped DEK to one vault, one slot name and one generation. */
export function keyringAad(vaultId: string, slot: string, generation: number): string {
  return `sealed-note|keyring|${vaultId}|${slot}|g${generation}`;
}

/** Intentionally has no generation: password changes must not touch notes. */
export function noteAad(vaultId: string): string {
  return `sealed-note|note|${vaultId}`;
}

export function inlineAad(vaultId: string): string {
  return `sealed-note|inline|${vaultId}|v1`;
}

/* ------------------------------------------------------------------ */
/* note envelope                                                       */
/* ------------------------------------------------------------------ */

/**
 * A snapshot of the wrapped vault key, embedded in each note.
 *
 * Why this exists: keyring.json is a single file, and single files get lost -
 * `.obsidian/` is commonly excluded from sync tools, and reinstalling a plugin
 * wipes its directory. If the keyring were the only copy of the wrapped key, a
 * sync setting would silently turn every private note into noise.
 *
 * Because every note's content is encrypted under subkeys of the SAME data key,
 * one surviving note with a key copy is enough to recover the whole vault.
 *
 * This is a verbatim copy of the keyring's wrapped slots - no re-derivation, no
 * extra crypto - so writing it costs nothing beyond a few hundred bytes.
 */
export interface KeyCopy {
  epoch: number;
  vaultId: string;
  kdf: { hash: string; iterations: number };
  /** slot name -> wrapped DEK. Same shape as the keyring's slots. */
  slots: Record<string, { gen: number; salt: string; wrap: { iv: string; data: string } }>;
  /** TOTP mode travels with the notes, so a new device knows what to ask for. */
  totp?: {
    enabled: boolean;
    digits: number;
    period: number;
    mode: string;
    /** device-sealed seed; only meaningful on the device that sealed it */
    seedRef?: { iv: string; data: string };
  };
}

export interface NoteEnvelope {
  format: string;
  /** keyring id, so a note can tell you which keyring it belongs to */
  kid: string;
  salt: string;
  iv: string;
  data: string;
  /** optional redundancy: a wrapped copy of the vault key */
  keys?: KeyCopy;
}

export async function deriveNoteKey(dek: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return hkdfKey(dek, salt, "sealed-note/note/v1");
}

export async function sealNote(
  dek: Uint8Array,
  vaultId: string,
  kid: string,
  plaintext: string,
  keyCopy?: KeyCopy,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveNoteKey(dek, salt);
  const box = await seal(key, utf8(plaintext), noteAad(vaultId));
  const envelope: NoteEnvelope = {
    format: FORMAT_NOTE,
    kid,
    salt: toBase64(salt),
    iv: toBase64(box.iv),
    data: toBase64(box.data),
    ...(keyCopy ? { keys: keyCopy } : {}),
  };
  return serializeNoteEnvelope(envelope);
}

/** Render-safe on-disk form. Only the `keys` field changes on a refresh. */
export function serializeNoteEnvelope(envelope: NoteEnvelope): string {
  const json = JSON.stringify(envelope, null, 2);
  return `${NOTE_COMMENT_PREFIX}\n${json}\n${NOTE_COMMENT_SUFFIX}\n`;
}

/** Read both the comment-wrapped form and the legacy bare-JSON form. */
export function noteEnvelopeJson(text: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) return raw;
  const start = raw.indexOf(NOTE_COMMENT_PREFIX);
  if (start < 0) return null;
  const from = start + NOTE_COMMENT_PREFIX.length;
  const end = raw.indexOf(NOTE_COMMENT_SUFFIX, from);
  if (end < 0) return null;
  return raw.slice(from, end).trim() || null;
}

export function parseNoteEnvelope(text: string): NoteEnvelope | null {
  const json = noteEnvelopeJson(text);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const env = value as Record<string, unknown>;
  if (env.format !== FORMAT_NOTE) return null;
  if (typeof env.kid !== "string") return null;
  if (typeof env.salt !== "string" || typeof env.iv !== "string" || typeof env.data !== "string") {
    return null;
  }
  if (env.keys !== undefined) {
    const keys: unknown = env.keys;
    let valid = false;
    if (keys && typeof keys === "object") {
      const candidate = keys as Record<string, unknown>;
      const kdf: unknown = candidate.kdf;
      valid =
        typeof candidate.vaultId === "string" &&
        typeof candidate.epoch === "number" &&
        !!kdf &&
        typeof kdf === "object" &&
        typeof (kdf as Record<string, unknown>).iterations === "number" &&
        typeof candidate.slots === "object" &&
        candidate.slots !== null;
    }
    // A malformed key copy must not make the whole note unreadable: the content
    // is what matters, the copy is redundancy.
    if (!valid) delete env.keys;
  }
  return env as unknown as NoteEnvelope;
}

/**
 * Build the redundancy payload from a keyring. Deliberately a straight copy of
 * the already wrapped slots: no password, no DEK, nothing new to protect.
 */
export function makeKeyCopy(
  vaultId: string,
  kdf: { hash: string; iterations: number },
  epoch: number,
  slots: Record<string, { gen: number; salt: string; wrap: { iv: string; data: string } }>,
): KeyCopy {
  return { vaultId, kdf: { hash: kdf.hash, iterations: kdf.iterations }, epoch, slots };
}

/**
 * Is this already the exact key copy we would write? Used to repair notes whose
 * copy is stale in CONTENT (e.g. missing the TOTP slot) even when its epoch is
 * equal. Rewriting only the `keys` field is safe and idempotent.
 */
export function keyCopiesEqual(a: KeyCopy, b: KeyCopy): boolean {
  return (
    a.epoch === b.epoch &&
    a.vaultId === b.vaultId &&
    a.kdf.hash === b.kdf.hash &&
    a.kdf.iterations === b.kdf.iterations &&
    JSON.stringify(a.slots) === JSON.stringify(b.slots) &&
    JSON.stringify(a.totp ?? null) === JSON.stringify(b.totp ?? null)
  );
}

export function looksLikeNoteEnvelope(text: string): boolean {
  if ((text ?? "").trimStart().startsWith(NOTE_COMMENT_PREFIX)) return true;
  return text.trimStart().startsWith(`{"format":"${FORMAT_NOTE}"`) ||
    text.includes(`"${FORMAT_NOTE}"`);
}

export async function openNote(
  dek: Uint8Array,
  vaultId: string,
  envelope: NoteEnvelope,
): Promise<string> {
  const key = await deriveNoteKey(dek, fromBase64(envelope.salt));
  const plain = await open(
    key,
    { iv: fromBase64(envelope.iv), data: fromBase64(envelope.data) },
    noteAad(vaultId),
  );
  return fromUtf8(plain);
}

/* ------------------------------------------------------------------ */
/* inline payload                                                      */
/* ------------------------------------------------------------------ */

const INLINE_SALT_BYTES = 8;

export async function deriveInlineKey(dek: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return hkdfKey(dek, salt, "sealed-note/inline/v1");
}

/** Returns just the payload body, e.g. "sn1.AAAA..." */
export async function sealInline(
  dek: Uint8Array,
  vaultId: string,
  plaintext: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(INLINE_SALT_BYTES));
  const key = await deriveInlineKey(dek, salt);
  const box = await seal(key, utf8(plaintext), inlineAad(vaultId));
  const packed = new Uint8Array(salt.length + box.iv.length + box.data.length);
  packed.set(salt, 0);
  packed.set(box.iv, salt.length);
  packed.set(box.data, salt.length + box.iv.length);
  return `${INLINE_VERSION}.${toBase64(packed)}`;
}

export function normalizeInlinePayload(raw: string): string {
  return raw.replace(/[\s\r\n\t]+/g, "");
}

export async function openInline(
  dek: Uint8Array,
  vaultId: string,
  payload: string,
): Promise<string> {
  const clean = normalizeInlinePayload(payload);
  const dot = clean.indexOf(".");
  if (dot < 0) throw new Error("Not an inline payload");
  const version = clean.slice(0, dot);
  if (version !== INLINE_VERSION) throw new Error(`Unsupported inline payload ${version}`);
  const bytes = fromBase64(clean.slice(dot + 1));
  if (bytes.length < INLINE_SALT_BYTES + 12 + 16) throw new Error("Inline payload too short");
  const salt = bytes.subarray(0, INLINE_SALT_BYTES);
  const iv = bytes.subarray(INLINE_SALT_BYTES, INLINE_SALT_BYTES + 12);
  const data = bytes.subarray(INLINE_SALT_BYTES + 12);
  const key = await deriveInlineKey(dek, salt);
  const plain = await open(key, { iv, data }, inlineAad(vaultId));
  return fromUtf8(plain);
}

export function isInlinePayload(text: string): boolean {
  return /^sn1\.[A-Za-z0-9+/=]+$/.test(normalizeInlinePayload(text));
}

/* ------------------------------------------------------------------ */
/* markdown scanning helpers                                           */
/* ------------------------------------------------------------------ */

export interface FencedBlock {
  /** offsets into the source string */
  start: number;
  end: number;
  lang: string;
  payload: string;
  whole: string;
}

const fenceRe = /^([ \t]*)```([A-Za-z0-9_]*)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gm;

export function findFencedBlocks(source: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  fenceRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(source)) !== null) {
    const lang = match[2].toLowerCase();
    if (!INLINE_LANGS.includes(lang)) continue;
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      lang,
      payload: match[3].trim(),
      whole: match[0],
    });
  }
  return out;
}

/**
 * Fenced blocks whose body is still PLAINTEXT: non-empty and not an sn1
 * payload. These are the blocks a user typed by hand (or a partially
 * decrypted block) that must be sealed before the note leaves the editor.
 * Empty blocks are not "unsealed" - there is nothing to encrypt yet.
 */
export function findUnsealedBlocks(source: string): FencedBlock[] {
  return findFencedBlocks(source).filter(
    (block) => block.payload !== "" && !block.payload.startsWith(`${INLINE_VERSION}.`),
  );
}

/* ------------------------------------------------------------------ */
/* Single-file note body states (v2)                                   */
/* ------------------------------------------------------------------ */

/**
 * What a `.sealed.md` file body currently holds.
 *
 *   sealed    - the body IS the encrypted envelope (locked)
 *   revealed  - the body is plaintext (unlocked; no annotation at all)
 *   empty     - blank body, treated like `revealed` for an unlocked note
 */
export type NoteBodyState = "sealed" | "revealed" | "empty";

export function noteBodyState(text: string): NoteBodyState {
  const raw = (text ?? "").trim();
  if (!raw) return "empty";
  if (parseNoteEnvelope(text)) return "sealed";
  return "revealed";
}

/** Plaintext for a v2 unlocked note is the whole body, byte for byte. */
export function serializeNotePlain(plaintext: string): string {
  return plaintext ?? "";
}

/** `sn1:...` or `` `sn1:...` `` inline payloads. */
export function findInlinePayloads(source: string): Array<{ start: number; end: number; payload: string }> {
  const out: Array<{ start: number; end: number; payload: string }> = [];
  // No lookbehind: iOS < 16.4 does not support it. The "not part of a larger
  // token" check is done explicitly on the preceding character instead.
  const re = /`(sn1\.[A-Za-z0-9+/=]+)`|(sn1\.[A-Za-z0-9+/=]{40,})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const backticked = match[1] !== undefined;
    if (!backticked) {
      const before = match.index > 0 ? source[match.index - 1] : "";
      if (/[A-Za-z0-9+/=]/.test(before)) continue;
    }
    const payload = (match[1] || match[2] || "").trim();
    const start = backticked ? match.index + 1 : match.index;
    out.push({ start, end: start + payload.length, payload });
  }
  return out;
}

export function wrapFenced(payload: string, lang = INLINE_LANGS[0]): string {
  return "```" + lang + "\n" + payload + "\n```";
}

export function wrapInline(payload: string): string {
  return "`" + payload + "`";
}

/** Redacted preview used in lists / titles. Never derives from plaintext. */
export function redact(marker = "🔒"): string {
  return marker;
}