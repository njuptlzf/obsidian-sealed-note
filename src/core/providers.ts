/**
 * Unlock providers.
 *
 * Each provider turns a credential into the vault DEK. Adding a new method
 * (passkey, hardware token) means implementing this interface and registering
 * it - the dialogs are driven by `fields`, not by special cases.
 *
 * Important distinction for TOTP:
 *   - the 6 digit code only PROVES possession of the authenticator
 *   - the 160 bit seed is the actual key material
 * The KEK is derived from the seed, never from the rotating code. Deriving from
 * the code would be pointless: 20 bits of entropy, and it changes every 30s.
 */

import {
  KeyringData,
  UnlockError,
  UnlockFailureReason,
  SLOT_PASSWORD,
  SLOT_RECOVERY,
  SLOT_TOTP,
  SLOT_PASSWORD_TOTP,
  credentialFor,
  unlockFromCredential,
} from "./keyring";
import { verifyTotp } from "./totp";
import { t } from "../i18n";

/**
 * Try a credential against the keyring, translating the generic "no slot
 * accepts this" into what the failure actually means FOR THIS METHOD.
 *
 * `unlockFromCredential` cannot know: the same rejection is a wrong password in
 * password mode, a seed that differs from the one the keyring was built with in
 * TOTP mode, and a recovery key from another vault in recovery mode. Phrasing
 * all three as "incorrect, try again" is what made a user with a correct code
 * keep retyping it.
 */
async function openWith(
  kr: KeyringData,
  credential: string,
  reason: UnlockFailureReason,
): Promise<Uint8Array> {
  try {
    return await unlockFromCredential(kr, credential);
  } catch (error) {
    if (error instanceof UnlockError) throw new UnlockError("Credential rejected", true, reason);
    throw error;
  }
}

export type ProviderId = "password" | "totp" | "password+totp" | "recovery";

export interface UnlockAttempt {
  /** what the user typed as the main secret */
  secret: string;
  /** 6 digit code for TOTP-based providers */
  code?: string;
  /** the seed imported from the authenticator (otpauth://), when available */
  totpSeed?: string;
}

export interface ProviderField {
  key: "secret" | "code";
  label: string;
  kind: "password" | "text";
  placeholder: string;
  numeric?: boolean;
  maxLength?: number;
}

export interface UnlockProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly hint: string;
  readonly fields: ProviderField[];
  readonly caution?: string;
  isConfigured(kr: KeyringData): boolean;
  unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array>;
}

/** Does this provider need a TOTP code from the authenticator? */
export function needsCode(id: ProviderId): boolean {
  return id === "totp" || id === "password+totp";
}

export class PasswordProvider implements UnlockProvider {
  readonly id = "password" as const;
  get label() { return t("provider.password.label"); }
  get hint() { return t("provider.password.hint"); }
  get fields(): ProviderField[] {
    return [{ key: "secret", label: t("provider.password.label"), kind: "password", placeholder: t("provider.password.placeholder") }];
  }
  get caution() { return t("provider.password.caution"); }

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_PASSWORD];
  }

    async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
      if (!attempt.secret) throw new UnlockError(t("error.missingPassword"), false, "incomplete");
      return openWith(kr, credentialFor(SLOT_PASSWORD, { password: attempt.secret }), "wrong-password");
    }
}

/**
 * Standalone TOTP: the seed from the authenticator IS the credential.
 * The 6 digit code is checked against it, then the seed unwraps the DEK.
 */
export class TotpProvider implements UnlockProvider {
  readonly id = "totp" as const;
  get label() { return t("provider.totp.label"); }
  get hint() { return t("provider.totp.hint"); }
  get fields(): ProviderField[] {
    return [{ key: "code", label: t("provider.totp.codeLabel"), kind: "text", placeholder: "000000", numeric: true, maxLength: 6 }];
  }
  get caution() { return t("provider.totp.caution"); }

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_TOTP] && kr.totp.enabled;
  }

    async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
      if (!attempt.code) throw new UnlockError(t("error.missingSeed"), false, "incomplete");
      const seed = attempt.totpSeed;
      if (!seed) throw new UnlockError(t("provider.totp.hint"), false, "incomplete");
      const ok = await verifyTotp(seed, attempt.code, {
        digits: kr.totp.digits,
        step: kr.totp.period,
      });
      if (!ok) throw new UnlockError("TOTP code rejected", true, "wrong-code");
      // The code was right, so a rejection from here on is a key problem, not a
      // typo - most often this device's cached seed is not the one the keyring
      // was built with.
      return openWith(kr, credentialFor(SLOT_TOTP, { totpSeed: seed }), "key-mismatch");
    }
}

