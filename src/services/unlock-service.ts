/**
 * Unlock service: the single entry point for "give me the DEK".
 *
 * Owns throttling, the session cache, and provider dispatch. UI never calls a
 * provider directly, so there is exactly one place where a failed attempt is
 * counted and one place where a successful unlock is cached.
 */

import {
  KeyringData,
  UnlockError,
  describeGuardWait,
  guardRemainingMs,
  registerFailure,
  registerSuccess,
  SLOT_TOTP,
  SLOT_RECOVERY,
  SLOT_PASSWORD,
  SLOT_PASSWORD_TOTP,
  UnlockMode,
  credentialFor,
  unlockFromCredential,
  setSlot,
  removeSlot,
} from "../core/keyring";
import { NoteKeyringStore } from "../storage/note-keyring-store";
import { ProviderId, UnlockProvider, UnlockAttempt, providersAvailable, needsCode } from "../core/providers";
import { SessionStore } from "../core/session";
import { SealedNoteSettings } from "../settings";
import { log } from "../util/log";
import { deviceKeyStorageAvailable, sealWithDevice, openWithDevice } from "../core/device";
import { Err, describeError } from "../util/errors";

export interface UnlockPrompt {
  /** what we are unlocking, shown as the dialog title */
  subject: string;
  providers: UnlockProvider[];
  provider: UnlockProvider;
  error?: string;
}

export interface UnlockUi {
  /**
   * Show the unlock dialog. Resolve with the typed secret, or with a provider id
   * when the user picked another method, or null when cancelled.
   */
  prompt(request: UnlockPrompt): Promise<UnlockAttempt & { providerId: ProviderId } | null>;
}

export interface UnlockRequest {
  subject: string;
  preferred?: ProviderId;
}

export class UnlockService {
  private readonly log = log.child("unlock");
  private uiFactory: (() => UnlockUi) | null = null;
  /** TOTP seed held only in memory for this Obsidian session (never on disk). */
  private sessionTotpSeed: string | null = null;

  constructor(
    private readonly keyringStore: NoteKeyringStore,
    private readonly sessions: SessionStore,
    private readonly getSettings: () => SealedNoteSettings,
  ) {}

  /** Wired by the plugin after the UI layer exists (avoids a circular import). */
  setUi(factory: () => UnlockUi): void {
    this.uiFactory = factory;
  }

  private get ui(): UnlockUi {
    if (!this.uiFactory) throw new Error("Unlock UI is not wired");
    return this.uiFactory();
  }

  async keyring(): Promise<KeyringData | null> {
    return this.keyringStore.load();
  }

  async requireKeyring(): Promise<KeyringData> {
    const kr = await this.keyringStore.load();
    if (!kr) throw Err.notInitialized();
    return kr;
  }

  /**
   * Get the DEK for a file, prompting if needed.
   * Returns null when the user cancels; callers must treat that as "do nothing".
   */
  async dekFor(filePath: string, request?: UnlockRequest): Promise<Uint8Array | null> {
    const cached = this.sessions.get(filePath);
    if (cached) return cached.dek;

    const kr = await this.requireKeyring();
    const available = providersAvailable(kr);
    if (available.length === 0) throw Err.notInitialized();

    const start =
      available.find((p) => p.id === request?.preferred) ??
      available.find((p) => p.id === this.getSettings().defaultProvider) ??
      available[0];

    return this.interactiveUnlock(filePath, kr, start, available, request?.subject ?? "");
  }

