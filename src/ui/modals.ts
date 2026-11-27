/**
 * Dialogs. Every user facing string about security lives here and nowhere else,
 * so the promise we make is stated once.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { ProviderId, UnlockProvider } from "../core/providers";
import { UnlockPrompt } from "../services/unlock-service";
import { groupRecovery } from "../core/recovery";
import { t } from "../i18n";
import { totpRemainingSeconds } from "../core/totp";

/* ------------------------------------------------------------------ */
/* unlock dialog                                                       */
/* ------------------------------------------------------------------ */

export interface UnlockAnswer {
  providerId: ProviderId;
  secret: string;
  code?: string;
  totpSeed?: string;
}

export class UnlockModal extends Modal {
  private values: Record<string, string> = {};
  private errorEl: HTMLElement | null = null;
  private provider: UnlockProvider;
  private error: string | undefined;
  private resolved = false;
  private totpTimer: number | null = null;
  private totpHintEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly request: UnlockPrompt,
    private readonly resolve: (value: UnlockAnswer | null) => void,
    /** whether a usable seed exists on this device right now */
    private readonly hasLocalSeed: () => Promise<boolean>,
  ) {
    super(app);
    this.provider = request.provider;
    this.error = request.error;
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    // Re-render happens on provider/tab switches: stop the old ticker first so
    // timers never stack up.
    if (this.totpTimer !== null) {
      window.clearInterval(this.totpTimer);
      this.totpTimer = null;
    }
    this.totpHintEl = null;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal", "sealed-unlock");

    const encrypting = this.request.verb === "encrypt";
    contentEl.createEl("h2", {
      text: this.request.subject
        ? t(encrypting ? "prompt.encryptTitle" : "prompt.unlockTitle", { name: this.request.subject })
        : t(encrypting ? "prompt.encrypt" : "prompt.unlock"),
    });

    if (this.request.providers.length > 1) {
      const tabs = contentEl.createDiv({ cls: "sealed-tabs" });
      for (const p of this.request.providers) {
        const tab = tabs.createEl("button", {
          text: p.label,
          cls: p.id === this.provider.id ? "sealed-tab is-active" : "sealed-tab",
        });
        tab.addEventListener("click", () => {
          this.provider = p;
          this.error = undefined;
          this.values = {};
          this.render();
        });
      }
    }

    contentEl.createEl("p", { text: this.provider.hint, cls: "sealed-hint" });

    for (const field of this.provider.fields) {
      const setting = new Setting(contentEl).setName(field.label).addText((text) => {
        text.setPlaceholder(field.placeholder);
        text.setValue(this.values[field.key] ?? "");
        if (field.kind === "password") text.inputEl.type = "password";
        if (field.numeric) {
          text.inputEl.inputMode = "numeric";
          text.inputEl.autocomplete = "one-time-code";
        }
        if (field.maxLength) text.inputEl.maxLength = field.maxLength;
        text.inputEl.addClass("sealed-input");
        text.inputEl.addEventListener("input", () => (this.values[field.key] = text.getValue()));
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
        if (field.key === "secret") window.setTimeout(() => text.inputEl.focus(), 30);
      });
      setting.settingEl.addClass("sealed-field");
    }

    // No seed input here on purpose. Restoring the device-local seed is a
    // single explicit action in settings; the unlock dialog only tells you
    // what to do if this device has no usable seed.
    if (this.provider.id === "totp" || this.provider.id === "password+totp") {
      void this.hasLocalSeed().then((ok) => {
        if (!ok && !this.resolved) {
          contentEl.createEl("p", {
            text: t("prompt.seedMissing"),
            cls: "sealed-error",
          });
        }
      });
      const hint = contentEl.createEl("p", {
        text: "",
        cls: "sealed-hint sealed-totp-hint",
      });
      this.totpHintEl = hint;
      const tick = () => {
        if (!this.totpHintEl) return;
        this.totpHintEl.setText(
          t("prompt.codeRemaining", { n: 30, left: totpRemainingSeconds() }),
        );
      };
      tick();
      this.totpTimer = window.setInterval(tick, 1000);
    }

    this.errorEl = contentEl.createDiv({ cls: "sealed-error" });
    if (this.error) this.errorEl.setText(this.error);

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", {
      text: t(this.request.verb === "encrypt" ? "prompt.encrypt" : "prompt.enter"),
      cls: "mod-cta",
    });
    ok.addEventListener("click", () => this.submit());

    if (this.provider.caution) {
      contentEl.createEl("p", { text: this.provider.caution, cls: "sealed-caution" });
    }
  }

  private submit(): void {
    const missing = this.provider.fields.find((f) => !this.values[f.key]?.trim());
    if (missing) {
      this.errorEl?.setText(t("prompt.fillField", { field: missing.label }));
      return;
    }
    this.resolved = true;
    this.resolve({
      providerId: this.provider.id,
      secret: this.values.secret ?? "",
      code: this.values.code,
      totpSeed: undefined,
    });
    this.close();
  }

  onClose(): void {
    if (this.totpTimer !== null) {
      window.clearInterval(this.totpTimer);
      this.totpTimer = null;
    }
    this.totpHintEl = null;
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

/* ------------------------------------------------------------------ */
/* first run wizard                                                    */
/* ------------------------------------------------------------------ */

export interface SetupResult {
  password: string;
  hint: string;
}

export class SetupModal extends Modal {
  private password = "";
  private confirm = "";
  private hint = "";
  private errorEl: HTMLElement | null = null;
  private weakEl: HTMLElement | null = null;
  private done = false;

  constructor(
    app: App,
    private readonly resolve: (value: SetupResult | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal", "sealed-setup");

    contentEl.createEl("h2", { text: t("setup.title") });

    contentEl.createEl("p", {
      cls: "sealed-warning",
      text:
        t("setup.caution2"),
    });

    new Setting(contentEl)
      .setName(t("settings.password"))
      .setDesc(t("setup.passwordDesc"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.addEventListener("input", () => {
          this.password = text.getValue();
          this.renderStrength();
        });
        window.setTimeout(() => text.inputEl.focus(), 30);
      });

    this.weakEl = contentEl.createDiv({ cls: "sealed-strength" });

    new Setting(contentEl).setName(t("setup.confirm")).addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.addEventListener("input", () => (this.confirm = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
    });

    new Setting(contentEl)
      .setName(t("setup.hint"))
      .setDesc(t("setup.hintDesc"))
      .addText((text) => {
        text.setPlaceholder(t("settings.hintExample"));
        text.inputEl.addEventListener("input", () => (this.hint = text.getValue()));
      });

    this.errorEl = contentEl.createDiv({ cls: "sealed-error" });

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("setup.next"), cls: "mod-cta" });
    ok.addEventListener("click", () => this.submit());
  }

  private renderStrength(): void {
    if (!this.weakEl) return;
    const score = passwordScore(this.password);
    this.weakEl.setText(
      this.password.length === 0
        ? ""
        : score < 2
          ? t("setup.weak")
          : score < 3
            ? t("settings.strengthMedium")
            : t("setup.ok"),
    );
    this.weakEl.toggleClass("is-weak", this.password.length > 0 && score < 2);
  }

  private submit(): void {
    if (this.password.length < 10) {
      this.errorEl?.setText(t("setup.need10"));
      return;
    }
    if (this.password !== this.confirm) {
      this.errorEl?.setText(t("setup.mismatch"));
      return;
    }
    this.done = true;
    this.resolve({ password: this.password, hint: this.hint.trim() });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) this.resolve(null);
  }
}

