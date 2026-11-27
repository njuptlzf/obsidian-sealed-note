/** Choosing an unlock mode, plus a reusable password prompt. */

import { t } from "../i18n";
import { App, Modal, Setting } from "obsidian";
import type { UnlockMode } from "../core/keyring";

const MODE_OPTIONS: Array<{ id: UnlockMode; title: string; desc: string }> = [
  {
    id: "password+totp",
    title: t("mode.both.title"),
    desc: t("mode.bothDesc2"),
  },
  {
    id: "password",
    title: t("settings.mode.password"),
    desc: t("mode.password.desc"),
  },
  {
    id: "totp",
    title: t("settings.mode.totp"),
    desc: t("mode.totp.desc"),
  },
];

export class UnlockModeModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly resolve: (mode: UnlockMode | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");
    contentEl.createEl("h2", { text: t("mode.title") });
    contentEl.createEl("p", {
      text: t("mode.hint"),
      cls: "sealed-hint",
    });

    for (const option of MODE_OPTIONS) {
      const card = contentEl.createDiv({ cls: "sealed-mode-option" });
      card.createDiv({ text: option.title, cls: "sealed-mode-title" });
      card.createDiv({ text: option.desc, cls: "sealed-hint" });
      const btn = card.createEl("button", {
        text: option.id === "password" ? t("mode.switch") : t("settings.configure"),
        cls: "mod-cta",
      });
      btn.addEventListener("click", () => {
        this.settled = true;
        this.resolve(option.id);
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

/** Small password prompt with confirmation, used when combining with TOTP. */
export class PasswordPromptModal extends Modal {
  private settled = false;
  private value = "";
  private confirm = "";

  constructor(
    app: App,
    private readonly title: string,
    private readonly resolve: (password: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");
    contentEl.createEl("h2", { text: this.title });

    new Setting(contentEl).setName(t("settings.password")).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addEventListener("input", () => (this.value = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 30);
    });
    new Setting(contentEl).setName(t("setup.confirm")).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addEventListener("input", () => (this.confirm = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    const err = contentEl.createDiv({ cls: "sealed-error" });
    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("common.ok"), cls: "mod-cta" });
    ok.addEventListener("click", () => this.submit());

    function noop(): void { void err; void ok; }
    noop();
  }

  private submit(): void {
    const errEl = this.contentEl.querySelector<HTMLElement>(".sealed-error");
    if (this.value.length < 10) {
      errEl?.setText(t("common.min10"));
      return;
    }
    if (this.value !== this.confirm) {
      errEl?.setText(t("setup.mismatch"));
      return;
    }
    this.settled = true;
    this.resolve(this.value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}
