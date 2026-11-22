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
  SLOT_PASSWORD,
  SLOT_RECOVERY,
  SLOT_TOTP,
  SLOT_PASSWORD_TOTP,
  credentialFor,
  unlockFromCredential,
} from "./keyring";
import { verifyTotp } from "./totp";

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
  readonly label = "主密码";
  readonly hint = "输入你的主密码";
  readonly fields: ProviderField[] = [
    { key: "secret", label: "主密码", kind: "password", placeholder: "主密码" },
  ];
  readonly caution = "主密码不会保存在任何设备上，也不会被同步。";

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_PASSWORD];
  }

  async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
    if (!attempt.secret) throw new UnlockError("请输入主密码");
    return unlockFromCredential(kr, credentialFor(SLOT_PASSWORD, { password: attempt.secret }));
  }
}

/**
 * Standalone TOTP: the seed from the authenticator IS the credential.
 * The 6 digit code is checked against it, then the seed unwraps the DEK.
 */
export class TotpProvider implements UnlockProvider {
  readonly id = "totp" as const;
  readonly label = "动态密码";
  readonly hint = "输入身份验证器里的 6 位数字，并导入该验证器的 otpauth 链接";
  readonly fields: ProviderField[] = [
    { key: "code", label: "6 位验证码", kind: "text", placeholder: "000000", numeric: true, maxLength: 6 },
  ];
  readonly caution =
    "密钥材料是验证器里的种子，不是这 6 位数字。换设备时从验证器导出 otpauth 链接导入即可。";

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_TOTP] && kr.totp.enabled;
  }

  async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
    if (!attempt.code) throw new UnlockError("请输入 6 位动态密码");
    const seed = attempt.totpSeed;
    if (!seed) throw new UnlockError("请先导入验证器的 otpauth 链接");
    const ok = await verifyTotp(seed, attempt.code, {
      digits: kr.totp.digits,
      step: kr.totp.period,
    });
    if (!ok) throw new UnlockError("动态密码不正确", true);
    return unlockFromCredential(kr, credentialFor(SLOT_TOTP, { totpSeed: seed }));
  }
}

/** Password + TOTP. Both are folded into one KEK with domain separation. */
export class PasswordTotpProvider implements UnlockProvider {
  readonly id = "password+totp" as const;
  readonly label = "密码 + 动态密码";
  readonly hint = "先输入主密码，再输入身份验证器里的 6 位数字";
  readonly fields: ProviderField[] = [
    { key: "secret", label: "主密码", kind: "password", placeholder: "主密码" },
    { key: "code", label: "6 位验证码", kind: "text", placeholder: "000000", numeric: true, maxLength: 6 },
  ];
  readonly caution = "两把钥匙缺一不可。换设备时仍可凭主密码 + 恢复密钥进入。";

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_PASSWORD_TOTP] && kr.totp.enabled;
  }

  async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
    if (!attempt.secret) throw new UnlockError("请输入主密码");
    if (!attempt.code) throw new UnlockError("请输入 6 位动态密码");
    const seed = attempt.totpSeed;
    if (!seed) throw new UnlockError("请先导入验证器的 otpauth 链接");
    const ok = await verifyTotp(seed, attempt.code, {
      digits: kr.totp.digits,
      step: kr.totp.period,
    });
    if (!ok) throw new UnlockError("动态密码不正确", true);
    return unlockFromCredential(
      kr,
      credentialFor(SLOT_PASSWORD_TOTP, { password: attempt.secret, totpSeed: seed }),
    );
  }
}

/** Recovery key always works, independent of the configured mode. */
export class RecoveryProvider implements UnlockProvider {
  readonly id = "recovery" as const;
  readonly label = "恢复密钥";
  readonly hint = "输入恢复密钥，大小写、空格和连字符都可忽略";
  readonly fields: ProviderField[] = [
    { key: "secret", label: "恢复密钥", kind: "text", placeholder: "XXXXX-XXXXX-XXXXX-…" },
  ];
  readonly caution = "恢复密钥只能重设密码，不能找回密码。";

  isConfigured(kr: KeyringData): boolean {
    return !!kr.slots[SLOT_RECOVERY];
  }

  async unlock(kr: KeyringData, attempt: UnlockAttempt): Promise<Uint8Array> {
    if (!attempt.secret) throw new UnlockError("请输入恢复密钥");
    return unlockFromCredential(kr, credentialFor(SLOT_RECOVERY, { recovery: attempt.secret }));
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
