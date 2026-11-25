/**
 * The keyring: one small file that holds the vault Data Encryption Key (DEK)
 * wrapped by every configured unlock method.
 *
 *   DEK                     random 32 bytes, the real key. Never stored bare.
 *   slot.password           PBKDF2(password) -> wraps DEK
 *   slot.recovery           PBKDF2(recovery key) -> wraps DEK
 *   slot.totp               PBKDF2(totp secret) -> wraps DEK   (opt-in)
 *
 * Every slot carries its own `gen`. Bumping one slot's generation invalidates
 * older wrapped copies of that slot only, so a password reset never disturbs
 * the recovery slot (whose secret we do not know at that moment).
 *
 * Because the DEK never changes during a password reset, no note has to be
 * rewritten: resetting a credential is instant and atomic.
 */

import {
  DEFAULT_KDF,
  DecryptError,
  KdfParams,
  SALT_BYTES,
  deriveKeyFromSecret,
  fromBase64,
  hkdfBytes,
  open,
  randomBytes,
  randomHex,
  randomUuid,
  seal,
  toBase64,
  fromUtf8,
  utf8,
} from "./crypto";
import { FORMAT_KEYRING, keyringAad } from "./format";

export const SLOT_PASSWORD = "password";
export const SLOT_RECOVERY = "recovery";
export const SLOT_TOTP = "totp";
/** password + TOTP seed, as one combined credential */
export const SLOT_PASSWORD_TOTP = "password-totp";
export type SlotId =
  | typeof SLOT_PASSWORD
  | typeof SLOT_RECOVERY
  | typeof SLOT_TOTP
  | typeof SLOT_PASSWORD_TOTP;

/** Which credential is required to unlock. */
export type UnlockMode = "password" | "totp" | "password+totp";

/**
 * The TOTP seed is the actual key material; the 6 digit code only proves that
 * the user holds the authenticator. Never derive a KEK from the 6 digit code:
 * it has ~20 bits of entropy and rotates every 30 seconds.
 *
 * The seed lives in the user's authenticator app (phone), not in the vault and
 * not on this device. A new device is onboarded by importing the otpauth:// URI
 * from that app - the same flow as moving GitHub 2FA to a new phone.
 */
export interface TotpBlock {
  enabled: boolean;
  digits: number;
  period: number;
  mode: UnlockMode;
  /**
   * The seed sealed with a key that lives only in this device's localStorage.
   * NOT part of the synced key copy: on another machine this is undecryptable,
   * which is fine - the user re-imports the otpauth URI from the authenticator
   * once, and it gets sealed with that device's key.
   */
  seedRef?: { iv: string; data: string };
}

/** Build the credential string for a slot, with domain separation. */
export function credentialFor(
  slot: SlotId,
  parts: { password?: string; totpSeed?: string; recovery?: string },
): string {
  switch (slot) {
    case SLOT_PASSWORD:
      if (!parts.password) throw new UnlockError("缺少主密码");
      return `sn-pwd|${parts.password}`;
    case SLOT_TOTP:
      if (!parts.totpSeed) throw new UnlockError("缺少动态密码种子");
      return `sn-totp|${parts.totpSeed}`;
    case SLOT_PASSWORD_TOTP:
      if (!parts.password || !parts.totpSeed) throw new UnlockError("缺少主密码或动态密码种子");
      return `sn-pwd-totp|${parts.password}|${parts.totpSeed}`;
    case SLOT_RECOVERY:
      if (!parts.recovery) throw new UnlockError("缺少恢复密钥");
      return `sn-rec|${normalizeRecovery(parts.recovery)}`;
  }
}

export interface WrappedKey {
  iv: string;
  data: string;
}

export interface KeyringSlot {
  /** bumped whenever this slot is rewrapped; part of the AAD */
  gen: number;
  salt: string;
  wrap: WrappedKey;
  updatedAt: string;
}

