/** Plugin settings, with defaults and migration for older saved shapes. */

import type { Language } from "./i18n";

export type ProviderChoice = "password" | "totp" | "recovery";

export interface SealedNoteSettings {
  /** 0 = ask every time a note is opened (default, matches the PRD) */
  keepUnlockedSeconds: number;
  defaultProvider: ProviderChoice;
  /** TOTP: require the password first, GitHub style */
  requirePasswordBeforeTotp: boolean;
  /** UI language: follow Obsidian, or force one */
  language: Language;
  /** extension of private notes */
  extension: string;
  /** show a lock pill in reading view for inline payloads */
  showInlineBadges: boolean;
  /** auto lock everything when the app loses focus */
  lockOnBlur: boolean;
  /** confirm before decrypting a whole note in place */
  confirmWholeNoteDecrypt: boolean;
  /** 0 = off */
  clipboardClearSeconds: number;
  /** debounce before an edited sealed note is encrypted and written, ms */
  autoSaveMs: number;
}

export const DEFAULT_SETTINGS: SealedNoteSettings = {
  keepUnlockedSeconds: 0,
  defaultProvider: "password",
  requirePasswordBeforeTotp: false,
  language: "auto" as Language,
  extension: "sealed.md",
  showInlineBadges: true,
  lockOnBlur: false,
  confirmWholeNoteDecrypt: true,
  clipboardClearSeconds: 0,
  autoSaveMs: 1500,
};

export function normalizeSettings(raw: unknown): SealedNoteSettings {
  const input = (raw ?? {}) as Partial<SealedNoteSettings>;
  const out: SealedNoteSettings = { ...DEFAULT_SETTINGS };
  if (typeof input.keepUnlockedSeconds === "number" && input.keepUnlockedSeconds >= 0) {
    out.keepUnlockedSeconds = Math.min(input.keepUnlockedSeconds, 3600);
  }
  if (input.defaultProvider && ["password", "totp", "recovery"].includes(input.defaultProvider)) {
    out.defaultProvider = input.defaultProvider;
  }
  if (typeof input.requirePasswordBeforeTotp === "boolean") {
    out.requirePasswordBeforeTotp = input.requirePasswordBeforeTotp;
  }
  if (input.language === "auto" || input.language === "en" || input.language === "zh") {
    out.language = input.language;
  }
  if (typeof input.extension === "string" && /^[a-z0-9.]{2,20}$/i.test(input.extension)) {
    out.extension = input.extension.toLowerCase();
  }
  if (typeof input.showInlineBadges === "boolean") out.showInlineBadges = input.showInlineBadges;
  if (typeof input.lockOnBlur === "boolean") out.lockOnBlur = input.lockOnBlur;
  if (typeof input.confirmWholeNoteDecrypt === "boolean") {
    out.confirmWholeNoteDecrypt = input.confirmWholeNoteDecrypt;
  }
  if (typeof input.clipboardClearSeconds === "number" && input.clipboardClearSeconds >= 0) {
    out.clipboardClearSeconds = Math.min(input.clipboardClearSeconds, 300);
  }
  if (typeof input.autoSaveMs === "number" && input.autoSaveMs >= 300) {
    out.autoSaveMs = Math.min(input.autoSaveMs, 10000);
  }
  return out;
}