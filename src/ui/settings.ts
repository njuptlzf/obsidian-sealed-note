/** Settings tab. Also the place where keyring state is made visible. */

import { App, Modal, Notice, PluginSettingTab, Setting, requireApiVersion } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type SealedNotePlugin from "../main";
import { describeGuardWait, guardRemainingMs, SLOT_PASSWORD } from "../core/keyring";
import { describeError } from "../util/errors";
import { t, LANGUAGE_OPTIONS } from "../i18n";
import type { Language } from "../i18n";
import type { LockPolicy } from "../settings";

/** i18n keys of the private-block quick guide, in render order. */
const BLOCK_HELP_KEYS = [
  "settings.blockHelp1",
  "settings.blockHelp2",
  "settings.blockHelp3",
  "settings.blockHelp4",
] as const;

export class SealedNoteSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SealedNotePlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Declarative definitions (Obsidian 1.13+) make these settings searchable.
   * The dynamic keyring status card stays in `display()` for older versions;
   * on 1.13+ Obsidian renders these definitions instead and skips display().
   * Both paths must stay in sync when a setting is added or changed.
   *
   * `getControlValue`/`setControlValue` below route the declarative controls
   * to the plugin's `settingsData` (it does not use the reserved `settings`
   * member), and `setControlValue` goes through `saveSettings()` so the
   * language and status bar stay in sync.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t("settings.sectionNotes"),
        control: { type: "dropdown", key: "language", options: LANGUAGE_OPTIONS },
      },
      {
        name: t("settings.showBadges"),
        desc: t("settings.showBadgesDesc"),
        control: { type: "toggle", key: "showInlineBadges" },
      },
      {
        // Info row: declarative `desc` strings render as one paragraph, which
        // buries a four-part guide. `render` gives us per-line <p> elements;
        // the joined `desc` still feeds settings search (textContent is used).
        name: t("settings.blockHelpTitle"),
        desc: BLOCK_HELP_KEYS.map((key) => t(key)).join(" "),
        aliases: t("settings.blockHelpAliases").split(",").map((s) => s.trim()),
        render: (setting) => {
          setting.descEl.empty();
          for (const key of BLOCK_HELP_KEYS) {
            setting.descEl.createEl("p", { text: t(key), cls: "sealed-hint" });
          }
        },
      },
      {
        name: t("settings.confirmDecrypt"),
        desc: t("settings.confirmDecryptDesc"),
        control: { type: "toggle", key: "confirmWholeNoteDecrypt" },
      },
      {
        name: t("settings.lockBlur"),
        desc: t("settings.lockBlurDesc"),
        control: {
          type: "dropdown",
          key: "lockPolicy",
          options: {
            blur: t("settings.lockPolicy.blur"),
            close: t("settings.lockPolicy.close"),
            session: t("settings.lockPolicy.session"),
          },
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    const values = this.plugin.settingsData as unknown as Record<string, unknown>;
    return values[key];
  }

  setControlValue(key: string, value: unknown): void {
    (this.plugin.settingsData as unknown as Record<string, unknown>)[key] = value;
    void this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sealed-settings");

    void this.renderStatus(containerEl);
    this.renderSecurityNotice(containerEl);
    this.renderGeneral(containerEl);
    this.renderSecurity(containerEl);
    this.renderAdvanced(containerEl);
  }

  /* ---------------- status ---------------- */

  private async renderStatus(parent: HTMLElement): Promise<void> {
    const card = parent.createDiv({ cls: "sealed-card" });
    new Setting(card).setName(t("settings.status")).setHeading();

    const exists = await this.plugin.hasKeyring();
    if (!exists) {
      card.createEl("p", { text: t("settings.noKey"), cls: "sealed-hint" });
      const btn = card.createEl("button", { text: t("settings.setupNow"), cls: "mod-cta" });
      btn.addEventListener("click", () => {
        // Use the real wizard: it registers the keyring in memory and lets the
        // first note carry the key copy. The old inline path minted a keyring
        // with no note to hold it, so it vanished on restart.
        void (async () => {
          await this.plugin.setupFromSettings();
          this.display();
        })();
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
        .addButton((btn) => {
          btn.setButtonText(t("settings.harden.button"));
          // setDestructive() arrived in 1.13.0; keep the older CTA style on
          // earlier builds so the button always reads as prominent.
          if (requireApiVersion("1.13.0")) btn.setDestructive().setCta();
          else btn.setCta();
          btn.onClick(async () => {
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
          });
          return btn;
        });
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

      const note = card.createDiv({ cls: "sealed-hint" });
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
    new Setting(parent).setName(t("settings.sectionNotes")).setHeading();

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

    // Mirror of the declarative info row above (both paths must stay in sync):
    // the private-block quick guide, one <p> per point.
    // Same pattern as inline/postprocessor.ts: activeDocument keeps popout
    // windows on their own document, and createFragment is a runtime global
    // (not a module export), so the typed API is activeDocument here.
    const helpFrag = activeDocument.createDocumentFragment();
    for (const key of BLOCK_HELP_KEYS) {
      helpFrag.createEl("p", { text: t(key), cls: "sealed-hint" });
    }
    new Setting(parent).setName(t("settings.blockHelpTitle")).setDesc(helpFrag);

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
    new Setting(parent).setName(t("settings.sectionUnlock")).setHeading();

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
    new Setting(parent).setName(t("settings.sectionAdvanced")).setHeading();

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