export interface GuardState {
  failCount: number;
  lockedUntil: number | null;
}

export interface KeyringData {
  format: string;
  vaultId: string;
  kdf: KdfParams;
  /** monotonic counter, bumped on every mutation; see note on rollback below */
  epoch: number;
  slots: Partial<Record<SlotId, KeyringSlot>>;
  totp: TotpBlock;
  passwordHint?: string;
  createdAt: string;
  updatedAt: string;
  guard: GuardState;
}

/**
 * Anything below this is refused at load time.
 *
 * Why: the iteration count lives in the keyring file, so an attacker holding
 * the file could edit it down to 1000 and brute force your password ~600x
 * faster. Treating a low value as "not our file" closes that hole.
 */
export const MIN_ITERATIONS = 100_000;

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

export function newVaultId(): string {
  return randomUuid();
}

export function newDek(): Uint8Array {
  return randomBytes(32);
}

/**
 * Convert between the in-memory KeyringData and the `keys` field stored in a
 * note. The TOTP seedRef is deliberately excluded: it is sealed with a key that
 * lives only on this device and is useless anywhere else.
 */
export function keyCopyFromKeyringData(kr: KeyringData): import("./format").KeyCopy {
  const slots: Record<string, { gen: number; salt: string; wrap: { iv: string; data: string } }> = {};
  for (const name of [SLOT_PASSWORD, SLOT_RECOVERY, SLOT_TOTP, SLOT_PASSWORD_TOTP] as SlotId[]) {
    const cell = kr.slots[name];
    if (!cell) continue;
    slots[name] = { gen: cell.gen, salt: cell.salt, wrap: cell.wrap };
  }
  return {
    vaultId: kr.vaultId,
    epoch: kr.epoch,
    kdf: { hash: kr.kdf.hash, iterations: kr.kdf.iterations },
    slots,
    totp: { ...kr.totp },
  };
}

export function formatKeyringFromCopy(copy: import("./format").KeyCopy): KeyringData {
  const now = new Date().toISOString();
  const slots: Partial<Record<SlotId, KeyringSlot>> = {};
  for (const [name, cell] of Object.entries(copy.slots ?? {})) {
    slots[name as SlotId] = {
      gen: cell.gen,
      salt: cell.salt,
      wrap: cell.wrap,
      updatedAt: now,
    };
  }
  return {
    format: FORMAT_KEYRING,
    vaultId: copy.vaultId,
    kdf: {
      hash: copy.kdf.hash as "SHA-256" | "SHA-512",
      iterations: copy.kdf.iterations,
    },
    epoch: copy.epoch,
    slots,
    totp: copy.totp
      ? {
          enabled: !!copy.totp.enabled,
          digits: copy.totp.digits || 6,
          period: copy.totp.period || 30,
          mode: (["password", "totp", "password+totp"].includes(copy.totp.mode)
            ? copy.totp.mode
            : "password+totp") as UnlockMode,
          ...(copy.totp.seedRef ? { seedRef: copy.totp.seedRef } : {}),
        }
      : { enabled: false, digits: 6, period: 30, mode: "password+totp" },
    createdAt: now,
    updatedAt: now,
    guard: { failCount: 0, lockedUntil: null },
  };
}

export function emptyKeyring(vaultId: string): KeyringData {
  const now = new Date().toISOString();
  return {
    format: FORMAT_KEYRING,
    vaultId,
    kdf: { ...DEFAULT_KDF },
    epoch: 1,
    slots: {},
    totp: { enabled: false, digits: 6, period: 30, mode: "password+totp" },
    createdAt: now,
    updatedAt: now,
    guard: { failCount: 0, lockedUntil: null },
  };
}

