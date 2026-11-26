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
  UnlockFailureReason,
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
import { ProviderId, UnlockProvider, UnlockAttempt, providersAvailable, needsCode, getProvider } from "../core/providers";
import { SessionStore } from "../core/session";
import { log } from "../util/log";
import { t } from "../i18n";
import { deviceKeyStorageAvailable, sealWithDevice, openWithDevice } from "../core/device";
import { Err, SealedNoteError, describeError } from "../util/errors";

/**
 * What to tell the user for each way a credential can fail.
 *
 * One sentence per cause, each ending in the action that actually fixes it.
 * Collapsing them into "incorrect, try again" is what made a user with a
 * correct dynamic code keep retyping it while the real cause was a stale seed.
 */
function describeFailure(reason: UnlockFailureReason | undefined, fallback: string): string {
  switch (reason) {
    case "wrong-code":
      return t("unlock.wrongCode");
    case "wrong-password":
      return t("unlock.wrongPassword");
    case "wrong-recovery":
      return t("unlock.wrongRecovery");
    case "key-mismatch":
      return t("unlock.keyMismatch");
    case "combined-mismatch":
      return t("unlock.combinedMismatch");
    default:
      return fallback;
  }
}

export interface UnlockPrompt {
  /** what we are unlocking, shown as the dialog title */
  subject: string;
  providers: UnlockProvider[];
  provider: UnlockProvider;
  error?: string;
  /** "unlock" (default) or "encrypt" - changes the dialog wording */
  verb?: "unlock" | "encrypt";
}

export interface UnlockUi {
  /**
   * Show the unlock dialog. Resolve with the typed secret, or with a provider id
   * when the user picked another method, or null when cancelled.
   */
  prompt(request: UnlockPrompt): Promise<UnlockAttempt & { providerId: ProviderId } | null>;
  /**
   * Progress signal for the stretch where the dialog is already gone but the
   * secret is still being verified. PBKDF2 at the production iteration count
   * measured ~450ms per configured slot, and unlockFromCredential tries every
   * slot, so this gap is long enough to look like a freeze. Optional: a headless
   * or test UI simply does not implement it.
   */
  busy?(state: "verifying" | "idle", label?: string): void;
}

export interface UnlockRequest {
  subject: string;
  preferred?: ProviderId;
  verb?: "unlock" | "encrypt";
}

export class UnlockService {
  private readonly log = log.child("unlock");
  private uiFactory: (() => UnlockUi) | null = null;
  /** TOTP seed held only in memory for this Obsidian session (never on disk). */
  private sessionTotpSeed: string | null = null;

  constructor(
    private readonly keyringStore: NoteKeyringStore,
    private readonly sessions: SessionStore,
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

    // The configured mode already decides which providers exist, and the
    // registry lists them mode-first (password+totp, password, totp) with
    // recovery last. So the first available provider IS the chosen method -
    // no separate "default unlock method" setting is needed.
    const start =
      available.find((p) => p.id === request?.preferred) ?? available[0];

    return this.interactiveUnlock(filePath, kr, start, available, request?.subject ?? "", request?.verb);
  }

  /**
   * The vault's configured unlock credential, used as the DEFAULT tab for a
   * sensitive settings action:
   *   password+totp -> both secrets, totp -> code, password -> master password.
   * This is a preference, not a restriction: the recovery key stays available
   * as an alternative. Returns null when only a recovery slot exists.
   */
  providerForMode(kr: KeyringData): UnlockProvider | null {
    const id: ProviderId | null =
      kr.totp.enabled && kr.slots[SLOT_PASSWORD_TOTP]
        ? "password+totp"
        : kr.slots[SLOT_PASSWORD]
          ? "password"
          : kr.totp.enabled && kr.slots[SLOT_TOTP]
            ? "totp"
            : null;
    return id ? getProvider(id) : null;
  }

  /**
   * Re-authenticate for a sensitive settings action (recovery key reset, mode
   * change). Ignores any cached session so a stale unlock cannot authorize a
   * credential rotation.
   *
   * The configured mode is the default tab, but the recovery key is ALWAYS
   * offered: rotating a recovery key is precisely what you do when you suspect
   * it leaked, and "use the recovery key to change the unlock method" is its
   * documented purpose. Excluding it would make the reset unreachable in the
   * one case it exists for.
   */
  async reauthForSettings(subject: string): Promise<{ dek: Uint8Array; kr: KeyringData } | null> {
    const kr = await this.requireKeyring();
    const available = providersAvailable(kr);
    if (available.length === 0) return null;
    const start = this.providerForMode(kr) ?? available[0];
    const sentinel = `__settings__/${subject}`;
    this.sessions.lock(sentinel);
    const dek = await this.interactiveUnlock(sentinel, kr, start, available, subject, "unlock");
    if (!dek) return null;
    // interactiveUnlock caches a session copy under the sentinel. A settings
    // re-auth has no note to keep unlocked, so drop that copy now; the returned
    // DEK is the original array and stays valid for the caller.
    this.sessions.lock(sentinel);
    return { dek, kr };
  }

