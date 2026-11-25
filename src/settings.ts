/** Plugin settings, with defaults and migration for older saved shapes. */

import type { Language } from "./i18n";

/**
 * When an unlocked private note re-locks itself.
 *
 *   blur    - any focus loss: switching window, app, note, tab or the settings
 *             page. The strictest level and the default.
 *   close   - only when you leave the note (switch note, close its tab). Losing
 *             window focus keeps it open.
 *   session - only when Obsidian itself closes: unlock once per app session.
 */
export type LockPolicy = "blur" | "close" | "session";

export interface SealedNoteSettings {
  /** UI language: follow Obsidian, or force one */
  language: Language;
  /** extension of private notes */
  extension: string;
  /** show a lock pill in reading view for inline payloads */
  showInlineBadges: boolean;
  /** when an unlocked note re-locks itself */
  lockPolicy: LockPolicy;
  /** confirm before decrypting a whole note in place */
  confirmWholeNoteDecrypt: boolean;
  /** debounce before an edited sealed note is encrypted and written, ms */
  autoSaveMs: number;
}

export const DEFAULT_SETTINGS: SealedNoteSettings = {
  language: "auto" as Language,
  extension: "sealed.md",
  showInlineBadges: true,
  // Highest privacy by default: the moment focus leaves the note - another
  // window, another note, another tab, the settings page - it is encrypted and
  // the key is dropped, so coming back asks for the credential again.
  lockPolicy: "blur",
  confirmWholeNoteDecrypt: true,
  autoSaveMs: 1500,
};

export function normalizeSettings(raw: unknown): SealedNoteSettings {
  const input = (raw ?? {}) as Partial<SealedNoteSettings>;
  const out: SealedNoteSettings = { ...DEFAULT_SETTINGS };
  if (input.language === "auto" || input.language === "en" || input.language === "zh") {
    out.language = input.language;
  }
  if (typeof input.extension === "string" && /^[a-z0-9.]{2,20}$/i.test(input.extension)) {
    out.extension = input.extension.toLowerCase();
  }
  if (typeof input.showInlineBadges === "boolean") out.showInlineBadges = input.showInlineBadges;
  if (input.lockPolicy === "blur" || input.lockPolicy === "close" || input.lockPolicy === "session") {
    out.lockPolicy = input.lockPolicy;
  } else if ((input as { lockOnBlur?: boolean }).lockOnBlur === false) {
    // Migration: the old boolean toggle only knew "lock on blur" (true) and
    // "never lock on blur" (false), which maps onto the "close" level.
    out.lockPolicy = "close";
  }
  if (typeof input.confirmWholeNoteDecrypt === "boolean") {
    out.confirmWholeNoteDecrypt = input.confirmWholeNoteDecrypt;
  }
  if (typeof input.autoSaveMs === "number" && input.autoSaveMs >= 300) {
    out.autoSaveMs = Math.min(input.autoSaveMs, 10000);
  }
  return out;
}