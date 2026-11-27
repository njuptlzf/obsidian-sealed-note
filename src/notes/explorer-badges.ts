/**
 * File-explorer badges: a small 🔒 before the name of every private note.
 *
 * The explorer is Obsidian's own DOM; this is best-effort decoration - the
 * registry (not the badge) is the truth. The helper is deliberately pure
 * (root element + sealed paths in, mutation out) so it can be tested against
 * a hand-built DOM without a browser.
 *
 * The explorer is a virtual list: it re-renders rows on scroll, folder
 * expand and file add/remove, wiping any decoration we added. The plugin
 * therefore re-applies after every mutation (debounced) - see main.ts.
 */

export interface BadgeTitleElement {
  dataset?: { path?: string };
  firstChild?: Node | null;
  querySelector(selector: string): Element | null;
  insertBefore(node: Node, ref: Node | null): Node;
}

/** Apply/refresh badges under `root`. Returns the number of rows changed. */
export function applyExplorerBadges(root: HTMLElement, sealedPaths: Set<string>): number {
  let changed = 0;
  const titles = root.querySelectorAll?.(".nav-file-title") ?? [];
  for (const title of Array.from(titles)) {
    const el = title as unknown as BadgeTitleElement;
    const path = el.dataset?.path;
    if (!path) continue;
    const existing = el.querySelector(".sealed-nav-lock");
    if (sealedPaths.has(path)) {
      if (!existing) {
        const badge = document.createElement("span");
        badge.className = "sealed-nav-lock";
        badge.textContent = "🔒";
        badge.setAttribute("aria-hidden", "true");
        // Before the name span so the lock sits at the start of the row.
        const content = el.querySelector(".nav-file-title-content");
        el.insertBefore(badge, content ?? el.firstChild ?? null);
        changed++;
      }
    } else if (existing) {
      existing.remove?.();
      changed++;
    }
  }
  return changed;
}