  private async interactiveUnlock(
    filePath: string,
    kr: KeyringData,
    start: UnlockProvider,
    available: UnlockProvider[],
    subject: string,
    verb: "unlock" | "encrypt" = "unlock",
  ): Promise<Uint8Array | null> {
    let provider = start;
    let lastError: string | undefined;

    for (;;) {
      const wait = guardRemainingMs(kr.guard);
      if (wait > 0) throw new Error(`尝试次数过多，${describeGuardWait(wait)}`);

      this.signalBusy("idle");
      const answer = await this.ui.prompt({ subject, providers: available, provider, error: lastError, verb });
      if (!answer) {
        this.signalBusy("idle");
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
        // The dialog is already closed at this point, so this is the only
        // feedback the user has while the key is being derived.
        this.signalBusy("verifying", t("busy.verifying"));
        const dek = await this.performUnlock(kr, provider, answer);
        registerSuccess(kr.guard);
        await this.keyringStore.save(kr).catch(() => undefined);
        this.sessions.put(filePath, dek, provider.id);
        this.log.info("unlock_ok", { path: filePath, provider: provider.id });
        return dek;
        } catch (error) {
          if (error instanceof UnlockError) {
            // Only a rejected secret counts toward the lockout. Submitting an
            // empty field is not an attempt, and counting it as one locked
            // people out for a form typo.
            if (error.wrongSecret) registerFailure(kr.guard);
            await this.keyringStore.save(kr).catch(() => undefined);
            lastError = describeFailure(error.reason, error.message);
            this.log.warn("unlock_failed", {
              provider: provider.id,
              reason: error.reason ?? "unknown",
              attempts: kr.guard.failCount,
            });
            continue;
          }
          // No usable seed on this device is not a rejected secret: keep the
          // dialog open so the user can act on the hint where it is visible,
          // instead of closing it with a toast pointing at a dialog that no
          // longer exists.
          if (error instanceof SealedNoteError && error.code === "E_TOTP_DEVICE") {
            lastError = error.message;
            this.log.warn("unlock_seed_missing", { provider: provider.id });
            continue;
          }
          throw error;
        } finally {
        this.signalBusy("idle");
      }
    }
  }

