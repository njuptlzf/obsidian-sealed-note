/**
 * Reading-view marker for a locked note.
 *
 * A locked note's body is an HTML comment envelope, which renders as nothing
 * at all. This postprocessor replaces that blank render with a visible card
 * stating that the note is encrypted and offering an explicit unlock. There is
 * no custom view: the note is still an ordinary Markdown file, and source mode
 * shows the real ciphertext verbatim.
 */

import { MarkdownPostProcessorContext, TFile } from "obsidian";
import type SealedNotePlugin from "../main";
import { t } from "../i18n";
import { describeError } from "../util/errors";

export function registerLockedMarker(plugin: SealedNotePlugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => decorate(plugin, el, ctx));
}

async function decorate(
  plugin: SealedNotePlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  if (!sourcePath) return;
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;
  // Only the whole-note envelope produces this marker; inline sn1. payloads
  // in ordinary notes are handled by the inline postprocessor.
  const sealed = await plugin.notes.isSealedFile(file);
  if (!sealed) return;
  const raw = await plugin.app.vault.cachedRead(file).catch(() => "");
  if (plugin.notes.isRevealedText(raw)) return; // unlocked: show normal text

  el.empty();
  const card = el.createDiv({ cls: "sealed-locked-card" });
  card.createDiv({ cls: "sealed-locked-glyph", text: "🔒" });
  card.createDiv({ cls: "sealed-locked-title", text: t("locked.title") });
  const hint = card.createDiv({ cls: "sealed-locked-hint", text: t("locked.hint") });
  hint.setAttribute("title", t("locked.doubleClickHint"));
  const button = card.createEl("button", {
    text: t("locked.unlock"),
    cls: "mod-cta sealed-locked-action",
  });
  const unlock = () => {
    void plugin.guard(() => plugin.unlockNote(file));
  };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    unlock();
  });
  card.addEventListener("dblclick", (event) => {
    event.preventDefault();
    unlock();
  });
}

/** Kept for callers that want a friendly error without coupling to the UI. */
export function lockedErrorText(error: unknown): string {
  return describeError(error);
}