export function parseKeyring(text: string): KeyringData {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Keyring is not valid JSON");
  }
  if (!data || data.format !== FORMAT_KEYRING) {
    throw new Error(`Unsupported keyring format: ${String(data?.format)}`);
  }
  if (!data.vaultId || typeof data.vaultId !== "string") {
    throw new Error("Keyring is missing vaultId");
  }
  const kdf = data.kdf ?? {};
  if (
    typeof kdf.iterations !== "number" ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_ITERATIONS ||
    !["SHA-256", "SHA-512"].includes(kdf.hash)
  ) {
    throw new Error("Keyring has invalid KDF parameters");
  }
  data.slots = data.slots ?? {};
  data.totp = data.totp ?? { enabled: false, digits: 6, period: 30, mode: "password+totp" };
  if (!["password", "totp", "password+totp"].includes(data.totp.mode)) data.totp.mode = "password+totp";
  data.guard = data.guard ?? { failCount: 0, lockedUntil: null };
  data.epoch = typeof data.epoch === "number" ? data.epoch : 1;
  return data as KeyringData;
}

export function serializeKeyring(kr: KeyringData): string {
  kr.updatedAt = new Date().toISOString();
  return JSON.stringify(kr, null, 2) + "\n";
}

/* ------------------------------------------------------------------ */
/* wrapping / unwrapping                                               */
/* ------------------------------------------------------------------ */

/**
 * Secrets must be normalized identically on the way in and on the way out, or a
 * recovery key typed with different spacing would fail to unwrap a DEK that was
 * wrapped from the formatted version. This is the single place that decides.
 */
async function wrapDek(
  dek: Uint8Array,
  secret: string,
  kr: KeyringData,
  slot: SlotId,
  gen: number,
  salt: Uint8Array,
): Promise<KeyringSlot> {
  const kek = await deriveKeyFromSecret(secret, salt, kr.kdf);
  const box = await seal(kek, dek, keyringAad(kr.vaultId, slot, gen));
  return {
    gen,
    salt: toBase64(salt),
    wrap: { iv: toBase64(box.iv), data: toBase64(box.data) },
    updatedAt: new Date().toISOString(),
  };
}

async function unwrapDek(
  kr: KeyringData,
  slot: SlotId,
  secret: string,
): Promise<Uint8Array> {
  const entry = kr.slots[slot];
  if (!entry) throw new UnlockError(`${slot} is not configured`);
  const kek = await deriveKeyFromSecret(secret, fromBase64(entry.salt), kr.kdf);
  try {
    const dek = await open(
      kek,
      { iv: fromBase64(entry.wrap.iv), data: fromBase64(entry.wrap.data) },
      keyringAad(kr.vaultId, slot, entry.gen),
    );
    if (dek.length !== 32) throw new DecryptError();
    return dek;
  } catch {
    throw new UnlockError("Wrong secret", true);
  }
}

async function unwrapDekFromCredential(
  kr: KeyringData,
  slot: SlotId,
  credential: string,
): Promise<Uint8Array> {
  const entry = kr.slots[slot];
  if (!entry) throw new UnlockError(`${slot} is not configured`);
  const kek = await deriveKeyFromSecret(credential, fromBase64(entry.salt), kr.kdf);
  try {
    const dek = await open(
      kek,
      { iv: fromBase64(entry.wrap.iv), data: fromBase64(entry.wrap.data) },
      keyringAad(kr.vaultId, slot, entry.gen),
    );
    if (dek.length !== 32) throw new DecryptError();
    return dek;
  } catch {
    throw new UnlockError("Wrong secret", true);
  }
}

/**
 * Why a credential was rejected.
 *
 * The wording lives in the UI layer, so a provider only has to classify the
 * failure, not phrase it. This exists because "the code is wrong" and "the code
 * is right but the key does not match" used to collapse into one "incorrect,
 * try again" message, which sent users hunting for a password that was already
 * correct while the real cause was a stale seed or a changed key.
 */
export type UnlockFailureReason =
  | "wrong-code"
  | "wrong-password"
  | "wrong-recovery"
  | "key-mismatch"
  | "combined-mismatch"
  | "incomplete";

