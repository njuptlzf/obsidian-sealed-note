/** Settings tab. Also the place where keyring state is made visible. */

import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type SealedNotePlugin from "../main";
import { keyFingerprint, describeGuardWait, guardRemainingMs } from "../core/keyring";
import { ConfirmModal, RecoveryKeyModal, SetupModal } from "./modals";
import { generateRecoveryKey } from "../core/recovery";
import { createKeyring } from "../core/keyring";
import { newVaultId } from "../core/keyring";
import { describeError } from "../util/errors";
import { t, LANGUAGE_OPTIONS, setLanguage } from "../i18n";
import type { Language } from "../i18n";

export class SealedNoteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SealedNotePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sealed-settings");

    containerEl.createEl("h2", { text: "Sealed Note" });

    void this.renderStatus(containerEl);
    this.renderSecurityNotice(containerEl);
    this.renderGeneral(containerEl);
    this.renderSecurity(containerEl);
    this.renderAdvanced(containerEl);
  }

  /* ---------------- status ---------------- */

  private async renderStatus(parent: HTMLElement): Promise<void> {
    const card = parent.createDiv({ cls: "sealed-card" });
    card.createEl("h3", { text: t("settings.status") });

    const exists = await this.plugin.hasKeyring();
    if (!exists) {
      card.createEl("p", { text: t("settings.noKey"), cls: "sealed-hint" });
      const btn = card.createEl("button", { text: t("settings.setupNow"), cls: "mod-cta" });
      btn.addEventListener("click", async () => {
        const result = await new Promise<{ password: string; hint: string } | null>((resolve) => {
          new SetupModal(this.app, resolve).open();
        });
        if (!result) return;
        const recovery = generateRecoveryKey();
        const vaultId = newVaultId();
        const { keyring, dek } = await createKeyring(vaultId, result.password, recovery, {
          hint: result.hint || undefined,
        });
        await this.plugin.keyringStore.save(keyring);
        (this.plugin as any).vaultIdentifier = vaultId;
        const fp = await keyFingerprint(dek);
        new RecoveryKeyModal(this.app, recovery, fp, this.app.vault.getName(), () => undefined).open();
        this.display();
      });
      return;
    }

    const kr = await this.plugin.unlockService.requireKeyring();

    new Setting(card)
      .setName(t("settings.password"))
      .setDesc(kr.slots.password ? `已设置 · 第 ${kr.slots.password.gen} 代` : t("settings.notSet"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.modify")).onClick(async () => {
          const dek = await this.plugin.unlockService.dekFor("__settings__", { subject: t("settings.changePassword") });
          if (!dek) return;
          const next = await promptPassword(this.app, t("settings.newPassword"));
          if (!next) return;
          await this.plugin.unlockService.changePassword(dek, next);
          new Notice(t("notice.passwordChanged"));
          this.display();
        }),
      );

    new Setting(card)
      .setName(t("settings.recovery"))
      .setDesc(kr.slots.recovery ? t("settings.recoveryDesc") : t("settings.recoveryMissing"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.regenerate")).onClick(async () => {
          const dek = await this.plugin.unlockService.dekFor("__settings__", { subject: t("settings.recovery") });
          if (!dek) return;
          const key = generateRecoveryKey();
          await this.plugin.unlockService.replaceRecovery(dek, key);
          const fp = await keyFingerprint(dek);
          new RecoveryKeyModal(this.app, key, fp, this.app.vault.getName(), () => this.display()).open();
        }),
      );

    const modeLabels: Record<string, string> = {
      password: t("settings.mode.password"),
      totp: t("settings.mode.totp"),
      "password+totp": t("settings.mode.both"),
    };
    const mode = kr.totp.mode ?? "password";
    const totpDesc = kr.totp.enabled
      ? `当前模式：${modeLabels[mode] ?? mode}。种子只保存在你的验证器 App 里。`
      : `未启用。当前模式：${modeLabels[mode] ?? mode}`;

    new Setting(card)
      .setName(t("settings.totp"))
      .setDesc(totpDesc)
      .addButton((btn) => {
        btn.setButtonText(kr.totp.enabled ? t("settings.change") : t("settings.configure")).onClick(async () => {
          await this.plugin.setupTotp();
          this.display();
        });
      });

    if (kr.totp.enabled) {
      new Setting(card)
        .setName(t("settings.importSeed"))
        .setDesc(t("settings.importSeedDesc"))
        .addButton((btn) =>
          btn.setButtonText(t("seedImport.import")).onClick(async () => {
            await this.plugin.restoreLocalTotpSeed();
            this.display();
          }),
        );

      const note = card.createEl("div", { cls: "sealed-hint" });
      note.appendText(
        t("settings.totpHintA") +
        t("settings.totpHintB") +
        t("seedImport.rebindHint"),
      );
    }

    const wait = guardRemainingMs(kr.guard);
    if (wait > 0) {
      card.createEl("p", { text: `正在限流中：${describeGuardWait(wait)}`, cls: "sealed-error" });
    }

    new Setting(card)
      .setName(t("settings.rebuild"))
      .setDesc(t("settings.rebuildDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.rebuildButton")).onClick(async () => {
          await this.plugin.rebuildKeyringFromNote();
          this.display();
        }),
      );

    card.createEl("p", {
      text: t("settings.keyringNote"),
      cls: "sealed-hint",
    });
  }

  /* ---------------- notices ---------------- */

  private renderSecurityNotice(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "sealed-warning" });
    box.createEl("strong", { text: t("settings.securityNoticeTitle") });
    box.appendText(
      t("settings.securityLong"),
    );
  }

  /* ---------------- general ---------------- */

  private renderGeneral(parent: HTMLElement): void {
    parent.createEl("h3", { text: t("settings.sectionNotes") });

    new Setting(parent)
      .setName(t("settings.language"))
      .setDesc(t("settings.languageDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(LANGUAGE_OPTIONS)
          .setValue(this.plugin.settingsData.language)
          .onChange(async (value) => {
            this.plugin.settingsData.language = value as Language;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(parent)
      .setName(t("settings.showBadges"))
      .setDesc(t("settings.showBadgesDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settingsData.showInlineBadges).onChange(async (value) => {
          this.plugin.settingsData.showInlineBadges = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(parent)
      .setName(t("settings.confirmDecrypt"))
      .setDesc(t("settings.confirmDecryptDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settingsData.confirmWholeNoteDecrypt).onChange(async (value) => {
          this.plugin.settingsData.confirmWholeNoteDecrypt = value;
          await this.plugin.saveSettings();
        }),
      );
  }

  /* ---------------- security ---------------- */

  private renderSecurity(parent: HTMLElement): void {
    parent.createEl("h3", { text: t("settings.sectionUnlock") });

    new Setting(parent)
      .setName(t("settings.keep"))
      .setDesc(t("settings.keepDesc"))
      .addDropdown((dropdown) => {
        const options: Record<string, string> = {
          "0": t("settings.keep0"),
          "60": t("settings.keep60"),
          "300": t("settings.keep300"),
          "900": t("settings.keep900"),
        };
        dropdown
          .addOptions(options)
          .setValue(String(this.plugin.settingsData.keepUnlockedSeconds))
          .onChange(async (value) => {
            this.plugin.settingsData.keepUnlockedSeconds = Number.parseInt(value, 10);
            await this.plugin.saveSettings();
          });
      });

    new Setting(parent)
      .setName(t("settings.lockBlur"))
      .setDesc(t("settings.lockBlurDesc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settingsData.lockOnBlur).onChange(async (value) => {
          this.plugin.settingsData.lockOnBlur = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(parent)
      .setName(t("settings.defaultProvider"))
      .setDesc(t("settings.defaultProviderDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ password: t("settings.password"), totp: "动态密码", recovery: t("settings.recovery") })
          .setValue(this.plugin.settingsData.defaultProvider)
          .onChange(async (value) => {
            this.plugin.settingsData.defaultProvider = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName(t("settings.clipboard"))
      .setDesc(t("settings.clipboardDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ "0": t("settings.clip0"), "30": t("settings.clip30"), "60": t("settings.clip60"), "120": t("settings.clip120") })
          .setValue(String(this.plugin.settingsData.clipboardClearSeconds))
          .onChange(async (value) => {
            this.plugin.settingsData.clipboardClearSeconds = Number.parseInt(value, 10);
            await this.plugin.saveSettings();
          }),
      );
  }

  /* ---------------- advanced ---------------- */

  private renderAdvanced(parent: HTMLElement): void {
    parent.createEl("h3", { text: t("settings.sectionAdvanced") });

    new Setting(parent)
      .setName(t("settings.offlineName"))
      .setDesc(t("settings.offlineDesc2"))
      .addButton((btn) =>
        btn.setButtonText(t("settings.info")).onClick(() => {
          new Notice(t("settings.infoBody"), 8000);
        }),
      );

    new Setting(parent)
      .setName(t("settings.lockAll"))
      .setDesc(t("settings.lockAllDesc"))
      .addButton((btn) =>
        btn.setButtonText(t("common.lock")).onClick(() => {
          const count = this.plugin.unlockService.lockAll();
          this.plugin.refreshStatusBar();
          new Notice(count ? `已锁定 ${count} 篇` : t("status.noneUnlocked2"));
        }),
      );
  }
}

/** Small prompt used only for changing the password. */
function promptPassword(app: App, title: string): Promise<string | null> {
  return new Promise((resolve) => {
    new PasswordPromptModal(app, title, resolve).open();
  });
}

class PasswordPromptModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly resolve: (value: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.title });
    this.contentEl.createEl("p", {
      text: t("common.min10Desc"),
      cls: "sealed-hint",
    });
    const input = this.contentEl.createEl("input", { type: "password" });
    input.addClass("sealed-input");
    const err = this.contentEl.createDiv({ cls: "sealed-error" });
    const actions = this.contentEl.createDiv({ cls: "sealed-actions" });
    const cancel = actions.createEl("button", { text: t("prompt.cancel") });
    cancel.addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("common.ok"), cls: "mod-cta" });
    ok.addEventListener("click", () => {
      if (input.value.length < 10) {
        err.setText(t("common.min10"));
        return;
      }
      this.settled = true;
      this.resolve(input.value);
      this.close();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") ok.click();
    });
    window.setTimeout(() => input.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolve(null);
  }
}
