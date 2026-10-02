/**
 * Inline SVG art for the HUD: NATO-style unit symbols, side-view silhouettes and brass gauges.
 * Strings are static and authored here (no user input), so they are safe to inject.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** NATO-flavoured frame symbol (matches the 3D counters in render/icons.ts). viewBox 0 0 36 24. */
const NATO: Record<string, string> = {
  infantry: '<path d="M3 3L33 21M3 21L33 3"/>',
  // NATO motorized infantry: the infantry cross over two wheels.
  motor_inf: '<path d="M3 3L33 15M3 15L33 3"/><circle cx="12" cy="19" r="2.5" class="f"/><circle cx="24" cy="19" r="2.5" class="f"/>',
  recon: '<path d="M3 21L33 3"/>',
  mg: '<path d="M3 3L33 21M3 21L33 3"/><circle cx="18" cy="5" r="2" class="f"/>',
  engineer: '<path d="M8 18V8H28V18M18 8V18"/>',
  at_gun: '<path d="M8 20L18 5L28 20M18 5V20"/>',
  mortar: '<circle cx="18" cy="16" r="3"/><path d="M18 13V4M14 8L18 4L22 8"/>',
  light_tank: '<ellipse cx="18" cy="12" rx="11" ry="5"/>',
  medium_tank: '<ellipse cx="18" cy="12" rx="11" ry="5"/><ellipse cx="18" cy="12" rx="6" ry="2"/>',
  heavy_tank: '<ellipse cx="18" cy="12" rx="11" ry="5"/><ellipse cx="18" cy="12" rx="6" ry="2"/><ellipse cx="18" cy="12" rx="2" ry="1" class="f"/>',
  howitzer: '<circle cx="18" cy="12" r="4" class="f"/>',
  aa: '<path d="M7 19Q18 3 29 19M18 18V6"/>',
  supply_truck: '<path d="M3 12H33"/><circle cx="11" cy="18" r="2.5"/><circle cx="25" cy="18" r="2.5"/>',
};

/** Side silhouettes, viewBox 0 0 64 26, drawn in currentColor. */
const SIL: Record<string, string> = {
  infantry:
    '<g><circle cx="12" cy="6" r="2.6"/><path d="M9.5 9h5l1 8-1.5 8h-2l.5-7-2 7h-2l1-8z"/><path d="M15 10l8-5 .7 1-8 5z"/></g>'
    + '<g><circle cx="30" cy="6" r="2.6"/><path d="M27.5 9h5l1 8-1.5 8h-2l.5-7-2 7h-2l1-8z"/><path d="M33 10l8-5 .7 1-8 5z"/></g>'
    + '<g><circle cx="48" cy="6" r="2.6"/><path d="M45.5 9h5l1 8-1.5 8h-2l.5-7-2 7h-2l1-8z"/><path d="M51 10l8-5 .7 1-8 5z"/></g>',
  recon:
    '<g><circle cx="20" cy="9" r="2.6"/><path d="M17 12h5l2 6-3 1-1 6h-2l-.5-6-2-.5z"/><path d="M22 12l7-3 .5 1-7 3z"/></g>'
    + '<g><circle cx="40" cy="11" r="2.6"/><path d="M37 14h5l1 5h4v2h-5l-1 4h-2l-1-5-2 0z"/></g>',
  mg:
    '<path d="M14 18h30l2-3h10v2h-9l-2 3H16z"/><path d="M22 20l-6 6M30 20l6 6M26 20v6" stroke="currentColor" stroke-width="1.6" fill="none"/>'
    + '<circle cx="10" cy="12" r="2.6"/><path d="M7 15h5l2 5-2 1-3 4H7l1-5-2-1z"/>',
  engineer:
    '<circle cx="22" cy="6" r="2.6"/><path d="M19.5 9h5l1 8-1.5 8h-2l.5-7-2 7h-2l1-8z"/>'
    + '<path d="M26 11l14 8-.8 1.3-14-8z"/><path d="M38 16l6-2 1 3-6 2z"/><rect x="46" y="18" width="12" height="7" rx="1"/>',
  at_gun:
    '<path d="M6 13h30v3H6z"/><path d="M30 10h10v9H30z"/><path d="M38 16l-14 8 1.4 1.6L40 18z"/><path d="M40 16l14 8-1.4 1.6L38 18z"/>'
    + '<circle cx="34" cy="21" r="4.5"/>',
  mortar:
    '<path d="M24 24l18-20 2 1.6-17 20z"/><rect x="18" y="22" width="14" height="3" rx="1"/><path d="M36 12l6 12h-2l-5-10z"/>',
  light_tank:
    '<path d="M14 15h34l4 4-4 5H16l-4-5z"/><path d="M22 9h16l2 6H20z"/><rect x="38" y="10.5" width="14" height="2"/>'
    + '<g class="w"><circle cx="18" cy="21" r="2"/><circle cx="25" cy="21" r="2"/><circle cx="32" cy="21" r="2"/><circle cx="39" cy="21" r="2"/><circle cx="46" cy="21" r="2"/></g>',
  medium_tank:
    '<path d="M10 14h42l5 5-5 5H12l-5-5z"/><path d="M20 7h18l4 7H18z"/><rect x="40" y="9" width="18" height="2.4"/><rect x="25" y="4.5" width="6" height="3" rx="1"/>'
    + '<g class="w"><circle cx="15" cy="20" r="2.2"/><circle cx="23" cy="20" r="2.2"/><circle cx="31" cy="20" r="2.2"/><circle cx="39" cy="20" r="2.2"/><circle cx="47" cy="20" r="2.2"/></g>',
  heavy_tank:
    '<path d="M4 12h52l4 6-4 6H6l-4-6z"/><path d="M16 4h24v8H14z"/><rect x="40" y="6.5" width="23" height="3"/><rect x="60" y="5.5" width="3" height="5"/>'
    + '<g class="w"><circle cx="10" cy="19" r="2.4"/><circle cx="18" cy="19" r="2.4"/><circle cx="26" cy="19" r="2.4"/><circle cx="34" cy="19" r="2.4"/><circle cx="42" cy="19" r="2.4"/><circle cx="50" cy="19" r="2.4"/></g>',
  howitzer:
    '<path d="M20 18l30-14 1 2.2-30 14z"/><path d="M14 14h18v6H14z"/><path d="M16 18L4 25l1 1.4L18 20z"/><path d="M24 18l12 7-1 1.4-12-7z"/><circle cx="20" cy="21" r="4.5"/>',
  aa:
    '<path d="M10 20h34v3H10z"/><path d="M22 12h10v8H22z"/><path d="M28 14l20-12 1.2 1.8-20 12z"/><path d="M26 16l20-12 1.2 1.8-20 12z"/>'
    + '<circle cx="14" cy="23" r="2.5"/><circle cx="40" cy="23" r="2.5"/><path d="M6 22h6M42 22h8" stroke="currentColor" stroke-width="1.5"/>',
  supply_truck:
    '<path d="M4 7h34v13H4z"/><path d="M38 11h10l6 5v4H38z"/><path d="M41 12h6l3 3h-9z" class="cut"/>'
    + '<path d="M4 20h50v2H4z"/><g class="w"><circle cx="12" cy="22" r="3.2"/><circle cx="22" cy="22" r="3.2"/><circle cx="47" cy="22" r="3.2"/></g>',
};

