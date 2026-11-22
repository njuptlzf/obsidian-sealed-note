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
    card.addClass("sealed-block-invalid");
    card.createSpan({ text: "🔒 无法识别的加密块" });
    card.createEl("div", {
      text: "这个块不以 sn1. 开头，可能不是本插件生成的，或内容被截断了。",
      cls: "sealed-hint",
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
        plugin.clipboard.noteCopied();
        new Notice("已复制到剪贴板");
      });
      const hide = bar.createEl("button", { text: "隐藏", cls: "sealed-btn" });
      hide.addEventListener("click", () => {
        card.removeClass("is-revealed");
        render();
      });

      if (plugin.config().clipboardClearSeconds > 0) {
        bar.createSpan({
          text: `${plugin.config().clipboardClearSeconds} 秒后可自动清空剪贴板`,
          cls: "sealed-hint",
        });
      }
      logInline.info("block_decrypted", { path: ctx.sourcePath });
    } catch (error) {
      new Notice(describeError(error), 6000);
      logInline.warn("block_decrypt_failed", { path: ctx.sourcePath, error: String(error) });
    }
  };

  render();
}