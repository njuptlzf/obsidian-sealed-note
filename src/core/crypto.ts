/**
 * Low level cryptography helpers.
 *
 * Everything here goes through the Web Crypto API (`crypto.subtle`) so the exact
 * same code runs inside Obsidian (Electron) and inside a plain browser page
 * (see tools/decrypt.html). No third party crypto dependencies, no WASM.
 *
 * Primitives
 *  - AES-256-GCM  : authenticated encryption, 12 byte IV, 16 byte tag
 *  - PBKDF2-HMAC-SHA512 : slow, used only for human supplied secrets
 *  - HKDF-SHA256  : fast, used to derive per-note / per-block subkeys from the
 *                   vault data key
 */

export const IV_BYTES = 12;
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const TAG_BITS = 128;

// The Web Crypto global is available in Obsidian and in the Node-based tests
// that exercise these primitives directly. Accessing it by its bare name keeps
// popout windows working (no reliance on a specific window object).
const webcrypto: Crypto = crypto;
const subtle: SubtleCrypto = webcrypto.subtle;

/**
 * TypeScript 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, which is not
 * assignable to BufferSource (it could be backed by a SharedArrayBuffer). All
 * our buffers are ordinary ones, so this narrows the type without copying.
 */
export function buf(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/* ------------------------------------------------------------------ */
/* encoding helpers                                                    */
/* ------------------------------------------------------------------ */

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const clean = stripWhitespace(b64);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function stripWhitespace(value: string): string {
  return (value || "").replace(/[\s\r\n\t]+/g, "");
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* randomness                                                          */
/* ------------------------------------------------------------------ */

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  webcrypto.getRandomValues(out);
  return out;
}

export function randomHex(length: number): string {
  return Array.from(randomBytes(Math.ceil(length / 2)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** RFC 4122 v4 uuid, used to identify the keyring and encrypted notes. */
export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* key derivation                                                      */
/* ------------------------------------------------------------------ */

export interface KdfParams {
  /** PBKDF2 iteration count. Stored with every keyring so it can be raised later. */
  iterations: number;
  hash: "SHA-256" | "SHA-512";
}

export const DEFAULT_KDF: KdfParams = { iterations: 600000, hash: "SHA-512" };

/**
 * Turn a human secret (password / recovery key) into a 256 bit key encryption
 * key. Deliberately slow: this is the only defence against offline guessing.
 */
export async function deriveKeyFromSecret(
  secret: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", buf(utf8(secret)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: buf(salt),
      iterations: params.iterations,
      hash: params.hash,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Fast subkey derivation from an already high entropy key. */
export async function hkdfKey(
  baseKey: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", buf(baseKey), "HKDF", false, [
    "deriveKey",
  ]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function hkdfBytes(
  baseKey: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Promise<Uint8Array> {
  const material = await subtle.importKey("raw", buf(baseKey), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(utf8(info)) },
    material,
    length * 8,
  );
  return new Uint8Array(bits);
}

/* ------------------------------------------------------------------ */
/* authenticated encryption                                            */
/* ------------------------------------------------------------------ */

export interface SealedBox {
  iv: Uint8Array;
  /** ciphertext with the 16 byte GCM tag appended */
  data: Uint8Array;
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: string,
): Promise<SealedBox> {
  const iv = randomBytes(IV_BYTES);
  const cipher = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv: buf(iv),
      tagLength: TAG_BITS,
      ...(aad ? { additionalData: buf(utf8(aad)) } : {}),
    },
    key,
    buf(plaintext),
  );
  return { iv, data: new Uint8Array(cipher) };
}

export async function open(
  key: CryptoKey,
  box: SealedBox,
  aad?: string,
): Promise<Uint8Array> {
  try {
    const plain = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buf(box.iv),
        tagLength: TAG_BITS,
        ...(aad ? { additionalData: buf(utf8(aad)) } : {}),
      },
      key,
      buf(box.data),
    );
    return new Uint8Array(plain);
  } catch {
    // Never leak the underlying error: it would tell an attacker whether the
    // key was wrong or the ciphertext was tampered with.
    throw new DecryptError();
  }
}

export class DecryptError extends Error {
  constructor(message = "Unable to decrypt: wrong secret or damaged data") {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * A keyring entry is the wrapped vault data key. The AAD binds it to the
 * keyring identity and to the slot that produced it, so blobs cannot be
 * transplanted between slots or between vaults.
 */
export function slotAad(vaultId: string, slot: string, generation: number): string {
  return `sealed-note|keyring|${vaultId}|${slot}|g${generation}`;
}

/** Base32 (RFC 4648, no padding) - used for recovery keys and TOTP secrets. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** HMAC-SHA1, required by RFC 6238 (TOTP). */
export async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey(
    "raw",
    buf(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", k, buf(message)));
}

export function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}