/** Very rough, deliberately not pretending to be zxcvbn. */
export function passwordScore(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (/^(.)\1+$/.test(password)) score = 0;
  return Math.min(4, score);
}

/* ------------------------------------------------------------------ */
/* recovery key reveal                                                 */
/* ------------------------------------------------------------------ */

export class RecoveryKeyModal extends Modal {
  private acknowledged = false;
  private done = false;
  /** Only an explicit close (title-bar × or 完成) may dismiss this modal. */
  private dismissalAllowed = false;
  private closed = false;
  private settled = false;

  constructor(
    app: App,
    private readonly key: string,
    private readonly fingerprint: string,
    private readonly vaultName: string,
    private readonly resolve: (saved: boolean) => void,
  ) {
    super(app);
  }

  /**
   * Obsidian routes backdrop clicks and Escape through close(). Neither may be
   * allowed to make the one-time recovery key vanish behind the user, so those
   * calls are ignored here. The title-bar × is marked as explicit in the
   * capture-phase listener installed in onOpen(), and 完成 goes through
   * acknowledge().
   */
  close(): void {
    if (this.closed || !this.dismissalAllowed) return;
    this.closed = true;
    super.close();
  }

  /** Resolve the setup promise exactly once, whichever explicit path got here. */
  private settle(saved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(saved);
  }

