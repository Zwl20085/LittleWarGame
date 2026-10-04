import { PLANS } from '../sim/fortplans';
import { isCommander } from '../sim/formulas';
import { frontUnits } from '../sim/fronts';
import type { Faction, Front, Zone } from '../sim/types';
import type { V2 } from '../sim/vec';
import type { World } from '../sim/world';
import type { GameContext } from './context';
import { h } from './dom';
import { t } from './i18n';
import { frontLabel } from './labels';

/** Works within this of a zone's line count toward it (pillboxes / bunkers sit a few metres behind). */
const ZONE_WORKS_M = 40;
/** A unit this close to its front's ordered line counts as "in position" (obedience line). */
const IN_POSITION_M = 80;
const ZONE_KINDS = new Set(['trench', 'pillbox', 'bunker']);

export function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * k), p.z - (a.z + vz * k));
}

export interface ZoneWorks {
  /** Finished works along the line. */
  readonly standing: number;
  /** Sites started and still under construction. */
  readonly building: number;
  /** Works the plan calls for (same layout rule as fortplans.layoutZone). */
  readonly planned: number;
  /** 0..1, finished works plus partial progress of open sites over the plan. */
  readonly frac: number;
}

/** Works the fortified-zone layout plans for a line of this length (trenches + pillboxes + bunker). */
function plannedWorks(a: V2, b: V2): number {
  const len = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
  const trenches = Math.max(1, Math.min(PLANS.zone.maxTrenches, Math.round(len / PLANS.zone.trenchSpacingM)));
  const pills = len >= PLANS.zone.twoPillboxM ? PLANS.zone.pillboxT.length : 1;
  return trenches + pills + 1;
}

/** Count the faction's trenches / pillboxes / bunkers along a zone's line. */
export function zoneWorks(w: World, f: Faction, z: Zone): ZoneWorks {
  let standing = 0;
  let building = 0;
  let partial = 0;
  for (const ft of w.forts) {
    if (ft.owner !== f.id || !ZONE_KINDS.has(ft.kind) || ft.hp <= 0) continue;
    if (segDist(ft.pos, z.a, z.b) > ZONE_WORKS_M) continue;
    if (ft.progress >= 1) standing++;
    else {
      building++;
      partial += Math.max(0, ft.progress);
    }
  }
  const planned = Math.max(plannedWorks(z.a, z.b), standing + building);
  return { standing, building, planned, frac: Math.min(1, (standing + partial) / planned) };
}

/** Units of a front at its ordered line (or ordered point) / all its units; null when the order has no place. */
export function inPosition(w: World, f: Faction, s: Front): { at: number; total: number } | null {
  if (s.order.kind === 'auto') return null;
  const line = s.line ?? (s.order.b ? { a: s.order.a, b: s.order.b } : null);
  let at = 0;
  let total = 0;
  for (const u of frontUnits(w, f.id, s.id)) {
    if (isCommander(u.def)) continue;
    total++;
    const d = line ? segDist(u.pos, line.a, line.b) : Math.hypot(u.pos.x - s.order.a.x, u.pos.z - s.order.a.z);
    if (d <= IN_POSITION_M) at++;
  }
  return { at, total };
}

/**
 * Supreme-HQ card section (2.1, 筑垒地域是永备工事): the faction's standing fortified zones — id,
 * holding front, works standing / planned (+ building), a progress bar, locate and cancel.
 * Collapsible; renders only when its signature changes.
 */
export class ZonesSection {
  readonly el: HTMLElement;
  private open = true;
  private sig = '';

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'zones' });
  }

  relabel(): void {
    this.sig = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const zones = (f?.zones ?? []).filter((z) => !z.cancelled);
    const rows = zones.map((z) => ({ z, k: zoneWorks(w, f, z) }));
    const sig = JSON.stringify([this.open, rows.map(({ z, k }) => [z.id, z.frontId, z.frontId !== null ? frontLabel(w, f.id, z.frontId) : '', k.standing, k.building, k.planned, Math.round(k.frac * 40)])]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.innerHTML = '';
    this.el.style.display = rows.length === 0 ? 'none' : '';
    if (rows.length === 0) return;
    this.el.append(h('button', {
      class: 'zones-head', 'aria-expanded': String(this.open),
      onclick: () => { this.open = !this.open; this.sig = ''; this.refresh(); },
    }, h('span', { class: 'zh-caret', 'aria-hidden': 'true' }, this.open ? '▾' : '▸'), h('span', {}, t('zone.title')), h('span', { class: 'zh-n num' }, String(rows.length))));
    if (!this.open) return;
    const list = h('div', { class: 'zones-list' });
    for (const { z, k } of rows) list.append(this.row(f, z, k));
    this.el.append(list);
  }

  private row(f: Faction, z: Zone, k: ZoneWorks): HTMLElement {
    const w = this.ctx.match.world;
    const c = { x: (z.a.x + z.b.x) / 2, z: (z.a.z + z.b.z) / 2 };
    const holder = z.frontId !== null && f.fronts.some((s) => s.id === z.frontId) ? frontLabel(w, f.id, z.frontId) : t('zone.unheld');
    const done = k.standing >= k.planned;
    return h('div', { class: `zone-row ${done ? 'done' : ''}`, title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(c.x, c.z) },
      h('span', { class: 'zr-id num' }, `#${z.id + 1}`),
      h('span', { class: 'zr-front' }, holder),
      h('span', { class: 'zr-works num', title: t('zone.worksTip') }, t('zone.works', { n: k.standing, of: k.planned }) + (k.building > 0 ? ` ${t('zone.building', { n: k.building })}` : '')),
      h('button', {
        class: 'btn zr-cancel', title: t('zone.cancelTip'),
        onclick: (e: Event) => { e.stopPropagation(); this.ctx.issue({ type: 'cancelZone', zoneId: z.id }); },
      }, t('zone.cancel')),
      h('span', { class: 'zr-bar', 'aria-hidden': 'true' }, h('i', { style: `transform:scaleX(${k.frac.toFixed(3)})` })));
  }
}