  private async interactiveUnlock(
    filePath: string,
    kr: KeyringData,
    start: UnlockProvider,
    available: UnlockProvider[],
    subject: string,
  ): Promise<Uint8Array | null> {
    let provider = start;
    let lastError: string | undefined;

    for (;;) {
      const wait = guardRemainingMs(kr.guard);
      if (wait > 0) throw new Error(`尝试次数过多，${describeGuardWait(wait)}`);

      const answer = await this.ui.prompt({ subject, providers: available, provider, error: lastError });
      if (!answer) {
        this.log.info("unlock_cancelled", { path: filePath, provider: provider.id });
        return null;
      }

      if (answer.providerId !== provider.id) {
        const next = available.find((p) => p.id === answer.providerId);
        if (next) {
          provider = next;
          lastError = undefined;
          continue;
        }
      }

      try {
        const dek = await this.performUnlock(kr, provider, answer);
        registerSuccess(kr.guard);
        await this.keyringStore.save(kr).catch(() => undefined);
        this.sessions.put(filePath, dek, provider.id);
        this.log.info("unlock_ok", { path: filePath, provider: provider.id });
        return dek;
      } catch (error) {
        if (error instanceof UnlockError) {
          registerFailure(kr.guard);
          await this.keyringStore.save(kr).catch(() => undefined);
          lastError = error.wrongSecret ? `${provider.label}不正确，请重试` : error.message;
          this.log.warn("unlock_failed", { provider: provider.id, attempts: kr.guard.failCount });
          continue;
        }
        throw error;
      }
    }
  }

  private async performUnlock(
    kr: KeyringData,
    provider: UnlockProvider,
    attempt: UnlockAttempt,
  ): Promise<Uint8Array> {
    if (needsCode(provider.id)) {
      // Seed resolution, in priority order:
      //   1. pasted otpauth URI this time (new device / re-import)
      //   2. remembered from this session
      //   3. unsealed from this device's localStorage (same device after restart)
      const explicit = attempt.totpSeed ? normalizeSeed(attempt.totpSeed) : null;
      let seed = explicit ?? this.sessionTotpSeed;
      if (!seed && kr.totp.seedRef) {
        seed = (await openWithDevice(kr.vaultId, kr.totp.seedRef)) ?? null;
        if (seed) seed = normalizeSeed(seed);
      }
      if (!seed) throw Err.totpUnavailable();
      this.sessionTotpSeed = seed;
      // If the user pasted a URI (or we just recovered from disk) and the local
      // sealed copy is missing/stale, persist it for next time on this device.
      if (explicit || !kr.totp.seedRef) {
        await this.sealSeedLocally(kr, seed);
      }
      return provider.unlock(kr, { ...attempt, totpSeed: seed });
    }
    return provider.unlock(kr, attempt);
  }

  /* ---------------- enrolment ---------------- */

  /**
   * Persist the seed sealed with this device's key. The sealed blob is stored
   * in the keyring copy but is useless on any other device, so it travels with
   * the notes harmlessly - only this device can open it.
   */
  private async sealSeedLocally(kr: KeyringData, seed: string): Promise<void> {
    if (!deviceKeyStorageAvailable()) return;
    const sealed = await sealWithDevice(kr.vaultId, seed);
    if (!sealed) return;
    kr.totp.seedRef = sealed;
    // Persist without bumping epoch: seedRef is device-local metadata, not part
    // of the wrapped credential. Force the write so the new seal survives a
    // restart even though the epoch did not change.
    await this.keyringStore.save(kr, { force: true });
  }

  /**
   * Restore ONLY the device-local seed cache from an otpauth URI. Does not
   * change the unlock mode, does not generate a new seed, and does not touch
   * the wrapped DEK. Used after a new computer or cleared app data, when the
   * phone still holds the original seed.
   */
  async restoreLocalSeed(uri: string): Promise<void> {
    const kr = await this.requireKeyring();
    if (!kr.totp.enabled) throw new Error("TOTP is not enabled");
    const seed = normalizeSeed(uri);
    // Verify the imported seed can actually unwrap the existing TOTP slot
    // before trusting it. Combined mode also needs the password, which we do
    // not have here, so only standalone TOTP can be verified this way.
    if (kr.totp.mode === "totp") {
      await unlockFromCredential(kr, credentialFor(SLOT_TOTP, { totpSeed: seed }));
    }
    this.sessionTotpSeed = seed;
    await this.sealSeedLocally(kr, seed);
    this.log.info("totp_local_seed_restored", { mode: kr.totp.mode });
  }

