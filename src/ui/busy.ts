/**
 * Transient "still working" indicator.
 *
 * Why this exists: the first save of a private note goes through a debounce
 * (autoSaveMs, 1.5s by default) and then a 600k-iteration PBKDF2 derivation
 * (~450ms measured) before the credential dialog can be shown. Measured
 * numbers, not guesses: keyring load is 3ms, the save itself is 3ms - the wait
 * the user actually feels is debounce + KDF. Without a visible indicator the
 * note simply appears frozen for a second or two and then a dialog pops in.
 *
 * Deliberately tiny and non-interactive: a pill in the middle of the pane with
 * a spinning ring. `pointer-events: none` so it can never swallow a click, and
 * it is removed from the DOM when hidden so nothing accumulates.
 */

function hostDocument(): Document | null {
  const g = globalThis as any;
  // Obsidian exposes `activeDocument` (follows the focused popout window).
  // Fall back to `document` under the headless test stub.
  return (g.activeDocument ?? g.document ?? null) as Document | null;
}

export class BusyOverlay {
  private el: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;

  get visible(): boolean {
    return this.el !== null;
  }

  /** Show the indicator, or update its label when already visible. */
  show(label: string): void {
    if (this.el) {
      this.update(label);
      return;
    }
    const doc = hostDocument();
    if (!doc?.body) return;

    const el = doc.createElement("div");
    el.className = "sealed-busy";

    const ring = doc.createElement("span");
    ring.className = "sealed-busy-ring";
    el.appendChild(ring);

    const text = doc.createElement("span");
    text.className = "sealed-busy-label";
    text.textContent = label;
    el.appendChild(text);

    doc.body.appendChild(el);
    this.el = el;
    this.labelEl = text;
  }

  update(label: string): void {
    if (this.labelEl) this.labelEl.textContent = label;
  }

  hide(): void {
    // The stub's createElement has no remove(); guard so tests stay clean.
    this.el?.remove?.();
    this.el = null;
    this.labelEl = null;
  }
}