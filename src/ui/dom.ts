type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/**
 * Holds DOM rebuilds of a panel while a pointer is pressed inside it. A `click` needs the same
 * element under the pointer at press and release: a panel that re-renders (5 Hz HUD refresh, its
 * signature changed) between pointerdown and pointerup replaces that element and the browser drops
 * the click — the 2.1 "assigning commands by click sometimes does not work" bug. Release is caught
 * on the window in the capture phase, before `click` fires, and the deferred render runs on the
 * next refresh, after the click has been handled.
 */
export class PressGuard {
  private down = false;
  private readonly off: (() => void)[] = [];

  constructor(el: HTMLElement) {
    const press = (): void => { this.down = true; };
    const release = (): void => { this.down = false; };
    el.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);
    this.off.push(
      () => el.removeEventListener('pointerdown', press, true),
      () => window.removeEventListener('pointerup', release, true),
      () => window.removeEventListener('pointercancel', release, true),
      () => window.removeEventListener('blur', release),
    );
  }

  /** A pointer is down inside the panel: do not replace its elements now. */
  get held(): boolean {
    return this.down;
  }

  dispose(): void {
    for (const f of this.off) f();
  }
}

/** Replace children only when content key changed (avoids layout thrash on refresh). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
