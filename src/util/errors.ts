import { t } from "../i18n";
/** Typed errors, and the only place user facing wording lives. */

export class SealedNoteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SealedNoteError";
  }
}

export const Err = {
  notInitialized: () =>
    new SealedNoteError("E_NOT_INIT", "还没有设置主密码，请先完成初始化"),
  locked: () =>
    new SealedNoteError("E_LOCKED", "这篇笔记已锁定，需要先解锁"),
  cancelled: () => new SealedNoteError("E_CANCELLED", "已取消"),
  badEnvelope: (path?: string) =>
    new SealedNoteError("E_BAD_ENVELOPE", "文件不是有效的加密笔记，或已被其他工具破坏", path),
  keyringMissing: () =>
    new SealedNoteError("E_KEYRING_MISSING", "找不到密钥库，无法读取加密笔记"),
  vaultMismatch: () =>
    new SealedNoteError("E_VAULT_MISMATCH", "这篇笔记属于另一个保管库的密钥，无法解密"),
  wrongSecret: () => new SealedNoteError("E_WRONG_SECRET", "密钥不正确"),
  weakPassword: (why: string) => new SealedNoteError("E_WEAK_PASSWORD", why),
  totpUnavailable: () =>
    new SealedNoteError(
      "E_TOTP_DEVICE",
      t("error.totpDevice"),
    ),
  io: (message: string, detail?: unknown) => new SealedNoteError("E_IO", message, detail),
};

/** Map anything thrown into a sentence a human can act on. Never leaks a stack. */
export function describeError(error: unknown): string {
  if (error instanceof SealedNoteError) return error.message;
  if (error instanceof Error) {
    // Recognise the few browser errors worth translating.
    if (/operation is insecure|subtle/i.test(error.message)) {
      return "当前环境不支持 Web Crypto，无法加解密";
    }
    if (/not found|ENOENT/i.test(error.message)) return "文件不存在，可能已被移动或删除";
    return error.message;
  }
  return "发生未知错误";
}