  /** Report progress to the UI when it supports it. Never throws. */
  signalBusy(state: "verifying" | "idle", label?: string): void {
    try {
      this.uiFactory?.().busy?.(state, label);
    } catch {
      /* a missing or broken indicator must never break unlocking */
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
      // A password mode without a password door would be unrecoverable except
      // via the recovery key; refuse before touching anything.
      if (!opts.password && !kr.slots[SLOT_PASSWORD]) {
        throw new Error(
          "切换为纯密码模式需要先设置一个主密码（当前保管库没有独立的密码通道）。",
        );
      }
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
      // TOTP-only is genuinely single-factor: phone + code. The old password
      // must NOT stay as an alternative door, or the mode's promise that the
      // authenticator is the only way in is false.
      delete kr.slots[SLOT_PASSWORD];
      kr.totp.enabled = true;
      kr.totp.mode = mode;
      kr.totp.seedRef = (await sealWithDevice(kr.vaultId, seed)) ?? undefined;
      await setSlot(kr, dek, SLOT_TOTP, credentialFor(SLOT_TOTP, { totpSeed: seed }));
    } else {
      if (!opts.password || !opts.seed) throw new Error("需要主密码和动态密码种子");
      const seed = normalizeSeed(opts.seed);
      this.sessionTotpSeed = seed;
      delete kr.slots[SLOT_TOTP];
      // Strict two-factor: switching to combined mode also CLOSES the
      // single-password door. Keeping the old standalone slot would let the
      // dialog's 主密码 tab bypass the second factor, contradicting the mode
      // card's own promise ("两把钥匙缺一不可").
      delete kr.slots[SLOT_PASSWORD];
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

  /**
   * Turn TOTP off and fall back to password-only.
   *
   * Kept for API completeness; nothing wires it up right now. It refuses to run
   * on a strict two-factor vault, where dropping the combined slot would leave
   * no password door and lock the user out to the recovery key.
   */
  /**
   * Close the standalone password door on an OLD combined-mode vault.
   *
   * Vaults configured before strict two-factor kept a password slot beside the
   * combined one - the single-factor hole this mode was always supposed to not
   * have. The combined slot already wraps the DEK, so hardening is just: drop
   * the password slot, bump the epoch, and push the new key copy to every note.
   * No QR re-scan needed; the caller has already proven the DEK via dekFor.
   */
  async hardenCombinedMode(): Promise<void> {
    const kr = await this.requireKeyring();
    if (!kr.slots[SLOT_PASSWORD]) return; // already strict
    if (!kr.totp.enabled || kr.totp.mode !== "password+totp" || !kr.slots[SLOT_PASSWORD_TOTP]) {
      throw new Error("只有「主密码 + 动态密码」模式才需要收口单密码通道。");
    }
    // The combined door must be usable AFTER the old one goes away: a sealed
    // seed on this device is what makes the next unlock possible.
    const seed = this.sessionTotpSeed ?? (await this.localSeed(kr));
    if (!seed) throw Err.totpUnavailable();
    delete kr.slots[SLOT_PASSWORD];
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    const after = await this.keyringStore.load();
    if (!after?.slots[SLOT_PASSWORD_TOTP] || after.slots[SLOT_PASSWORD]) {
      throw new Error("收口后的密钥副本异常（组合槽丢失或密码槽仍在），请重试。");
    }
    this.log.info("combined_mode_hardened", { epoch: kr.epoch });
  }

  async disableTotp(): Promise<void> {
    const kr = await this.requireKeyring();
    if (!kr.slots[SLOT_PASSWORD] && kr.slots[SLOT_PASSWORD_TOTP]) {
      throw new Error(
        "当前是严格双因子模式（没有单独密码通道）。请先切到「纯密码」模式设置一个主密码，再关闭动态密码。",
      );
    }
    delete kr.slots[SLOT_TOTP];
    delete kr.slots[SLOT_PASSWORD_TOTP];
    kr.totp.enabled = false;
    this.sessionTotpSeed = null;
    kr.totp.seedRef = undefined;
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("totp_disabled", {});
  }

  /**
   * Change the master password.
   *
   * In combined mode this rewraps ONLY the combined slot: there is no
   * standalone password door to maintain, and creating one here would silently
   * reopen the single-factor hole the mode is supposed to close. The combined
   * slot needs the TOTP seed; if this device has none (fresh install), refuse
   * rather than produce a half-rotated keyring.
   */
  async changePassword(dek: Uint8Array, newPassword: string): Promise<void> {
    const kr = await this.requireKeyring();
    const combined = kr.totp.enabled && kr.totp.mode === "password+totp";
    if (combined) {
      const seed = this.sessionTotpSeed ?? (await this.localSeed(kr));
      if (!seed) {
        throw new Error(
          "本机没有可用的动态密码种子，无法改密码。先用恢复密钥完成一次解锁，或在设置「恢复本机种子缓存」导入 otpauth 链接后重试。",
        );
      }
      this.sessionTotpSeed = seed;
      await setSlot(
        kr,
        dek,
        SLOT_PASSWORD_TOTP,
        credentialFor(SLOT_PASSWORD_TOTP, { password: newPassword, totpSeed: seed }),
      );
    } else if (kr.slots[SLOT_PASSWORD]) {
      await setSlot(kr, dek, SLOT_PASSWORD, credentialFor(SLOT_PASSWORD, { password: newPassword }));
    } else {
      throw new Error(
        "当前模式没有单独的主密码通道，请改用「设置解锁方式」来更换密码。",
      );
    }
    kr.epoch = (kr.epoch ?? 0) + 1;
    await this.keyringStore.save(kr);
    this.log.info("password_changed", { epoch: kr.epoch, mode: combined ? "password+totp" : "password" });
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
    return (await this.localSeed(kr)) !== null;
  }

  /** Current seed from session memory or this device's seal, if any. */
  async currentSeed(kr: KeyringData): Promise<string | null> {
    return this.localSeed(kr);
  }

  /** Read the seed from session memory, else unseal it from this device. */
  private async localSeed(kr: KeyringData): Promise<string | null> {
    if (this.sessionTotpSeed) return this.sessionTotpSeed;
    if (!kr.totp.seedRef) return null;
    try {
      const seed = await openWithDevice(kr.vaultId, kr.totp.seedRef);
      return seed ? normalizeSeed(seed) : null;
    } catch {
      return null;
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