export class UnlockError extends Error {
  constructor(
    message: string,
    /** true when the secret itself was rejected (counts toward the guard) */
    public readonly wrongSecret = false,
    public readonly reason?: UnlockFailureReason,
  ) {
    super(message);
    this.name = "UnlockError";
  }
}

/* ------------------------------------------------------------------ */
/* setup                                                               */
/* ------------------------------------------------------------------ */

/** Create a brand new keyring for this vault. Returns the DEK to cache. */
export async function createKeyring(
  vaultId: string,
  password: string,
  recoverySecret: string,
  opts: { iterations?: number; hint?: string } = {},
): Promise<{ keyring: KeyringData; dek: Uint8Array }> {
  // Build on the shared initializer: an empty keyring with only the recovery
  // slot. Password and TOTP slots are added by the setup flow according to the
  // chosen mode, so "TOTP only" is possible from first run.
  const { keyring: kr, dek } = await createKeyringWithoutPassword(vaultId, recoverySecret, opts);
  if (password && password.length > 0) {
    kr.slots[SLOT_PASSWORD] = await wrapDek(
      dek,
      credentialFor(SLOT_PASSWORD, { password }),
      kr,
      SLOT_PASSWORD,
      1,
      randomBytes(SALT_BYTES),
    );
  }
  return { keyring: kr, dek };
}

/** Initialize a vault with only a recovery slot - no master password. */
export async function createKeyringWithoutPassword(
  vaultId: string,
  recoverySecret: string,
  opts: { iterations?: number; hint?: string } = {},
): Promise<{ keyring: KeyringData; dek: Uint8Array }> {
  const kr = emptyKeyring(vaultId);
  if (opts.iterations) kr.kdf = { ...kr.kdf, iterations: opts.iterations };
  if (opts.hint) kr.passwordHint = opts.hint;
  const dek = newDek();
  kr.slots[SLOT_RECOVERY] = await wrapDek(
    dek,
    credentialFor(SLOT_RECOVERY, { recovery: normalizeRecovery(recoverySecret) }),
    kr,
    SLOT_RECOVERY,
    1,
    randomBytes(SALT_BYTES),
  );
  return { keyring: kr, dek };
}

/** Add or replace a slot. The caller already holds the DEK. */
export async function setSlot(
  kr: KeyringData,
  dek: Uint8Array,
  slot: SlotId,
  secret: string,
): Promise<void> {
  const prev = kr.slots[slot];
  const gen = (prev?.gen ?? 0) + 1;
  kr.slots[slot] = await wrapDek(dek, secret, kr, slot, gen, randomBytes(SALT_BYTES));
  kr.epoch = (kr.epoch ?? 0) + 1;
}

export async function removeSlot(kr: KeyringData, slot: SlotId): Promise<void> {
  delete kr.slots[slot];
  if (slot === SLOT_TOTP) kr.totp.enabled = false;
  kr.epoch = (kr.epoch ?? 0) + 1;
}

/* ------------------------------------------------------------------ */
/* rollback protection                                                 */
/* ------------------------------------------------------------------ */

/**
 * AAD binds a wrapped DEK to its slot generation, which stops a single cell from
 * being moved between slots or reused after its own reset. It does NOT stop an
 * attacker who restores a whole older keyring file: that file's cells and
 * generations are self consistent, so they still unwrap.
 *
 * The only place a high water mark can live is off the synced file, so we keep
 * it in device storage and refuse to load a keyring whose epoch went backwards.
 * This is a partial defence by construction (a fresh device has no memory), and
 * it is documented as such rather than oversold.
 */
export interface EpochStore {
  read(vaultId: string): number | null;
  write(vaultId: string, epoch: number): void;
}

