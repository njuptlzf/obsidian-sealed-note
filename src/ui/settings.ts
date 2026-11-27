/** Settings tab. Also the place where keyring state is made visible. */

import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type SealedNotePlugin from "../main";
import { describeGuardWait, guardRemainingMs, SLOT_PASSWORD } from "../core/keyring";
import { describeError } from "../util/errors";
import { t, LANGUAGE_OPTIONS, setLanguage } from "../i18n";
import type { Language } from "../i18n";
import type { LockPolicy } from "../settings";

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
        // Use the real wizard: it registers the keyring in memory and lets the
        // first note carry the key copy. The old inline path minted a keyring
        // with no note to hold it, so it vanished on restart.
        await this.plugin.setupFromSettings();
        this.display();
      });
      return;
    }

    const kr = await this.plugin.unlockService.requireKeyring();

    // Combined mode folds the password into the two-factor credential; there is
    // deliberately no standalone password slot to report on. Saying "not set"
    // would imply a gap that is the whole point.
    const combinedMode = kr.totp.enabled && kr.totp.mode === "password+totp";
    const passwordDesc = kr.slots.password
      ? t("settings.passwordSetGen", { gen: kr.slots.password.gen })
      : combinedMode
        ? t("settings.strictCombined")
        : t("settings.notSet");

    new Setting(card)
      .setName(t("settings.password"))
      .setDesc(passwordDesc)
      .addButton((btn) =>
        btn.setButtonText(t("settings.modify")).onClick(async () => {
          const dek = await this.plugin.unlockService.dekFor("__settings__", { subject: t("settings.changePassword") });
          if (!dek) return;
          const next = await promptPassword(this.app, t("settings.newPassword"));
          if (!next) return;
          try {
            await this.plugin.unlockService.changePassword(dek, next);
            new Notice(t("notice.passwordChanged"));
          } catch (error) {
            new Notice(describeError(error), 10000);
            return;
          }
          this.display();
        }),
      );

    new Setting(card)
      .setName(t("settings.recovery"))
      .setDesc(kr.slots.recovery ? t("settings.recoveryDesc") : t("settings.recoveryMissing"))
      .addButton((btn) =>
        btn
          .setButtonText(kr.slots.recovery ? t("settings.resetRecovery") : t("settings.setRecovery"))
          .onClick(async () => {
            await this.plugin.setOrResetRecoveryKey();
            this.display();
          }),
      );

    card.createEl("p", { text: t("recovery.shareWarning"), cls: "sealed-hint" });

    const modeLabels: Record<string, string> = {
      password: t("settings.mode.password"),
      totp: t("settings.mode.totp"),
      "password+totp": t("settings.mode.both"),
    };
    const mode = kr.totp.mode ?? "password";
    const totpDesc = kr.totp.enabled
      ? t("settings.currentMode", { mode: modeLabels[mode] ?? mode })
      : t("settings.modeOff", { mode: modeLabels[mode] ?? mode });

    new Setting(card)
      .setName(t("settings.modeSwitch"))
      .setDesc(totpDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(modeLabels)
          .setValue(mode)
          .onChange(async (value) => {
            if (value === mode) return;
            await this.plugin.switchUnlockMode(value as "password" | "totp" | "password+totp");
            this.display();
          }),
      );

    // Old combined-mode vaults have a standalone password slot beside the
    // combined one - the single-factor hole. Offer to close it in one click.
    if (kr.totp.enabled && mode === "password+totp" && kr.slots[SLOT_PASSWORD]) {
      new Setting(card)
        .setName(t("settings.harden.title"))
        .setDesc(t("settings.harden.desc"))
        .addButton((btn) =>
          btn.setButtonText(t("settings.harden.button")).setWarning().onClick(async () => {
            const dek = await this.plugin.unlockService.dekFor("__settings__", { subject: t("settings.harden.title") });
            if (!dek) return;
            try {
              await this.plugin.unlockService.hardenCombinedMode();
              await this.plugin.keyCopies.refreshAll(await this.plugin.unlockService.requireKeyring());
              new Notice(t("settings.harden.done"), 10000);
            } catch (error) {
              new Notice(describeError(error), 10000);
            }
            this.display();
          }),
        );
    }

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
      card.createEl("p", { text: t("status.rateLimited", { wait: describeGuardWait(wait) }), cls: "sealed-error" });
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
      .setName(t("settings.lockBlur"))
      .setDesc(t("settings.lockBlurDesc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            blur: t("settings.lockPolicy.blur"),
            close: t("settings.lockPolicy.close"),
            session: t("settings.lockPolicy.session"),
          })
          .setValue(this.plugin.settingsData.lockPolicy)
          .onChange(async (value) => {
            this.plugin.settingsData.lockPolicy = value as LockPolicy;
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
          new Notice(count ? t("notice.lockedN", { n: count }) : t("status.noneUnlocked2"));
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
