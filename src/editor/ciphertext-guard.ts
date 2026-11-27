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
import { NOTE_COMMENT_PREFIX } from "../core/format";

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
    const box = document.createElement("div");
    box.className = "sealed-editor-banner";

    const hint = document.createElement("div");
    hint.className = "sealed-editor-banner-text";
    hint.textContent = t("locked.editorHint");
    box.appendChild(hint);

    const btn = document.createElement("button");
    btn.className = "mod-cta sealed-editor-banner-btn";
    btn.textContent = t("locked.unlock");
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      unlockHandler?.();
    });
    box.appendChild(btn);
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
export function envelopeChangeFilter(tr: {
  docChanged: boolean;
  annotation: (key: unknown) => unknown;
  startState: { doc: { toString(): string } };
}): boolean {
  if (!tr.docChanged) return true;
  if (Date.now() < syncWindowUntil) return true; // body swap in progress
  if (tr.annotation(allowEnvelopeWrite) === true) return true;
  if (!isSealedDocText(tr.startState.doc.toString())) return true;
  return !tr.annotation(Transaction.userEvent);
}

export function ciphertextGuard(): Extension[] {
  return [lockedField, EditorState.changeFilter.of(envelopeChangeFilter as any)];
}
