/**
 * Ciphertext guard for the editor.
 *
 * A locked note's body IS the envelope, and the envelope is fragile: one
 * stray keystroke can make the note permanently undecryptable. The deleted
 * padlock view prevented that by hiding the body, but it could only route
 * ".sealed.md" filenames - a note locked in place under any other name
 * opened as raw, editable ciphertext.
 *
 * This extension is content-based, so it protects every envelope no matter
 * what the file is called. While the buffer holds an envelope:
 *
 *   - EditorState.changeFilter refuses user-originated document changes.
 *     That facet is additive (any false blocks, order-independent), unlike
 *     the first-wins readOnly/editable facets, so it holds regardless of
 *     what Obsidian itself registers. Obsidian applies its own disk->buffer
 *     sync as remote transactions, and the plugin marks its repair writes
 *     with allowEnvelopeWrite; both pass. So unlocking can still replace
 *     the body, while typing, pasting and drag-drops cannot damage it.
 *   - A block banner at the top of the document says why nothing can be
 *     typed and offers the unlock action.
 *
 * The moment the body stops being an envelope (unlock rewrites it to
 * plaintext), editing comes back. Nothing here switches views or touches
 * leaves.
 */

import {
  Annotation,
  EditorState,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { t } from "../i18n";
import {
  INLINE_LANGS,
  INLINE_VERSION,
  NOTE_COMMENT_PREFIX,
} from "../core/format";

/** A body is a locked envelope exactly when it starts with the marker. */
export function isSealedDocText(text: string): boolean {
  const trimmed = (text ?? "").trimStart();
  // The canonical comment form, or the legacy bare-JSON form the reader also
  // accepts. Both are equally fragile under accidental edits.
  return (
    trimmed.startsWith(NOTE_COMMENT_PREFIX) ||
    trimmed.startsWith(`{"format":"sealed-note/note/`)
  );
}

/**
 * Marks a programmatic document write that must pass the filter even while
 * the buffer holds an envelope (the bad-envelope repair dispatches
 * directly; every other rewrite goes through vault.modify, which Obsidian
 * applies as a remote transaction).
 */
export const allowEnvelopeWrite = Annotation.define<boolean>();

/**
 * Sync window. When the plugin swaps a body between envelope and plaintext
 * (reveal/lock), the open editor buffer must follow the disk - but we cannot
 * know how Obsidian annotates its buffer-sync transactions (some versions
 * route them through the same pipeline as typed input, which this filter
 * would block, leaving a stale dirty buffer that autosave writes back over
 * the fresh disk content). While the window is open every transaction
 * passes; the plugin then pushes the disk content into the buffer itself.
 * The window is short (a few hundred ms) so genuine stray typing stays
 * blocked.
 */
let syncWindowUntil = 0;

export function openCiphertextSyncWindow(ms = 400): void {
  syncWindowUntil = Date.now() + ms;
}

// The banner needs the plugin's unlock action, which is only known at
// registration time. A module-level holder is set once by the plugin before
// any editor view exists; the widget reads it when Obsidian builds the DOM.
let unlockHandler: (() => void) | null = null;

export function setCiphertextGuardUnlockHandler(handler: () => void): void {
  unlockHandler = handler;
}

class LockedBannerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const box = createDiv({ cls: "sealed-editor-banner" });

    box.createDiv({
      cls: "sealed-editor-banner-text",
      text: t("locked.editorHint"),
    });

    const btn = box.createEl("button", {
      cls: "mod-cta sealed-editor-banner-btn",
      text: t("locked.unlock"),
    });
    btn.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      unlockHandler?.();
    });
    return box;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const lockedField = StateField.define<boolean>({
  create: (state) => isSealedDocText(state.doc.toString()),
  update(value, tr) {
    if (tr.docChanged) return isSealedDocText(tr.newDoc.toString());
    return value;
  },
  provide: (field) => [
    EditorView.decorations.compute([field], (state) => {
      if (!state.field(field)) return Decoration.none;
      const widget = Decoration.widget({ widget: new LockedBannerWidget(), block: true, side: -1 });
      return Decoration.set([widget.range(0)]);
    }),
    EditorView.editorAttributes.compute([field], (state) =>
      state.field(field) ? { class: "sealed-editor-locked" } : { class: "" },
    ),
  ],
});

/**
 * The enforcement core, exported for direct unit testing. A document
 * change is refused only when ALL of:
 *   - the buffer currently holds an envelope,
 *   - the transaction actually changes the document,
 *   - it carries a user-event annotation (typing, paste, drop, cut-replace,
 *     drag-move, undo, redo - everything a stray keystroke can produce),
 *   - and it is not our own allowed write (allowEnvelopeWrite).
 *
 * Deliberately keyed on the userEvent annotation rather than the `remote`
 * one: CM tags every DOM-originated change with a user event, and nothing
 * programmatic carries one - so Obsidian's own disk->buffer sync, other
 * plugins' dispatches and our reveal/reseal all pass without depending on
 * how Obsidian annotates its internal transactions.
 */
