/** Ask the user to paste an otpauth:// URI to restore the local seed cache. */

import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export class SeedImportModal extends Modal {
  private settled = false;
  private value = "";

  constructor(
    app: App,
    private readonly resolve: (uri: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");
    contentEl.createEl("h2", { text: t("seedImport.title") });
    contentEl.createEl("p", { text: t("seedImport.desc"), cls: "sealed-hint" });
    contentEl.createEl("p", { text: t("seedImport.steps"), cls: "sealed-hint" });

    new Setting(contentEl).addText((text) => {
      text.setPlaceholder("otpauth://totp/...");
      text.inputEl.addClass("sealed-input");
      text.inputEl.addEventListener("input", () => (this.value = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => text.inputEl.focus(), 30);
    });

    const err = contentEl.createDiv({ cls: "sealed-error" });
    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("seedImport.import"), cls: "mod-cta" });
    ok.addEventListener("click", () => {
      const v = this.value.trim();
      if (!v.startsWith("otpauth://")) {
        err.setText(t("seedImport.invalid"));
        return;
      }
      this.settled = true;
      this.resolve(v);
      this.close();
    });
  }

  private submit(): void {
    const v = this.value.trim();
    if (!v.startsWith("otpauth://")) return;
    this.settled = true;
    this.resolve(v);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}
