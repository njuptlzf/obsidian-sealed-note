/**
 * Dialogs for rebuilding a lost keyring from a note's embedded key copy.
 */

import { t } from "../i18n";
import { App, Modal, Setting } from "obsidian";
import type { RecoveryCandidate } from "../services/vault-recovery";

export class CandidatePickerModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly candidates: RecoveryCandidate[],
    private readonly resolve: (candidate: RecoveryCandidate | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");

    contentEl.createEl("h2", { text: t("picker.title") });
    contentEl.createEl("p", {
      cls: "sealed-hint",
      text:
        t("picker.desc"),
    });

    const list = contentEl.createDiv({ cls: "sealed-candidate-list" });
    for (const candidate of this.candidates) {
      const item = list.createDiv({ cls: "sealed-candidate" });
      item.createDiv({ text: candidate.file.path, cls: "sealed-candidate-path" });
      const slots = Object.keys(candidate.keyCopy.slots);
      item.createDiv({
        text: t("recovery.epochSlots", { epoch: candidate.keyCopy.epoch, slots: slots.join(" / ") }),
        cls: "sealed-hint",
      });
      const btn = item.createEl("button", { text: t("picker.use"), cls: "mod-cta" });
      btn.addEventListener("click", () => {
        this.settled = true;
        this.resolve(candidate);
        this.close();
      });
    }

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}

export class SecretPromptModal extends Modal {
  private settled = false;
  private value = "";

  constructor(
    app: App,
    private readonly title: string,
    private readonly description: string,
    private readonly resolve: (secret: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");

    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.description, cls: "sealed-hint" });

    new Setting(contentEl).addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder(t("prompt.recovery"));
      text.inputEl.addEventListener("input", () => (this.value = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 30);
    });

    const err = contentEl.createDiv({ cls: "sealed-error" });

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("picker.verify"), cls: "mod-cta" });
    ok.addEventListener("click", () => {
      if (!this.value.trim()) {
        err.setText(t("prompt.enterContent"));
        return;
      }
      this.settled = true;
      this.resolve(this.value);
      this.close();
    });
  }

  private submit(): void {
    if (!this.value.trim()) return;
    this.settled = true;
    this.resolve(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}