  /** Set the unlock mode and (when needed) register the authenticator seed. */
  async configureMode(
    dek: Uint8Array,
    mode: UnlockMode,
    opts: { password?: string; seed?: string } = {},
  ): Promise<void> {
    const kr = await this.requireKeyring();

    if (mode === "password") {
      delete kr.slots[SLOT_TOTP];
      delete kr.slots[SLOT_PASSWORD_TOTP];
      kr.totp.enabled = false;
      kr.totp.mode = mode;
      if (opts.password) await setSlot(kr, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password: opts.password }));
    } else if (mode === "totp") {
      if (!opts.seed) throw Err.totpUnavailable();
      const seed = normalizeSeed(opts.seed);
      this.sessionTotpSeed = seed;
      delete kr.slots[SLOT_PASSWORD_TOTP];
      kr.totp.enabled = true;
      kr.totp.mode = mode;
      kr.totp.seedRef = (await sealWithDevice(kr.vaultId, seed)) ?? undefined;
      await setSlot(kr, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
    } else {
      if (!opts.password || !opts.seed) throw new Error("需要主密码和动态密码种子");
      const seed = normalizeSeed(opts.seed);
      this.sessionTotpSeed = seed;
      delete kr.slots[SLOT_TOTP];
      kr.totp.enabled = true;
      kr.totp.mode = mode;
      kr.totp.seedRef = (await sealWithDevice(kr.vaultId, seed)) ?? undefined;
      await setSlot(
        kr,
        dek,
        SLOT_PASSWORD_TOTP,
        credentialFor(SLOT_PASSWORD_TOTP, { password: opts.password, totpSeed: seed }),
      );
    }
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("unlock_mode_changed", { mode });
  }

  async disableTotp(): Promise<void> {
    const kr = await this.requireKeyring();
    delete kr.slots[SLOT_TOTP];
    delete kr.slots[SLOT_PASSWORD_TOTP];
    kr.totp.enabled = false;
    this.sessionTotpSeed = null;
    kr.totp.seedRef = undefined;
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("totp_disabled", {});
  }

  async changePassword(dek: Uint8Array, newPassword: string): Promise<void> {
    const kr = await this.requireKeyring();
    await setSlot(kr, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password: newPassword }));
    if (kr.totp.enabled && kr.totp.mode === "password+totp" && this.sessionTotpSeed) {
      await setSlot(
        kr,
        dek,
        SLOT_PASSWORD_TOTP,
        credentialFor(SLOT_PASSWORD_TOTP, {
          password: newPassword,
          totpSeed: this.sessionTotpSeed,
        }),
      );
    }
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("password_changed", { epoch: kr.epoch });
  }

  async replaceRecovery(dek: Uint8Array, newRecovery: string): Promise<void> {
    const kr = await this.requireKeyring();
    await setSlot(kr, dek, SLOT_RECOVERY, credentialFor(SLOT_RECOVERY, { recovery: newRecovery }));
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("recovery_replaced", { epoch: kr.epoch });
  }

  /** Current TOTP mode, or null when TOTP is off. */
  totpMode(): UnlockMode | null {
    return this.cachedTotpMode;
  }

  setTotpMode(mode: UnlockMode | null): void {
    this.cachedTotpMode = mode;
  }

  private cachedTotpMode: UnlockMode | null = null;

  hasSessionSeed(): boolean {
    return this.sessionTotpSeed !== null;
  }

  /** Is a usable seed available right now (session memory or this device's seal)? */
  async hasLocalSeed(kr: KeyringData): Promise<boolean> {
    if (this.sessionTotpSeed) return true;
    if (!kr.totp.seedRef) return false;
    try {
      const seed = await openWithDevice(kr.vaultId, kr.totp.seedRef);
      return !!seed;
    } catch {
      return false;
    }
  }

  clearSessionSeed(): void {
    this.sessionTotpSeed = null;
  }

  lock(filePath: string): void {
    this.sessions.lock(filePath);
  }

  lockAll(): number {
    return this.sessions.lockAll();
  }

  unlockedCount(): number {
    return this.sessions.size;
  }

  describe(error: unknown): string {
    return describeError(error);
  }
}

/* ------------------------------------------------------------------ */
/* module helpers                                                      */
/* ------------------------------------------------------------------ */

function normalizeSeed(input: string): string {
  const clean = input.trim();
  if (clean.startsWith("otpauth://")) {
    try {
      const url = new URL(clean);
      const secret = url.searchParams.get("secret");
      if (!secret) throw new Error("otpauth 链接里没有 secret");
      return secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
    } catch (error) {
      throw new Error("无法解析 otpauth 链接：" + String(error));
    }
  }
  return clean.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