export function natoSymbol(unitId: string): SVGSVGElement {
  return svg('0 0 36 24', 'nato', `<rect x="1.5" y="1.5" width="33" height="21" rx="1.5"/>${NATO[unitId] ?? ''}`);
}

export function silhouette(unitId: string): SVGSVGElement {
  // Motorized rifles travel by truck: reuse the truck silhouette.
  return svg('0 0 64 26', 'sil', SIL[unitId] ?? (unitId === 'motor_inf' ? SIL.supply_truck : ''));
}

function svg(viewBox: string, cls: string, inner: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = inner;
  return el;
}

/** Brass analogue gauge: 180° dial with ticks and a needle; the exact number is printed alongside. */
export class BrassGauge {
  readonly el: SVGSVGElement;
  private readonly needle: SVGGElement;
  private readonly zone: SVGPathElement;
  private lastDeg = Number.NaN;

  /** `dangerBelow` (0..1) paints a red arc at the low end of the dial. */
  constructor(dangerBelow = 0.25) {
    this.el = svg('0 0 60 36', 'brass-gauge', '');
    const ticks: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * (1 - i / 10);
      const r0 = i % 5 === 0 ? 19 : 21;
      ticks.push(`M${(30 + Math.cos(a) * r0).toFixed(2)} ${(31 - Math.sin(a) * r0).toFixed(2)}L${(30 + Math.cos(a) * 24).toFixed(2)} ${(31 - Math.sin(a) * 24).toFixed(2)}`);
    }
    const end = Math.PI * (1 - dangerBelow);
    this.el.innerHTML =
      '<defs><radialGradient id="bgz" cx="50%" cy="85%" r="75%"><stop offset="0" stop-color="#f6eed8"/><stop offset="1" stop-color="#d9caa2"/></radialGradient>'
      + '<linearGradient id="brz" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3c27a"/><stop offset=".5" stop-color="#a77c38"/><stop offset="1" stop-color="#6b4c1e"/></linearGradient></defs>'
      + '<path d="M2 32A28 28 0 0 1 58 32Z" fill="url(#brz)"/>'
      + '<path d="M5 31A25 25 0 0 1 55 31Z" fill="url(#bgz)"/>'
      + `<path class="zone" d="M${(30 + Math.cos(Math.PI) * 22.5).toFixed(2)} 31A22.5 22.5 0 0 1 ${(30 + Math.cos(end) * 22.5).toFixed(2)} ${(31 - Math.sin(end) * 22.5).toFixed(2)}" fill="none" stroke="#a63f36" stroke-width="3"/>`
      + `<path d="${ticks.join('')}" stroke="#272c27" stroke-width="1" fill="none"/>`
      + '<g class="needle"><path d="M29.2 31L30 9L30.8 31Z" fill="#272c27"/></g>'
      + '<circle cx="30" cy="31" r="3" fill="url(#brz)" stroke="#3d2c10" stroke-width=".6"/>';
    this.needle = this.el.querySelector('.needle') as SVGGElement;
    this.zone = this.el.querySelector('.zone') as SVGPathElement;
  }

  /** 0..1 */
  set(frac: number): void {
    const f = Math.max(0, Math.min(1, frac));
    const deg = Math.round((f - 0.5) * 180);
    if (deg === this.lastDeg) return;
    this.lastDeg = deg;
    this.needle.style.transform = `rotate(${deg}deg)`;
  }

  hideZone(): void {
    this.zone.style.display = 'none';
  }
}
