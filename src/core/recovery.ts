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
  if (secret.length !== 52) throw new Error("恢复密钥长度不正确");
  // throws on illegal characters
  fromBase32(secret);
}

/** Human readable file the user is told to print or store in a password manager. */
export function recoveryKeyText(opts: {
  key: string;
  vaultName: string;
  fingerprint: string;
  createdAt?: Date;
}): string {
  const when = (opts.createdAt ?? new Date()).toISOString().slice(0, 10);
  return [
    "Sealed Note — 恢复密钥",
    "======================",
    "",
    `保管库：${opts.vaultName}`,
    `生成日期：${when}`,
    `密钥指纹：${opts.fingerprint}`,
    "",
    "恢复密钥（请逐字抄录或打印，不要拍照存相册）：",
    "",
    "    " + opts.key,
    "",
    "它能做什么",
    "  · 忘记主密码时，用它重设主密码，笔记不会丢失",
    "  · 在新设备上打开你的加密笔记",
    "",
    "它不能做什么",
    "  · 不能找回你的主密码（任何工具都做不到）",
    "  · 不能替代备份：如果文件本身丢了，钥匙也救不回内容",
    "",
    "保管建议",
    "  · 打印一份放在实体安全处，或存进密码管理器",
    "  · 不要放进同一个同步盘，否则等于把钥匙和锁放在一起",
    "  · 任何拿到这串字符的人，都能打开你的加密笔记",
    "",
  ].join("\n");
}