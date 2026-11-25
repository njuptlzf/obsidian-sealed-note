/**
 * Clipboard handling for secrets.
 *
 * Decrypting straight to the clipboard is a common need (pasting a password into
 * a login form), so it is supported -- but we tell the truth about what happens
 * next: the clipboard is shared, other apps can read it, and history managers
 * may persist it. No auto-clear: nobody asked for it, and a timer silently
 * rewriting the user's clipboard is its own class of surprise.
 */

import { Notice } from "obsidian";

export class ClipboardService {
  async copy(text: string, opts: { label?: string } = {}): Promise<void> {
    await navigator.clipboard.writeText(text);
    new Notice(`${opts.label ?? "已复制"}。剪贴板是共享的，用完记得清空。`, 5000);
  }
}
