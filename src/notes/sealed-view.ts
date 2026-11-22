/**
 * The ".sealed" note view.
 *
 * Core invariant: the file on disk is only ever ciphertext. The plaintext lives
 * in this view's editor buffer, which is in memory. Ctrl+S encrypts and writes;
 * the buffer is not the source of truth for what is stored.
 *
 * Why a custom view instead of a normal Markdown file with an encrypted body:
 * a normal .md file would put the ciphertext in the search index, in the graph,
 * in link suggestions, and in every other plugin's reach. A dedicated extension
 * keeps the ciphertext out of all of it. The trade off is that other tools
 * cannot read the file - the offline decryptor covers that case.
 */

import {
  FileView,
  ItemView,
  Menu,
  Notice,
  TFile,
  WorkspaceLeaf,
  MarkdownView,
  Editor,
} from "obsidian";
import type SealedNotePlugin from "../main";
import { describeError } from "../util/errors";
import { log } from "../util/log";

export const SEALED_VIEW_TYPE = "sealed-note-view";

export class SealedNoteView extends FileView {
  private readonly log = log.child("view");
  private plaintext = "";
  private dirty = false;
  private unlocking = false;
  private saveTimer: number | null = null;
  private textarea: HTMLTextAreaElement | null = null;

  /** This view cannot exist without a backing file. */
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
    return this.isUnlocked() ? "unlock" : "lock";
  }

  canAcceptExtension(extension: string): boolean {
    // Obsidian passes the registered token ("sealed"), not "md".
    return extension === this.plugin.extensionToken();
  }

  /* ---------------- lifecycle ---------------- */

  async onLoadFile(file: TFile): Promise<void> {
    this.render();
    await this.unlockAndLoad(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    // Leaving the note locks it: coming back must ask again (PRD).
    await this.flushPendingSave();
    this.plugin.unlockService.lock(file.path);
    this.plaintext = "";
    this.dirty = false;
    this.render();
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    if (this.file) this.plugin.unlockService.lock(this.file.path);
  }

  isUnlocked(): boolean {
    return !!this.file && this.plugin.unlockService.unlockedCount() > 0 && this.plaintextLoaded;
  }

  private plaintextLoaded = false;

  /* ---------------- unlock ---------------- */

  private async unlockAndLoad(file: TFile): Promise<void> {
    if (this.unlocking) return;
    this.unlocking = true;
    try {
      const dek = await this.plugin.unlockService.dekFor(file.path, {
        subject: file.basename,
      });
      if (!dek) {
        this.render();
        return;
      }
      this.plaintext = await this.plugin.notes.readPlaintext(file, dek, this.plugin.vaultId());
      this.plaintextLoaded = true;
      this.dirty = false;
      this.render();
      this.plugin.refreshStatusBar();
    } catch (error) {
      this.log.error("open_failed", { path: file.path, error: String(error) });
      new Notice(describeError(error), 8000);
      this.render();
    } finally {
      this.unlocking = false;
    }
  }

  /* ---------------- render ---------------- */

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("sealed-view");

    if (!this.plaintextLoaded) {
      this.renderLocked(root);
      return;
    }

    const bar = root.createDiv({ cls: "sealed-toolbar" });
    bar.createSpan({ text: "🔓 已解锁 · 保存后写入密文", cls: "sealed-toolbar-label" });
    const lockBtn = bar.createEl("button", { text: "锁定", cls: "sealed-btn" });
    lockBtn.addEventListener("click", () => {
      if (this.file) {
        this.plugin.unlockService.lock(this.file.path);
        this.plaintext = "";
        this.plaintextLoaded = false;
        this.dirty = false;
        this.render();
        this.plugin.refreshStatusBar();
      }
    });

    const area = root.createEl("textarea", { cls: "sealed-editor" });
    area.value = this.plaintext;
    area.spellcheck = false;
    this.textarea = area;
    area.addEventListener("input", () => {
      this.plaintext = area.value;
      this.dirty = true;
      this.scheduleSave();
    });
    area.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.save();
      }
    });
    window.setTimeout(() => area.focus(), 20);
  }

  private renderLocked(root: HTMLElement): void {
    const box = root.createDiv({ cls: "sealed-locked" });
    box.createDiv({ cls: "sealed-locked-icon", text: "🔒" });
    box.createEl("h3", { text: this.file?.basename ?? "加密笔记" });
    box.createEl("p", {
      text: "这篇笔记以密文形式保存在磁盘上。点击下方按钮解锁查看。",
      cls: "sealed-hint",
    });
    const btn = box.createEl("button", { text: "解锁", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      if (this.file) void this.unlockAndLoad(this.file);
    });
  }

  /* ---------------- save ---------------- */

  private scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      void this.save();
    }, this.plugin.config().autoSaveMs ?? 1500);
  }

  async save(): Promise<void> {
    if (!this.file || !this.plaintextLoaded || !this.dirty) return;
    const dek = await this.plugin.unlockService.dekFor(this.file.path);
    if (!dek) return;
    try {
      const kr = await this.plugin.unlockService.requireKeyring();
      await this.plugin.notes.writePlaintext(
        this.file,
        dek,
        this.plugin.vaultId(),
        this.plugin.vaultId(),
        this.plaintext,
        kr,
      );
      this.dirty = false;
      this.log.info("note_saved", { path: this.file.path });
    } catch (error) {
      new Notice(`保存失败：${describeError(error)}`, 8000);
      this.log.error("save_failed", { path: this.file.path, error: String(error) });
    }
  }

  private async flushPendingSave(): Promise<void> {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) await this.save();
  }

  /* ---------------- menus ---------------- */

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    const file = this.file;
    if (!file) return;
    menu.addItem((item) =>
      item
        .setTitle("锁定这篇笔记")
        .setIcon("lock")
        .onClick(() => {
          this.plugin.unlockService.lock(file.path);
          this.plaintext = "";
          this.plaintextLoaded = false;
          this.render();
          this.plugin.refreshStatusBar();
        }),
    );
  }

  /** Expose the buffer so commands can operate on it. */
  getPlaintext(): string {
    return this.plaintext;
  }

  setPlaintext(value: string): void {
    this.plaintext = value;
    this.dirty = true;
    if (this.textarea) this.textarea.value = value;
    this.scheduleSave();
  }
}