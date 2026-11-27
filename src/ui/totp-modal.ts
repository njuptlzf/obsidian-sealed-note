/**
 * TOTP enrolment. Shows the secret once, plus an otpauth:// URI for the
 * authenticator, and requires the user to prove they can generate a code before
 * the method is enabled - otherwise they could lock themselves into a factor
 * they cannot reproduce.
 */

import { t } from "../i18n";
import { App, Modal, Notice, Setting } from "obsidian";
import QRCode from "qrcode";
import { generateTotpSecret, totpUri, formatSecret, verifyTotp } from "../core/totp";

export class TotpSetupModal extends Modal {
  private readonly secret = generateTotpSecret();
  private code = "";
  private errorEl: HTMLElement | null = null;
  private done = false;

  constructor(
    app: App,
    private readonly account: string,
    private readonly resolve: (value: { seed: string; otpauth: string } | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sealed-modal", "sealed-totp-setup");

    contentEl.createEl("h2", { text: t("totp.title") });

    contentEl.createEl("p", {
      cls: "sealed-warning",
      text:
        t("totp.warningA") +
        t("totp.warningB"),
    });

    // Local QR generation only. Never send the otpauth URI to an online
    // QR service - that would hand your second factor to a third party.
    contentEl.createEl("p", { text: t("totp.scan") });
    const qrHost = contentEl.createDiv({ cls: "sealed-qr" });
    void QRCode.toDataURL(totpUri(this.secret, this.account), {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
      .then((url: string) => {
        qrHost.empty();
        const img = qrHost.createEl("img", { cls: "sealed-qr-img" });
        img.setAttribute("src", url);
        img.setAttribute("alt", t("totp.qrAlt"));
      })
      .catch(() => {
        qrHost.setText(t("totp.qrFailed"));
      });

    contentEl.createEl("p", { text: t("totp.manual") });
    const box = contentEl.createDiv({ cls: "sealed-key-box" });
    box.setText(formatSecret(this.secret, 4));

    const copyBtn = contentEl.createEl("button", { text: t("totp.copyKey"), cls: "sealed-btn" });
    copyBtn.addEventListener("click", () => {
      void (async () => {
        await navigator.clipboard.writeText(this.secret);
        new Notice(t("totp.keyCopied"));
      })();
    });

    contentEl.createEl("p", {
      text: t("totp.uriHint"),
      cls: "sealed-hint",
    });
    const uri = contentEl.createEl("code", { cls: "sealed-uri" });
    uri.setText(totpUri(this.secret, this.account));

    contentEl.createEl("p", { text: t("totp.verify") });

    new Setting(contentEl).addText((text) => {
      text.setPlaceholder("000000");
      text.inputEl.inputMode = "numeric";
      text.inputEl.maxLength = 6;
      text.inputEl.addEventListener("input", () => (this.code = text.getValue()));
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.submit();
      });
      window.setTimeout(() => text.inputEl.focus(), 30);
    });

    this.errorEl = contentEl.createDiv({ cls: "sealed-error" });

    const actions = contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("totp.enable"), cls: "mod-cta" });
    ok.addEventListener("click", () => void this.submit());
  }

  private async submit(): Promise<void> {
    const cleaned = this.code.replace(/\D/g, "");
    if (cleaned.length !== 6) {
      this.errorEl?.setText(t("totp.wrongCodeShort"));
      return;
    }
    if (!(await verifyTotp(this.secret, cleaned))) {
      this.errorEl?.setText(t("totp.badCode"));
      return;
    }
    this.done = true;
    this.resolve({ seed: this.secret, otpauth: totpUri(this.secret, this.account) });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) this.resolve(null);
  }
}