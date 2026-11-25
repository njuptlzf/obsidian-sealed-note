/**
 * Two-step dialog for recovering a note whose ref annotation was deleted:
 * enter the recovery key -> pick which decrypted payload belongs here.
 * The heavy lifting lives in RestoreService; this file is pure UI.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";
import type { RestoreCandidate } from "../services/restore-service";
import { describeError } from "../util/errors";

export interface RestoreDialogDeps {
  collect(recovery: string): Promise<{ candidates: RestoreCandidate[]; skipped: number }>;
  choose(candidate: RestoreCandidate): Promise<void> | void;
}

export class RestoreModal extends Modal {
  private recovery = "";
  private settled = false;

  constructor(
    app: App,
    private readonly noteName: string,
    private readonly deps: RestoreDialogDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderKeyStep();
  }

  private clear(): void {
    this.contentEl.empty();
    this.contentEl.addClass("sealed-modal", "sealed-restore");
  }

  private renderKeyStep(): void {
    this.clear();
    this.contentEl.createEl("h2", { text: t("restore.title") });
    this.contentEl.createEl("p", { text: t("restore.intro", { name: this.noteName }), cls: "sealed-hint" });
    this.contentEl.createEl("p", { text: t("restore.warn"), cls: "sealed-warning" });

    new Setting(this.contentEl).setName(t("restore.recoveryLabel")).addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder(t("restore.recoveryPlaceholder"));
      text.inputEl.addEventListener("input", () => (this.recovery = text.getValue()));
      window.setTimeout(() => text.inputEl.focus(), 30);
    });

    const errorEl = this.contentEl.createDiv({ cls: "sealed-error" });
    const actions = this.contentEl.createDiv({ cls: "sealed-actions" });
    actions.createEl("button", { text: t("prompt.cancel") }).addEventListener("click", () => this.close());
    actions
      .createEl("button", { text: t("restore.search"), cls: "mod-cta" })
      .addEventListener("click", () => {
        void this.deps.collect(this.recovery).then(
          ({ candidates, skipped }) => {
            if (candidates.length === 0) {
              errorEl.setText(t("restore.none", { skipped }));
              return;
            }
            this.renderPickStep(candidates, skipped);
          },
          (error) => errorEl.setText(describeError(error)),
        );
      });
  }

  private renderPickStep(candidates: RestoreCandidate[], skipped: number): void {
    this.clear();
    this.contentEl.createEl("h2", { text: t("restore.pickTitle") });
    this.contentEl.createEl("p", {
      text: t("restore.pickIntro", { n: candidates.length, skipped }),
      cls: "sealed-hint",
    });

    const list = this.contentEl.createDiv({ cls: "sealed-restore-list" });
    for (const candidate of candidates) {
      const row = list.createEl("button", { cls: "sealed-restore-item" });
      row.createEl("div", { text: candidate.title, cls: "sealed-restore-title" });
      row.createEl("div", { text: candidate.preview, cls: "sealed-restore-preview" });
      row.addEventListener("click", () => {
        if (this.settled) return;
        this.settled = true;
        void Promise.resolve(this.deps.choose(candidate)).then(
          () => {
            new Notice(t("restore.done"));
            this.close();
          },
          (error) => {
            this.settled = false;
            new Notice(describeError(error), 8000);
          },
        );
      });
    }
    this.contentEl
      .createEl("button", { text: t("prompt.cancel") })
      .addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
