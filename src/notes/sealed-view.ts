/**
 * The ".sealed.md" view is now only a locked-state entry point.
 *
 * Editing happens IN the note: the plugin reveals the plaintext into the
 * note's own body inside Obsidian's native MarkdownView, so users keep
 * source/live-preview modes, immersive mode and every editor command. This
 * view just shows the locked state and offers "unlock & edit". All
 * plaintext/ciphertext handling lives in the plugin and
 * SealedNoteStore; nothing here holds decrypted content.
 */

import { FileView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type SealedNotePlugin from "../main";
import { describeError } from "../util/errors";
import { log } from "../util/log";

export const SEALED_VIEW_TYPE = "sealed-note-view";

export class SealedNoteView extends FileView {
  private readonly log = log.child("view");
  private unlocking = false;

  allowNoFile = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SealedNotePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return SEALED_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "加密笔记";
  }

  getIcon(): string {
    return "lock";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === this.plugin.extensionToken();
  }

  /* ---------------- lifecycle ---------------- */

  async onLoadFile(file: TFile | null): Promise<void> {
    // Only render the big padlock. Unlocking is driven solely by the plugin's
    // file-open hook (awaiting ensureSealedView before opening the working
    // copy). Doing both here caused two view switches to race on the same leaf
    // - the locked pane flashed and focus was lost during first-run setup.
    // Obsidian may pass null on transient states; render handles that.
    this.render(file);
  }

  /** Re-render the locked state only; used after an explicit lock. */
  showLocked(): void {
    this.render(this.file);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    // No plaintext lives here; the plugin owns reveal/re-seal lifecycle.
  }

  onunload(): void {
    // nothing to flush
  }

  /* ---------------- render ---------------- */

  private render(file: TFile | null): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("sealed-view", "sealed-view-locked");

    // A big padlock covering the pane makes the locked state unmistakable and
    // signals that the annotation/source is not editable here.
    const cover = root.createDiv({ cls: "sealed-lock-cover" });
    cover.createDiv({ cls: "sealed-lock-glyph", text: "🔒" });
    cover.createDiv({ cls: "sealed-lock-word", text: "已加密" });
    const box = cover.createDiv({ cls: "sealed-locked" });
    box.createEl("h3", { text: file?.basename ?? "加密笔记" });
    box.createEl("p", {
      text: "这篇笔记的内容已加密到独立的密文文件中，此处不能直接编辑。点击下方按钮，用你设置的方式解锁后，明文会就地写入本篇笔记，在原生 Markdown 编辑器里继续写作；锁定时立即加密回密文文件并恢复占位符。",
      cls: "sealed-hint",
    });
    const btn = box.createEl("button", { text: "解锁并编辑", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      if (file) void this.unlock(file);
    });
  }

  private async unlock(file: TFile | null): Promise<void> {
    if (!file || this.unlocking) return;
    // A workspace-restored tab can point at a note that was deleted while
    // Obsidian was closed. The TFile is stale; opening would silently fail and
    // leave the user stuck on the padlock. Say so plainly instead.
    if (!this.app.vault.getAbstractFileByPath(file.path)) {
      new Notice(`这篇笔记已不存在（${file.basename}），可能已被删除。请关闭此标签。`, 8000);
      return;
    }
    this.unlocking = true;
    try {
      await this.plugin.unlockNote(file);
    } catch (error) {
      this.log.error("open_failed", { path: file.path, error: String(error) });
      new Notice(describeError(error), 8000);
    } finally {
      this.unlocking = false;
    }
  }

  /* ---------------- menus ---------------- */

  onPaneMenu(menu: Menu, _source: string): void {
    super.onPaneMenu(menu, _source);
    // Working copies are normal Markdown files; locking is offered by the
    // plugin's global commands and the sealed view's unlock flow.
  }
}
