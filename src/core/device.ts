/**
 * Device bound storage for the TOTP seed.
 *
 * Why this exists: if the TOTP seed lived in the synced keyring, anyone holding
 * the keyring could compute the next code without your phone. That would make
 * "TOTP only" unlock a decoration, not a factor.
 *
 * So the seed is encrypted with a random key that never leaves this device
 * (browser localStorage, which Obsidian does not sync and does not put in the
 * vault). Consequence, documented in the UI: on a brand new device the TOTP
 * method is unavailable until you unlock once with the password or recovery key
 * and re-enrol.
 */

import { buf, fromBase64, open, randomBytes, seal, toBase64, utf8, fromUtf8 } from "./crypto";

const PREFIX = "sealed-note:device-key:";

function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function deviceKeyStorageAvailable(): boolean {
  return storage() !== null;
}

export async function getDeviceKey(vaultId: string): Promise<CryptoKey | null> {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(PREFIX + vaultId);
  if (!raw) return null;
  try {
    const bytes = fromBase64(raw);
    if (bytes.length !== 32) return null;
    return crypto.subtle.importKey("raw", buf(bytes), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    return null;
  }
}

export async function ensureDeviceKey(vaultId: string): Promise<CryptoKey | null> {
  const existing = await getDeviceKey(vaultId);
  if (existing) return existing;
  const store = storage();
  if (!store) return null;
  const raw = randomBytes(32);
  store.setItem(PREFIX + vaultId, toBase64(raw));
  return crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function forgetDeviceKey(vaultId: string): void {
  storage()?.removeItem(PREFIX + vaultId);
}

export interface SealedSecret {
  iv: string;
  data: string;
}

/** Encrypt a small secret (the TOTP seed) with the device key. */
export async function sealWithDevice(
  vaultId: string,
  secret: string,
): Promise<SealedSecret | null> {
  const key = await ensureDeviceKey(vaultId);
  if (!key) return null;
  const box = await seal(key, utf8(secret), `sealed-note|device|${vaultId}`);
  return { iv: toBase64(box.iv), data: toBase64(box.data) };
}

export async function openWithDevice(
  vaultId: string,
  sealed: SealedSecret,
): Promise<string | null> {
  const key = await getDeviceKey(vaultId);
  if (!key) return null;
  try {
    const plain = await open(
      key,
      { iv: fromBase64(sealed.iv), data: fromBase64(sealed.data) },
      `sealed-note|device|${vaultId}`,
    );
    return fromUtf8(plain);
  } catch {
    return null;
  }
}