  /** Explicit, non-saving dismissal (the title-bar ×). */
  dismissByCloseButton(): void {
    this.dismissalAllowed = true;
    this.settle(false);
    this.close();
  }

  /** The 完成 button: the user confirmed they saved the key. */
  acknowledge(): void {
    if (this.done) return;
    this.done = true;
    this.dismissalAllowed = true;
    this.settle(true);
    this.close();
  }

  onOpen(): void {
    // Obsidian's own × lives in the title bar and calls close(). Tag that click
    // as explicit before Obsidian's bubble handler runs; every other close
    // source (backdrop, Escape) leaves dismissalAllowed false and is ignored.
    this.modalEl?.addEventListener(
      "click",
      (event) => {
        const target = event.target as HTMLElement | null;
        if (target && typeof target.closest === "function" && target.closest(".modal-close-button")) {
          this.dismissalAllowed = true;
        }
      },
      true,
    );

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal", "sealed-recovery");

    contentEl.createEl("h2", { text: t("recovery.title") });

    contentEl.createEl("p", {
      cls: "sealed-warning",
      text:
        t("recovery.warning"),
    });
    contentEl.createEl("p", {
      cls: "sealed-warning",
      text: t("recovery.shareWarning"),
    });

    const box = contentEl.createDiv({ cls: "sealed-key-box" });
    const formatted = groupRecovery(this.key.replace(/-/g, ""));
    box.setText(formatted);
    contentEl.createEl("p", { text: t("recovery.fingerprint", { fp: this.fingerprint }), cls: "sealed-hint" });

    const actions = contentEl.createDiv({ cls: "sealed-actions sealed-actions-wrap" });
    const copy = actions.createEl("button", { text: t("recovery.copy") });
    copy.addEventListener("click", () => {
      void (async () => {
        await navigator.clipboard.writeText(formatted);
        new Notice(t("recovery.copied"));
      })();
    });

    const download = actions.createEl("button", { text: t("recovery.download") });
    download.addEventListener("click", () => {
      const body = [
        t("recovery.fileTitle"),
        t("recovery.fileVault", { vault: this.vaultName }),
        t("recovery.fileFingerprint", { fp: this.fingerprint }),
        "",
        formatted,
        "",
        t("recovery.fileUse"),
        t("recovery.fileWarn"),
      ].join("\n");
      const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = activeDocument.createElement("a");
      a.href = url;
      a.download = `sealed-note-recovery-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const ack = contentEl.createDiv({ cls: "sealed-ack" });
    const checkbox = ack.createEl("input", { type: "checkbox" });
    checkbox.id = "sealed-ack-box";
    const label = ack.createEl("label", { text: t("recovery.ack") });
    label.setAttribute("for", "sealed-ack-box");
    checkbox.addEventListener("change", () => {
      this.acknowledged = checkbox.checked;
      ok.disabled = !this.acknowledged;
    });

    const foot = contentEl.createDiv({ cls: "sealed-actions" });
    const ok = foot.createEl("button", { text: t("recovery.done"), cls: "mod-cta" });
    ok.disabled = true;
    ok.addEventListener("click", () => this.acknowledge());
  }

  onClose(): void {
    this.contentEl.empty();
    // Safety net for a close Obsidian initiates outside close() (unload, etc).
    // Normal dismissal already settled via acknowledge()/dismissByCloseButton().
    this.settle(false);
  }
}

/* ------------------------------------------------------------------ */
/* generic confirm                                                     */
/* ------------------------------------------------------------------ */

export class ConfirmModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private readonly opts: {
      title: string;
      body: string;
      confirmText: string;
      danger?: boolean;
      /** require typing this exact string to enable the button */
      typeToConfirm?: string;
    },
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal");
    contentEl.createEl("h2", { text: this.opts.title });
    for (const paragraph of this.opts.body.split("\n\n")) {
      contentEl.createEl("p", { text: paragraph });
    }

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", {
      text: this.opts.confirmText,
      cls: this.opts.danger ? "mod-warning" : "mod-cta",
    });

    if (this.opts.typeToConfirm) {
      ok.disabled = true;
      const field = new Setting(contentEl).setName(t("modal.typeToConfirm", { value: this.opts.typeToConfirm }));
      field.addText((text) => {
        text.inputEl.addEventListener("input", () => {
          ok.disabled = text.getValue() !== this.opts.typeToConfirm;
        });
      });
    }

    ok.addEventListener("click", () => {
      this.done = true;
      this.resolve(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) this.resolve(false);
  }
}