export function envelopeChangeFilter(tr: Transaction): boolean {
  if (!tr.docChanged) return true;
  if (Date.now() < syncWindowUntil) return true; // body swap in progress
  if (tr.annotation(allowEnvelopeWrite) === true) return true;
  if (!isSealedDocText(tr.startState.doc.toString())) return true;
  return !tr.annotation(Transaction.userEvent);
}

/**
 * Cipher payload regions inside an ordinary note body - the fragile bytes a
 * stray keystroke would destroy beyond recovery: fenced `sn1.*` blocks and
 * inline `sn1.*` payloads. Empty fences (a pending seal the user is typing)
 * carry no payload and stay editable. Scanned directly (not via
 * findFencedBlocks) so an unterminated fence while typing still protects the
 * ciphertext already inside it.
 */
export function sealedCipherRanges(text: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  if (!text.includes(`${INLINE_VERSION}.`)) return out;
  // "g" is essential: exec() ignores lastIndex on a non-global regex, so a
  // loop that advances via lastIndex would keep finding the SAME fence and
  // spin forever (V8 "out of memory: Zone"). Keep every iteration monotone.
  const langRe = new RegExp(`^[ \t]*\`\`\`(?:${INLINE_LANGS.join("|")})\\b[^\\n]*\\n`, "gm");

  let pos = 0;
  for (;;) {
    langRe.lastIndex = pos;
    const m = langRe.exec(text);
    if (!m) break;
    const bodyStart = m.index + m[0].length;
    const close = text.indexOf("```", bodyStart);
    const bodyEnd = close < 0 ? text.length : close;
    if (text.slice(bodyStart, bodyEnd).includes(`${INLINE_VERSION}.`)) {
      out.push({
        from: m.index,
        to: close < 0 ? text.length : text.indexOf("\n", bodyEnd) < 0 ? text.length : text.indexOf("\n", bodyEnd) + 1,
      });
    }
    // Always advance, even for a malformed/adjacent fence, or exec() would
    // rediscover the same opening marker forever.
    pos = Math.max(m.index + m[0].length, bodyEnd + 1);
    if (pos >= text.length) break;
  }

  const inlineRe = /`sn1\.[A-Za-z0-9+/=]+`|sn1\.[A-Za-z0-9+/=]{40,}/g;
  for (;;) {
    const m = inlineRe.exec(text);
    if (!m) break;
    const inFence = out.some((r) => m.index >= r.from && m.index < r.to);
    if (!inFence) out.push({ from: m.index, to: m.index + m[0].length });
    inlineRe.lastIndex = m.index + Math.max(1, m[0].length);
  }
  return out;
}

/**
 * The fence/payload layer for ordinary notes. Unlike the envelope layer the
 * document stays editable - only user changes that INTERSECT a ciphertext
 * region are refused (typing next to a block, editing other lines and even
 * editing the fence's own indentation all pass). Programmatic writes, the
 * sync window and seal/decrypt rewrites pass untouched.
 */
export function cipherRangesChangeFilter(tr: Transaction): boolean {
  if (!tr.docChanged) return true;
  if (Date.now() < syncWindowUntil) return true;
  if (tr.annotation(allowEnvelopeWrite) === true) return true;
  if (!tr.annotation(Transaction.userEvent)) return true;
  const ranges = tr.startState.field(cipherRangesField, false);
  if (!ranges || ranges.length === 0) return true;
  let hit = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (hit) return;
    for (const r of ranges) {
      // half-open overlap; an insert at the exact boundary of the whole
      // fence (from === to === r.from) is still inside the protected span,
      // so use inclusive-start semantics.
      if (fromA < r.to && toA >= r.from) {
        hit = true;
        return;
      }
    }
  });
  return !hit;
}

const cipherRangesField = StateField.define<Array<{ from: number; to: number }>>({
  create: (state) => sealedCipherRanges(state.doc.toString()),
  update(value, tr) {
    if (!tr.docChanged) return value;
    return sealedCipherRanges(tr.newDoc.toString());
  },
  provide: (field) => [
    EditorView.decorations.compute([field], (state) => {
      const ranges = state.field(field);
      if (ranges.length === 0) return Decoration.none;
      const items: ReturnType<Decoration["range"]>[] = [];
      for (const r of ranges) {
        try {
          // Annotate the fence's own text so the protection is visible and
          // explained where it bites, and mark the line so the CSS can draw
          // a locked-gutter frame around it.
          items.push(
            Decoration.mark({ class: "sealed-cipher-locked", attributes: { title: t("guard.cipherLocked") } }).range(
              Math.min(r.from, state.doc.length),
              Math.min(r.to, state.doc.length),
            ),
          );
        } catch {
          /* stale range after a concurrent programmatic write: skip, the
             next doc change re-scans anyway */
        }
      }
      return Decoration.set(items, true);
    }),
  ],
});

export function ciphertextGuard(): Extension[] {
  return [
    lockedField,
    cipherRangesField,
    EditorState.changeFilter.of(envelopeChangeFilter),
    EditorState.changeFilter.of(cipherRangesChangeFilter),
  ];
}
