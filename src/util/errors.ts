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
  // Messages are resolved at THROW time (each factory calls t() when invoked),
  // so a language switch takes effect without reloading the plugin.
  notInitialized: () => new SealedNoteError("E_NOT_INIT", t("error.notInit")),
  locked: () => new SealedNoteError("E_LOCKED", t("error.locked")),
  cancelled: () => new SealedNoteError("E_CANCELLED", t("error.cancelled")),
  badEnvelope: (path?: string) =>
    new SealedNoteError("E_BAD_ENVELOPE", t("error.badEnvelope"), path),
  keyringMissing: () =>
    new SealedNoteError("E_KEYRING_MISSING", t("error.keyringMissing")),
  vaultMismatch: () =>
    new SealedNoteError("E_VAULT_MISMATCH", t("error.vaultMismatch")),
  wrongSecret: () => new SealedNoteError("E_WRONG_SECRET", t("error.wrongSecret")),
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
    // AES-GCM authentication failure. Its message ("Unable to decrypt: wrong
    // secret or damaged data") is English and says nothing actionable, and it
    // used to be shown verbatim as a toast. The caller has already accepted the
    // user's password by this point, so the honest explanation is different.
    if (error.name === "DecryptError") return t("error.decryptFailed");
    // Recognise the few browser errors worth translating.
    if (/operation is insecure|subtle/i.test(error.message)) return t("error.noWebCrypto");
    if (/not found|ENOENT/i.test(error.message)) return t("error.fileMissing");
    return error.message;
  }
  return t("error.unknown");
}