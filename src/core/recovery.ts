/**
 * Recovery keys.
 *
 * A recovery key is 32 random bytes shown as base32 in groups of five, e.g.
 *
 *   K7QM3-XPD4W-9ZHTB-2VNR6-...
 *
 * It is a *second key*, not a password hint. It unwraps the same DEK the
 * password unwraps, which is why "reset the password with a recovery key" is
 * instant and loses nothing. It is also the whole reason a forgotten password
 * is not fatal.
 *
 * What it can NOT do: recover a password. Nothing can. See DESIGN.md.
 */

import { t } from "../i18n";
import { fromBase32, randomBytes, toBase32 } from "./crypto";
import { normalizeRecovery } from "./keyring";

const RECOVERY_BYTES = 32; // 256 bit -> 52 base32 chars
const GROUP = 5;

export function generateRecoveryKey(): string {
  const raw = toBase32(randomBytes(RECOVERY_BYTES)).slice(0, 52);
  return groupRecovery(raw);
}

export function groupRecovery(raw: string): string {
  return (raw.match(new RegExp(`.{1,${GROUP}}`, "g")) || []).join("-");
}

/** Strip formatting; that is what actually goes into PBKDF2. */
export function recoverySecret(raw: string): string {
  return normalizeRecovery(raw);
}

export function assertRecoveryKey(raw: string): void {
  const secret = recoverySecret(raw);
  if (secret.length !== 52) throw new Error(t("error.recoveryLength"));
  // throws on illegal characters
  fromBase32(secret);
}

