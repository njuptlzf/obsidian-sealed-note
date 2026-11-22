/**
 * Clipboard handling for secrets.
 *
 * Decrypting straight to the clipboard is a common need (pasting a password into
 * a login form), so it is supported -- but we tell the truth about what happens
 * next: the clipboard is shared, other apps can read it, and history managers
 * may persist it.
 */

import { Notice } from "obsidian";
import { log } from "../util/log";

export class ClipboardService {
  private readonly log = log.child("clipboard");
  private timer: number | null = null;
  private lastCopied = "";

  constructor(private readonly clearAfterSeconds: () => number) {}

  async copy(text: string, opts: { label?: string } = {}): Promise<void> {
    await navigator.clipboard.writeText(text);
    this.lastCopied = text;
    this.noteCopied();
    const seconds = this.clearAfterSeconds();
    if (seconds > 0) {
      new Notice(
        `${opts.label ?? "已复制"}。${seconds} 秒后会尝试清空剪贴板；在此之前其他程序可能读到它。`,
        5000,
      );
    } else {
      new Notice(`${opts.label ?? "已复制"}。剪贴板是共享的，用完记得清空。`, 5000);
    }
  }

  noteCopied(): void {
    const seconds = this.clearAfterSeconds();
    if (seconds <= 0) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(async () => {
      try {
        const current = await navigator.clipboard.readText().catch(() => "");
        // Only clear if nobody replaced it: do not destroy the user's later copy.
        if (current === this.lastCopied) {
          await navigator.clipboard.writeText("");
          this.log.info("clipboard_cleared", {});
        }
      } catch {
        /* clipboard read may be blocked; nothing we can do */
      }
      this.timer = null;
    }, seconds * 1000);
  }

  dispose(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.lastCopied = "";
  }
}