/** Password + TOTP. Both are folded into one KEK with domain separation. */
export class PasswordTotpProvider implements UnlockProvider {
  readonly id = "password+totp" as const;
  get label() { return t("provider.combined.label"); }
  get hint() { return t("provider.combined.hint"); }
  get fields(): ProviderField[] {
    return [
      { key: "secret", label: t("provider.password.label"), kind: "password", placeholder: t("provider.password.placeholder") },
      { key: "code", label: t("provider.totp.codeLabel"), kind: "text", placeholder: "000000", numeric: true, maxLength: 6 },
    ];
  }
  get caution() { return t("provider.combined.caution"); }

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_PASSWORD_TOTP] && kr.totp.enabled;
  }

    async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
      if (!attempt.secret) throw new UnlockError(t("error.missingPassword"), false, "incomplete");
      if (!attempt.code) throw new UnlockError(t("error.missingSeed"), false, "incomplete");
      const seed = attempt.totpSeed;
      if (!seed) throw new UnlockError(t("provider.totp.hint"), false, "incomplete");
      const ok = await verifyTotp(seed, attempt.code, {
        digits: kr.totp.digits,
        step: kr.totp.period,
      });
      if (!ok) throw new UnlockError("TOTP code rejected", true, "wrong-code");
      // Code verified but the pair opens nothing: either the password or the
      // seed is off. Reported as its own case so the hint can name both.
      return openWith(
        kr,
        credentialFor(SLOT_PASSWORD_TOTP, { password: attempt.secret, totpSeed: seed }),
        "combined-mismatch",
      );
    }
}

/** Recovery key always works, independent of the configured mode. */
export class RecoveryProvider implements UnlockProvider {
  readonly id = "recovery" as const;
  get label() { return t("provider.recovery.label"); }
  get hint() { return t("provider.recovery.hint"); }
  get fields(): ProviderField[] {
    return [{ key: "secret", label: t("provider.recovery.label"), kind: "text", placeholder: "XXXXX-XXXXX-XXXXX-…" }];
  }
  get caution() { return t("provider.recovery.caution"); }

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_RECOVERY];
  }

    async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
      if (!attempt.secret) throw new UnlockError(t("error.missingRecovery"), false, "incomplete");
      return openWith(
        kr,
        credentialFor(SLOT_RECOVERY, { recovery: attempt.secret }),
        "wrong-recovery",
      );
    }
}

class ProviderRegistry {
  private readonly providers = new Map<ProviderId, UnlockProvider>();

  register(provider: UnlockProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): UnlockProvider | undefined {
    return this.providers.get(id);
  }

  /** Providers usable for this keyring, in display order. */
  available(kr: KeyringData): UnlockProvider[] {
    const order: ProviderId[] = ["password+totp", "password", "totp", "recovery"];
    return order
      .map((id) => this.providers.get(id))
      .filter((p): p is UnlockProvider => !!p && p.isConfigured(kr));
  }

  all(): UnlockProvider[] {
    return [...this.providers.values()];
  }
}

export const providerRegistry = new ProviderRegistry();
providerRegistry.register(new PasswordProvider());
providerRegistry.register(new TotpProvider());
providerRegistry.register(new PasswordTotpProvider());
providerRegistry.register(new RecoveryProvider());

export function providersAvailable(kr: KeyringData): UnlockProvider[] {
  return providerRegistry.available(kr);
}

export function getProvider(id: ProviderId): UnlockProvider {
  const p = providerRegistry.get(id);
  if (!p) throw new Error(`Unknown unlock provider: ${id}`);
  return p;
}
