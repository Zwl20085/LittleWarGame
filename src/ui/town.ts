import type { EconKind } from '../data/types';
import { buildCost, buildingsAt, canBuild, ECON_KINDS, econRules, freeEconSlot } from '../sim/econ';
import { placeSlots } from '../sim/production';
import { drawRadius, placeById, placeContested, placeOwner, stockCap } from '../sim/settlements';
import type { Place } from '../sim/types';
import { dist, type V2 } from '../sim/vec';
import type { GameContext } from './context';
import { h, setText } from './dom';
import { natoSymbol } from './icons';
import { t, unitShortName } from './i18n';
import { factionLabel, objectiveLabel } from './labels';

const FACILITIES = ['barracks', 'vehicle', 'support'] as const;

/**
 * 2.2 town panel (V22_SPEC §4–5): click a capital / city / town on the map → its supply stock,
 * production queue and slots, economic buildings and build buttons. Its DOM is rebuilt only when
 * the structure changes (orders, buildings, affordability); bars and numbers update in place, so
 * a click is never lost to a rebuild between pointerdown and pointerup.
 */
export class TownPanel {
  readonly el: HTMLElement;
  private placeId: string | null = null;
  private sig = '';
  private readonly live: { el: HTMLElement; read: () => string }[] = [];
  private readonly bars: { el: HTMLElement; read: () => number }[] = [];

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'town panel paper-stack', role: 'dialog' });
    this.el.style.display = 'none';
  }

  get open(): boolean {
    return this.placeId !== null;
  }

  /** Map click on empty ground: open the place under the click, or close when there is none. */
  pickAt(p: V2 | null): boolean {
    const w = this.ctx.match.world;
    let best: Place | null = null;
    if (p) {
      let bd = Infinity;
      for (const q of w.places) {
        const r = q.objIdx >= 0 ? Math.max(60, w.objectives[q.objIdx].radius * 1.3) : 140;
        const d = dist(q.pos, p);
        if (d <= r && d < bd) {
          bd = d;
          best = q;
        }
      }
    }
    this.show(best?.id ?? null);
    return best !== null;
  }

  show(placeId: string | null): void {
    this.placeId = placeId;
    this.sig = '';
    this.refresh();
  }

  relabel(): void {
    this.sig = '';
  }

  private place(): Place | null {
    return this.placeId ? placeById(this.ctx.match.world, this.placeId) ?? null : null;
  }

  refresh(): void {
    const p = this.place();
    if (!p) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const sig = this.structureSig(p);
    if (sig !== this.sig) {
      this.sig = sig;
      this.build(p);
    }
    for (const l of this.live) setText(l.el, l.read());
    for (const b of this.bars) b.el.style.transform = `scaleX(${Math.max(0, Math.min(1, b.read()))})`;
  }

  private mine(p: Place): boolean {
    return !this.ctx.spectator && placeOwner(this.ctx.match.world, p) === this.ctx.playerId;
  }

  private structureSig(p: Place): string {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const orders = f ? f.orders.filter((o) => o.placeId === p.id).map((o) => o.id) : [];
    const queued = f ? f.manualQueue.filter((q) => q.placeId === p.id).map((q) => q.unitId) : [];
    const blds = buildingsAt(w, p.id).map((b) => `${b.id}${b.kind}${b.ruined ? 'x' : ''}${b.progress >= 1 ? 'd' : ''}`);
    const can = f && this.mine(p) ? ECON_KINDS.map((k) => canBuild(w, f, p, k) ?? 'ok') : [];
    return JSON.stringify([p.id, placeOwner(w, p), placeContested(w, p), orders, queued, blds, can, this.ctx.playerId]);
  }

  private build(p: Place): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const owner = placeOwner(w, p);
    const mine = this.mine(p);
    this.live.length = 0;
    this.bars.length = 0;
    const liveText = (read: () => string, cls = ''): HTMLElement => this.liveSpan(read, cls);
    const bar = (read: () => number, cls = ''): HTMLElement => this.bar(read, cls);
    const name = objectiveLabel(w, p.id);
    const kind = t(`town.kind.${p.kind}`);
    const head = h('div', { class: 'title' },
      h('span', {}, `${name} · ${kind}`),
      h('button', { class: 'btn icon close', 'aria-label': '×', onclick: () => this.show(null) }, '×'));
    const ownerLine = h('div', { class: 'small' }, owner >= 0 ? factionLabel(w, owner) : t('town.neutral'), placeContested(w, p) ? ` · ${t('town.contested')}` : '');
    // Supply stock.
    const stock = h('div', { class: 'tsec' },
      h('div', { class: 'tsec-h' }, t('town.stock'), liveText(() => `${Math.round(p.stock)} / ${Math.round(stockCap(w, p))}`, 'num')),
      bar(() => p.stock / Math.max(1, stockCap(w, p)), 'stock'),
      h('div', { class: 'small' }, t('town.stockTip', { r: Math.round(drawRadius(w, p)) })));
    this.el.innerHTML = '';
    this.el.append(head, ownerLine, stock);
    if (mine && f) this.el.append(this.productionSection(p), this.buildingSection(p, true));
    else this.el.append(this.buildingSection(p, false));
  }

  private productionSection(p: Place): HTMLElement {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const slots = FACILITIES.map((fac) => ({ fac, n: placeSlots(w, p, fac) })).filter((s) => s.n > 0);
    const sec = h('div', { class: 'tsec' }, h('div', { class: 'tsec-h' }, t('town.queue'),
      h('span', { class: 'small' }, slots.map((s) => `${t(`town.fac.${s.fac}`)} ${f.orders.filter((o) => o.placeId === p.id && o.facility === s.fac).length}/${s.n}`).join(' · '))));
    if (slots.length === 0) {
      sec.append(h('div', { class: 'small' }, t('town.noSlots')));
      return sec;
    }
    const list = h('div', { class: 'tqueue' });
    for (const o of f.orders.filter((x) => x.placeId === p.id)) {
      list.append(h('button', { class: 'qitem', title: t('prod.cancel'), onclick: () => this.ctx.issue({ type: 'cancelOrder', orderId: o.id }) },
        natoSymbol(o.unitId), unitShortName(o.unitId), o.manual ? ' ✱' : '',
        this.bar(() => {
          const live = this.ctx.match.world.factions[this.ctx.playerId].orders.find((x) => x.id === o.id);
          return live ? 1 - live.remaining / live.total : 1;
        }, 'q')));
    }
    for (const q of f.manualQueue.filter((x) => x.placeId === p.id)) list.append(h('span', { class: 'qitem pending' }, natoSymbol(q.unitId), unitShortName(q.unitId), ' …'));
    if (!list.childElementCount) list.append(h('span', { class: 'small' }, t('town.queueEmpty')));
    sec.append(list);
    // Queue a unit here: every unit type whose facility has a slot at this place.
    const facs = new Set(slots.map((s) => s.fac));
    const add = h('div', { class: 'tadd' });
    for (const id of w.data.unitOrder) {
      const def = w.data.units.get(id)!;
      if (id === w.data.rules.command.commander_unit || !facs.has(def.facility as (typeof FACILITIES)[number])) continue;
      const locked = w.time < def.unlockSeconds;
      add.append(h('button', {
        class: 'btn tunit', disabled: locked, title: `${unitShortName(id)} · ${def.costP}P ${def.costM}M`,
        onclick: () => this.ctx.issue({ type: 'queueUnit', unitId: id, frontId: -1, placeId: p.id }),
      }, natoSymbol(id), unitShortName(id)));
    }
    sec.append(h('div', { class: 'small' }, t('town.queueHere')), add);
    return sec;
  }

  private bar(read: () => number, cls: string): HTMLElement {
    const el = h('div', { class: 'tbar-fill' });
    this.bars.push({ el, read });
    return h('div', { class: `tbar ${cls}` }, el);
  }

  private liveSpan(read: () => string, cls: string): HTMLElement {
    const el = h('span', { class: cls });
    this.live.push({ el, read });
    return el;
  }

  private buildingSection(p: Place, mine: boolean): HTMLElement {
    const w = this.ctx.match.world;
    const r = econRules(w);
    const sec = h('div', { class: 'tsec' }, h('div', { class: 'tsec-h' }, t('town.buildings'), h('span', { class: 'small' }, `${buildingsAt(w, p.id).filter((b) => !b.ruined).length}/${p.slotPos.length}`)));
    if (!r || p.slotPos.length === 0) {
      sec.append(h('div', { class: 'small' }, t(p.capitalOf >= 0 ? 'town.capitalNoBuild' : 'town.noBuildSlots')));
      return sec;
    }
    for (const b of buildingsAt(w, p.id).sort((a, c) => a.slot - c.slot)) {
      // Snapshots replace the building records: always read the current one by id.
      const live = (): typeof b => this.ctx.match.world.econ.find((x) => x.id === b.id) ?? b;
      const state = (): string => {
        const x = live();
        return x.ruined ? t('town.ruin') : x.progress < 1 ? t('town.building', { p: Math.floor(x.progress * 100) }) : t('town.hp', { p: Math.round((100 * x.hp) / x.maxHp) });
      };
      const out = (): string => {
        const x = live();
        if (x.ruined || x.progress < 1) return '';
        const d = r.buildings[x.kind];
        const k = (w.data.rules.proposed_defaults.army_scale ?? 1) * (w.data.rules.proposed_defaults.army_scale_income_factor ?? 1);
        const h2 = x.hp / x.maxHp;
        if (x.kind === 'factory') return `+${Math.round(d.m_per_min_k * k * h2)} M${t('hud.perMin')}`;
        if (x.kind === 'recruit') return `+${Math.round(d.p_per_min_k * k * h2)} P${t('hud.perMin')}`;
        return t('town.depotOut');
      };
      const row = h('div', { class: `tbld ${b.ruined ? 'ruin' : ''}` },
        h('span', { class: 'tbld-k' }, t(`econ.${b.kind}`)),
        this.liveSpan(state, 'small'),
        this.liveSpan(out, 'small num'));
      sec.append(row);
    }
    if (!mine) return sec;
    const f = w.factions[this.ctx.playerId];
    const slot = freeEconSlot(w, p);
    const btns = h('div', { class: 'tadd' });
    for (const k of ECON_KINDS) {
      const why = canBuild(w, f, p, k);
      const cost = slot >= 0 ? buildCost(w, p, k, slot) : { p: r.buildings[k].cost_p, m: r.buildings[k].cost_m };
      btns.append(h('button', {
        class: 'btn tbuild', disabled: why !== null,
        title: `${t(`econ.${k}Tip`)}${why ? ` — ${t(`town.fail.${why}`)}` : ''}`,
        onclick: () => this.ctx.issue({ type: 'buildEcon', placeId: p.id, kind: k as EconKind }),
      }, h('b', {}, t(`econ.${k}`)), h('span', { class: 'small num' }, `${cost.p}P · ${cost.m}M · ${r.buildings[k].build_seconds}s`)));
    }
    sec.append(btns);
    return sec;
  }
}
