/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 second step) with a +/-1 step window.
 *
 * The seed is never stored in the vault. See providers.ts / keyring.ts: keeping
 * it out of the synced keyring is what makes this a real second factor rather
 * than a second password.
 */

import { fromBase32, hmacSha1, toBase32, utf8, randomBytes } from "./crypto";

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW = 1;

export function generateTotpSecret(): string {
  // 20 bytes = 160 bit, the length recommended by RFC 4226.
  return toBase32(randomBytes(20));
}

export interface TotpOptions {
  digits?: number;
  step?: number;
  /** unix ms, injectable so tests are deterministic */
  now?: number;
}

export async function totpCode(
  secret: string,
  { digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS, now = Date.now() }: TotpOptions = {},
): Promise<string> {
  const counter = Math.floor(now / 1000 / step);
  const key = fromBase32(secret);
  const msg = new Uint8Array(8);
  // 64 bit big endian counter; JS numbers are safe for far longer than needed.
  let value = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const hmac = await hmacSha1(key, msg);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Verify a user supplied code, allowing one step of clock drift either way. */
export async function verifyTotp(
  secret: string,
  input: string,
  opts: TotpOptions = {},
): Promise<boolean> {
  const cleaned = (input || "").replace(/\D/g, "");
  if (cleaned.length !== (opts.digits ?? TOTP_DIGITS)) return false;
  const step = opts.step ?? TOTP_STEP_SECONDS;
  const now = opts.now ?? Date.now();
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const expected = await totpCode(secret, {
      ...opts,
      now: now + drift * step * 1000,
    });
    if (timingSafe(expected, cleaned)) return true;
  }
  return false;
}

function timingSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function totpRemainingSeconds(now = Date.now(), step = TOTP_STEP_SECONDS): number {
  const elapsed = Math.floor(now / 1000) % step;
  return step - elapsed;
}

/** otpauth:// URI so any authenticator app can be used. */
export function totpUri(secret: string, account: string, issuer = "Sealed Note"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Group a base32 secret into readable chunks for manual entry. */
export function formatSecret(secret: string, group = 4): string {
  return (secret.match(new RegExp(`.{1,${group}}`, "g")) || []).join(" ");
}

/** Keep the seed out of sync engines and out of any exported data. */
export function describeTotpSecretForDisplay(secret: string): string {
  void utf8; // keep import tree stable for bundlers
  return formatSecret(secret, 4);
}