export function checkEpoch(
  kr: KeyringData,
  store: EpochStore,
): { ok: boolean; seen: number | null } {
  const seen = store.read(kr.vaultId);
  if (seen !== null && kr.epoch < seen) return { ok: false, seen };
  return { ok: true, seen };
}

export function recordEpoch(kr: KeyringData, store: EpochStore): void {
  const seen = store.read(kr.vaultId) ?? 0;
  if (kr.epoch > seen) store.write(kr.vaultId, kr.epoch);
}

/* ------------------------------------------------------------------ */
/* unlocking                                                           */
/* ------------------------------------------------------------------ */

/** Unwrap the DEK using a credential string built by credentialFor(). */
export async function unlockFromCredential(kr: KeyringData, credential: string): Promise<Uint8Array> {
  // Try every configured slot. The credential has a domain prefix which is
  // part of the PBKDF2 input, so only the matching slot can open it.
  for (const slot of Object.keys(kr.slots) as SlotId[]) {
    try {
      return await unwrapDekFromCredential(kr, slot, credential);
    } catch {
      continue;
    }
  }
  throw new UnlockError("No stored slot accepts this credential", true, "key-mismatch");
}

export async function unlockWithPassword(kr: KeyringData, password: string): Promise<Uint8Array> {
  return unlockFromCredential(kr, credentialFor(SLOT_PASSWORD, { password }));
}

export async function unlockWithRecovery(kr: KeyringData, recovery: string): Promise<Uint8Array> {
  return unlockFromCredential(kr, credentialFor(SLOT_RECOVERY, { recovery: normalizeRecovery(recovery) }));
}

export async function unlockWithTotp(kr: KeyringData, seed: string): Promise<Uint8Array> {
  return unlockFromCredential(kr, credentialFor(SLOT_TOTP, { totpSeed: seed }));
}

export function hasSlot(kr: KeyringData | null, slot: SlotId): boolean {
  return !!kr?.slots?.[slot];
}

/** Stable, non secret identifier for the key, shown to the user for sanity checks. */
export async function keyFingerprint(dek: Uint8Array): Promise<string> {
  const bytes = await hkdfBytes(dek, new Uint8Array(0), "sealed-note/fingerprint/v1", 8);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (hex.match(/.{4}/g) || []).join(" ").toUpperCase();
}

/* ------------------------------------------------------------------ */
/* guard - throttle interactive guessing only                          */
/* ------------------------------------------------------------------ */

const MAX_DELAY_MS = 60_000;
export const FREE_ATTEMPTS = 5;

export function guardRemainingMs(guard: GuardState, now = Date.now()): number {
  if (!guard.lockedUntil) return 0;
  return Math.max(0, guard.lockedUntil - now);
}

export function registerFailure(guard: GuardState, now = Date.now()): void {
  guard.failCount = (guard.failCount ?? 0) + 1;
  if (guard.failCount > FREE_ATTEMPTS) {
    const over = guard.failCount - FREE_ATTEMPTS;
    const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** Math.min(over - 1, 6));
    guard.lockedUntil = now + delay;
  }
}

export function registerSuccess(guard: GuardState): void {
  guard.failCount = 0;
  guard.lockedUntil = null;
}

export function describeGuardWait(ms: number): string {
  if (ms <= 0) return "";
  return ms >= 1000 ? `请在 ${Math.ceil(ms / 1000)} 秒后重试` : "请稍后重试";
}

/* ------------------------------------------------------------------ */
/* recovery key format                                                 */
/* ------------------------------------------------------------------ */

/** 32 random bytes as base32, grouped for transcription. ~52 chars. */
export function normalizeRecovery(input: string): string {
  return (input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function isPlausibleRecovery(input: string): boolean {
  return normalizeRecovery(input).length >= 48;
}

export function newNoteId(): string {
  return randomHex(8);
}

export function vaultIdFromKeyring(kr: KeyringData): string {
  void utf8;
  void fromUtf8;
  return kr.vaultId;
}