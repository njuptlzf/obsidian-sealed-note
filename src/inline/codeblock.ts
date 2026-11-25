/**
 * Reading-view rendering for ```encrypted_txt``` blocks.
 *
 * The block always stores ciphertext. Decrypting only ever changes what is on
 * screen; it never writes plaintext back into the file. That is why "save while
 * in edit mode gives you ciphertext" needs no special casing - the buffer was
 * already ciphertext.
 */

import { MarkdownPostProcessorContext, Notice, setIcon } from "obsidian";
import type SealedNotePlugin from "../main";
import { openInline } from "../core/format";
import { describeError } from "../util/errors";
import { log } from "../util/log";
import { t } from "../i18n";

const logInline = log.child("inline");

export function registerEncryptedCodeBlocks(plugin: SealedNotePlugin): void {
  const langs = ["encrypted_txt", "txt_encrypted", "sealed"];
  for (const lang of langs) {
    plugin.registerMarkdownCodeBlockProcessor(lang, async (source, el, ctx) => {
      await renderEncryptedBlock(plugin, source, el, ctx);
    });
  }
}

async function renderEncryptedBlock(
  plugin: SealedNotePlugin,
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  const payload = source.trim();
  const card = el.createDiv({ cls: "sealed-block" });

  if (!payload.startsWith("sn1.")) {
    // Not ciphertext yet: the user typed this block as plaintext. It is a
    // pending seal, not an error. Offer the same unlock click model as the
    // lock pill: click, authenticate, the block's plaintext is sealed into
    // sn1.* ciphertext IN THE FILE. The bytes are only rewritten after the
    // key is accepted; nothing is ever deleted here.
    card.addClass("sealed-block-unsealed");
    const btn = card.createEl("button", { cls: "sealed-block-lock" });
    setIcon(btn, "lock-open");
    btn.createSpan({ text: t("card.unsealedTitle") });
    card.createEl("div", { text: t("card.unsealedHint"), cls: "sealed-hint" });
    const seal = card.createEl("button", { text: t("card.unsealedSeal"), cls: "sealed-btn" });
    seal.addEventListener("click", async () => {
      seal.disabled = true;
      try {
        // Seal the file's plaintext blocks through the same path the leaving
        // hooks use: read current bytes, encrypt each unsealed block, one
        // self-write. Cancel/failure keeps every byte as-is. notify=false:
        // this card reports the outcome, the trail stays as the reminder.
        const sealed = await plugin.sealPlainNote(ctx.sourcePath, {
          interactive: true,
          notify: false,
        });
        if (sealed < 0) new Notice(t("notice.sealCancelledCard"), 6000);
        else if (sealed > 0) new Notice(t("notice.blocksSealed", { n: sealed }), 5000);
        // sealed === 0: a concurrent seal already fixed the file; nothing to
        // announce, the re-rendered card already shows the sealed state.
      } finally {
        seal.disabled = false;
      }
    });
    return;
  }

  const render = () => {
    card.empty();
    const label = card.createEl("button", { cls: "sealed-block-lock" });
    setIcon(label, "lock");
    label.createSpan({ text: ` 已加密 · ${payload.length} 字符` });
    label.addEventListener("click", () => void decrypt());
  };

  const decrypt = async () => {
    try {
      const dek = await plugin.unlockService.dekFor(ctx.sourcePath, {
        subject: ctx.sourcePath.split("/").pop() ?? "",
      });
      if (!dek) return;
      const plain = await openInline(dek, plugin.vaultId(), payload);

      card.empty();
      card.addClass("is-revealed");
      const body = card.createEl("pre", { cls: "sealed-block-plain" });
      body.setText(plain);

      const bar = card.createDiv({ cls: "sealed-block-bar" });
      const copy = bar.createEl("button", { text: "复制", cls: "sealed-btn" });
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(plain);
        new Notice("已复制到剪贴板");
      });
      const hide = bar.createEl("button", { text: "隐藏", cls: "sealed-btn" });
      hide.addEventListener("click", () => {
        card.removeClass("is-revealed");
        render();
      });

      logInline.info("block_decrypted", { path: ctx.sourcePath });
    } catch (error) {
      new Notice(describeError(error), 6000);
      logInline.warn("block_decrypt_failed", { path: ctx.sourcePath, error: String(error) });
    }
  };

  render();
}