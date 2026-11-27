/**
 * Inline `` `sn1.xxxx` `` payloads in reading view.
 *
 * Rendered as a small lock pill. Clicking asks for the secret and shows the
 * value in place; the file is untouched.
 */

import { MarkdownPostProcessorContext, Notice } from "obsidian";
import type SealedNotePlugin from "../main";
import { openInline } from "../core/format";
import { describeError } from "../util/errors";
import { t } from "../i18n";

const PAYLOAD_RE = /`?(sn1\.[A-Za-z0-9+/=]{40,})`?/g;

export function registerInlinePayloads(plugin: SealedNotePlugin): void {
  plugin.registerMarkdownPostProcessor(async (el, ctx) => {
    if (!plugin.config().showInlineBadges) return;
    await decorate(plugin, el, ctx);
  });
}

async function decorate(
  plugin: SealedNotePlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): Promise<void> {
  // Walk text nodes so we do not fight with the rest of the rendered DOM.
  const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue && PAYLOAD_RE.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });

  const targets: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    targets.push(current as Text);
    current = walker.nextNode();
  }

  for (const node of targets) {
    const text = node.nodeValue ?? "";
    PAYLOAD_RE.lastIndex = 0;
    if (!PAYLOAD_RE.test(text)) continue;
    PAYLOAD_RE.lastIndex = 0;

    const fragment = activeDocument.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    PAYLOAD_RE.lastIndex = 0;
    while ((match = PAYLOAD_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex, match.index)));
      }
      fragment.appendChild(buildPill(plugin, match[1], ctx));
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex)));
    }
    node.parentNode?.replaceChild(fragment, node);
  }
}

function buildPill(
  plugin: SealedNotePlugin,
  payload: string,
  ctx: MarkdownPostProcessorContext,
): HTMLElement {
  const pill = activeDocument.createElement("span");
  pill.className = "sealed-pill";
  const cipherLabel = t("menu.cipherPill");
  pill.setText?.(cipherLabel);
  pill.textContent = cipherLabel;
  pill.setAttribute("title", t("menu.clickDecrypt"));
  pill.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
    try {
      const dek = await plugin.unlockService.dekFor(ctx.sourcePath, {
        subject: ctx.sourcePath.split("/").pop() ?? "",
      });
      if (!dek) return;
      const plain = await openInline(dek, plugin.vaultId(), payload);
      // Ctrl/Cmd click copies without ever painting the secret on screen.
      if (event.ctrlKey || event.metaKey) {
        await navigator.clipboard.writeText(plain);
        new Notice(t("notice.copiedSilently"));
        return;
      }
      pill.textContent = plain;
      pill.classList.add("is-revealed");
      pill.setAttribute("title", t("menu.clickHide"));
      pill.onclick = null;
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        if (pill.classList.contains("is-revealed")) {
          pill.textContent = t("menu.cipherPill");
          pill.classList.remove("is-revealed");
        }
      });
    } catch (error) {
      new Notice(describeError(error), 6000);
    }
    })();
  });
  return pill;
}