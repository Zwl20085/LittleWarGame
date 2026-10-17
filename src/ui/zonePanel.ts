import { zoneById, zoneJobCost, zoneOutput, zoneRules, type EconZone } from '../sim/econZones';
import { dist, type V2 } from '../sim/vec';
import type { GameContext } from './context';
import { h } from './dom';
import { t } from './i18n';

/** A click within this of a zone's centre opens its panel (m). */
const PICK_M = 36;

/**
 * 3.0 economic-zone panel (V30 §7): click a zone on the map → its level, condition, output and
 * road link, and the level-up (or rebuild) button. Rebuilt only when what it shows changes.
 */
export class ZonePanel {
  readonly el: HTMLElement;
  private zoneId: number | null = null;
  private sig = '';

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'town panel paper-stack', role: 'dialog' });
    this.el.style.display = 'none';
  }

  /** Map click on empty ground: open the zone under it (true) or close (false). */
  pickAt(p: V2 | null): boolean {
    let best: EconZone | null = null;
    if (p) {
      let bd: number = PICK_M;
      for (const z of this.ctx.match.world.econZones) {
        const d = dist(z.pos, p);
        if (d < bd) {
          bd = d;
          best = z;
        }
      }
    }
    this.zoneId = best?.id ?? null;
    this.sig = '';
    this.refresh();
    return best !== null;
  }

  relabel(): void {
    this.sig = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const z = this.zoneId !== null ? zoneById(w, this.zoneId) : undefined;
    if (!z) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const f = w.factions[this.ctx.playerId];
    const mine = !this.ctx.spectator && z.owner === this.ctx.playerId;
    const cost = mine ? zoneJobCost(w, z) : null;
    const afford = !!cost && !!f && f.p >= cost.p && f.m >= cost.m;
    const out = zoneOutput(w, z);
    const sig = JSON.stringify([z.id, z.owner, z.level, z.target, Math.round(z.progress * 20), Math.round((z.hp / Math.max(1, z.maxHp)) * 20), z.ruined, z.linked, afford, Math.round(out.p), Math.round(out.m)]);
    if (sig === this.sig) return;
    this.sig = sig;
    const max = zoneRules(w)?.levels.length ?? 3;
    const state = z.ruined ? t('zone.ruined')
      : z.progress < 1 ? t('zone.building', { pct: Math.round(z.progress * 100), level: z.target })
      : t('zone.level', { level: z.level });
    const action = !mine ? null
      : cost ? h('button', { class: 'btn', disabled: !afford, onclick: () => this.ctx.issue({ type: 'upgradeZone', zoneId: z.id }) },
        z.ruined ? t('zone.rebuild', cost) : t('zone.upgrade', { level: z.level + 1, p: cost.p, m: cost.m }))
      : z.level >= max ? h('span', { class: 'small' }, t('zone.max')) : null;
    this.el.innerHTML = '';
    this.el.append(
      h('div', { class: 'title' }, mine ? t('zone.title') : t('zone.enemy'), h('button', { class: 'btn icon close', onclick: () => this.pickAt(null) }, '×')),
      h('div', { class: 'row' }, h('b', {}, state)),
      h('div', { class: 'small' }, t('zone.hp', { pct: Math.round((100 * Math.max(0, z.hp)) / Math.max(1, z.maxHp)) })),
      h('div', { class: 'small' }, t('zone.output', { p: Math.round(out.p), m: Math.round(out.m) })),
      h('div', { class: 'small' }, z.linked ? t('zone.linked') : t('zone.unlinked')),
    );
    if (action) this.el.append(h('div', { class: 'row' }, action));
  }
}
