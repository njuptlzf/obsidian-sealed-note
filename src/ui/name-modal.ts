/** Simple text-input modal, used to name a new private note. */

import { App, Modal } from "obsidian";
import { t } from "../i18n";

export class NameModal extends Modal {
  private value = "";
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly label: string,
    private readonly defaultValue: string,
    private readonly hint: string,
    private readonly resolve: (name: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal", "sealed-name");
    contentEl.createEl("h2", { text: this.title });

    const input = contentEl.createEl("input");
    input.type = "text";
    input.value = this.defaultValue;
    input.placeholder = this.label;
    input.addEventListener("input", () => (this.value = (input as HTMLInputElement).value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
    });

    contentEl.createEl("p", { text: this.hint, cls: "sealed-hint" });

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    actions.createEl("button", { text: t("prompt.cancel") }).addEventListener("click", () => this.close());
    actions
      .createEl("button", { text: t("common.create"), cls: "mod-cta" })
      .addEventListener("click", () => this.submit());
    window.setTimeout(() => {
      (input as HTMLInputElement).focus();
      (input as HTMLInputElement).select();
    }, 30);
  }

  private submit(): void {
    if (this.settled) return;
    const name = (this.value || this.defaultValue).trim();
    if (!name) return;
    this.settled = true;
    this.resolve(name);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}
