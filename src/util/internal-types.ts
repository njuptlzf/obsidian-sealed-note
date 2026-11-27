/**
 * Typed shapes for Obsidian internals that the public `.d.ts` does not expose
 * but this plugin deliberately relies on. Keeping them in one place means the
 * casts live here, not scattered through main.ts as `any`.
 *
 * Every field is optional and every method is guarded at the call site: an
 * internal API that changes must degrade to a no-op, never throw at load.
 */

import type { WorkspaceLeaf } from "obsidian";

/** `app.setting` — the settings modal is not part of the public App type. */
export interface SettingApp {
  open(...args: unknown[]): unknown;
  openTabById?(id: string): unknown;
  /** Marker this plugin sets so the opener is patched only once. */
  __sealedNotePatched?: boolean;
}

/** A view that exposes the file it is showing (Markdown views do). */
export interface ViewWithFile {
  file?: { path?: string } | null;
}

/** A markdown view's editor surface, used for the disk/buffer sync. */
export interface EditorLike {
  getValue(): string;
  setValue(value: string): void;
}

/** A Markdown view with its mode and custom helpers. */
export interface MarkdownViewLike extends ViewWithFile {
  getViewType?(): string;
  getMode?(): string;
}

/** Workspace split containers used to tell main area from side docks. */
export interface SplitNode {
  parent?: SplitNode | null;
}

export interface WorkspaceInternals {
  leftSplit?: SplitNode | null;
  rightSplit?: SplitNode | null;
  rootSplit?: SplitNode | null;
  activeLeaf?: WorkspaceLeaf | null;
}

/** An error carrying a stable programmatic code (e.g. E_BAD_ENVELOPE). */
export interface CodedError {
  code?: string;
}
