import { personalityWeights } from '../sim/cityai';
import { canStart, normalizedWeights, unitCount } from '../sim/production';
import type { Personality } from '../sim/types';
import type { GameContext } from './context';
import { h, setText } from './dom';
import { natoSymbol, silhouette } from './icons';
import { t, unitName, unitShortName, weaponName } from './i18n';

interface Card {
  el: HTMLButtonElement;
  name: HTMLElement;
  cost: HTMLElement;
  count: HTMLElement;
  state: HTMLElement;
  bar: HTMLElement;
}

/** Bottom bar: unit cards (always on), production queue thumbnails, card popover, stat tooltips. */
export class ProductionBar {
  readonly el: HTMLElement;
  /** Hover/focus tooltip; mounted by the HUD outside any transformed panel. */
  readonly tip: HTMLElement;
  private readonly cards = new Map<string, Card>();
  private readonly grid: HTMLElement;
  private readonly queue: HTMLElement;
  private readonly pop: HTMLElement;
  private openUnit: string | null = null;
  private tipUnit: string | null = null;
  private popSig = '';
  private readonly presetSel: HTMLSelectElement;
  private readonly titleEl: HTMLElement;

  constructor(private readonly ctx: GameContext) {
    const data = ctx.match.world.data;
    this.grid = h('div', { class: 'cards' });
    this.tip = h('div', { class: 'unit-tip panel', role: 'tooltip' });
    this.tip.style.display = 'none';
    for (const id of data.unitOrder) {
      const name = h('span', { class: 'cname' });
      const cost = h('span', { class: 'ccost num' });
      const count = h('span', { class: 'ccount num' });
      const state = h('div', { class: 'cstate' });
      const bar = h('div', { class: 'cbar' });
      const el = h('button', {
        class: 'card', 'data-u': id,
        onclick: () => this.open(id),
        onmouseenter: () => this.showTip(id),
        onmouseleave: () => this.hideTip(),
        onfocus: () => this.showTip(id),
        onblur: () => this.hideTip(),
      },
      h('div', { class: 'ctop' }, natoSymbol(id), name),
      h('div', { class: 'csil' }, silhouette(id), count),
      h('div', { class: 'cfoot' }, cost),
      state,
      h('div', { class: 'cbarwrap' }, bar));
      this.grid.append(el);
      this.cards.set(id, { el, name, cost, count, state, bar });
    }
    this.queue = h('div', { class: 'queue' });
    this.pop = h('div', { class: 'card-pop panel' });
    this.pop.style.display = 'none';
    this.presetSel = h('select', { class: 'sel', onchange: () => this.applyPreset(this.presetSel.value as Personality) });
    this.titleEl = h('span', { class: 'stencil-head' });
    const page = (dir: number): HTMLButtonElement =>
      h('button', { class: 'btn icon pager', 'aria-label': dir < 0 ? '‹' : '›', onclick: () => this.grid.scrollBy({ left: dir * this.grid.clientWidth * 0.8, behavior: 'smooth' }) }, dir < 0 ? '‹' : '›');
    this.el = h('footer', { class: 'bottom panel paper-stack' },
      h('div', { class: 'bottom-head' }, this.titleEl, this.presetSel, this.queue),
      h('div', { class: 'cards-wrap' }, page(-1), this.grid, page(1)),
      this.pop);
    this.relabel();
  }

  relabel(): void {
    for (const [id, c] of this.cards) {
      setText(c.name, unitShortName(id));
      c.el.setAttribute('aria-label', unitName(id));
    }
    setText(this.titleEl, t('prod.title'));
    this.presetSel.innerHTML = '';
    this.presetSel.append(h('option', { value: '' }, `${t('prod.preset')}…`));
    for (const p of ['balanced', 'armor', 'infantry', 'artillery']) this.presetSel.append(h('option', { value: p }, t(`preset.${p}`)));
    this.popSig = '';
    if (this.tipUnit) this.showTip(this.tipUnit);
  }

  private applyPreset(p: Personality | ''): void {
    if (!p) return;
    const w = personalityWeights(this.ctx.match.world, p);
    for (const [id, v] of Object.entries(w)) this.ctx.issue({ type: 'setWeight', unitId: id, weight: v });
    this.presetSel.value = '';
  }

  open(id: string | null): void {
    this.openUnit = this.openUnit === id ? null : id;
    this.popSig = '';
    this.hideTip();
  }

  private showTip(id: string): void {
    if (this.openUnit === id) return;
    const card = this.cards.get(id);
    const w = this.ctx.match.world;
    const def = w.data.units.get(id);
    if (!card || !def) return;
    this.tipUnit = id;
    const primary = def.primaryWeapon ? w.data.weapons.get(def.primaryWeapon) : null;
    const row = (k: string, v: string): HTMLElement => h('div', { class: 'kv' }, h('span', {}, t(k)), h('b', { class: 'num' }, v));
    this.tip.innerHTML = '';
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'tip-head' }, natoSymbol(id), h('div', {}, h('div', { class: 'tip-name' }, unitName(id)), h('div', { class: 'tip-cost num' }, `${def.costP} P · ${def.costM} M`))),
      h('div', { class: 'tip-sil' }, silhouette(id)),
      row('tip.hp', `${def.maxHp}${def.memberCount > 1 ? ` · ${def.memberCount}×` : ''}`),
      row('tip.speed', `${def.speed} m/s`),
      primary ? row('tip.weapon', weaponName(primary.id)) : null,
      primary ? row('tip.range', `${primary.minRange > 0 ? `${primary.minRange}–` : ''}${primary.range} m`) : null,
      def.armorFront > 0 ? row('tip.armor', `${def.armorFront}/${def.armorSide}/${def.armorRear} mm`) : null,
      row('tip.vision', `${def.vision} m`),
      def.setupSeconds > 0 ? row('tip.setup', `${def.setupSeconds} s`) : null,
      row('tip.pop', String(def.population)),
      row('tip.build', `${def.buildSeconds} s`),
      h('div', { class: 'hint' }, t('tip.click')),
    ];
    this.tip.append(...parts.filter((x): x is HTMLElement => x !== null));
    this.tip.style.display = '';
    const r = card.el.getBoundingClientRect();
    const tw = this.tip.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    this.tip.style.left = `${left}px`;
    this.tip.style.bottom = `${window.innerHeight - r.top + 10}px`;
  }

  private hideTip(): void {
    this.tipUnit = null;
    this.tip.style.display = 'none';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    if (!f || this.ctx.spectator) {
      this.el.style.display = 'none';
      return;
    }
    const norm = normalizedWeights(w, f);
    for (const [id, c] of this.cards) {
      const def = w.data.units.get(id)!;
      const n = unitCount(w, f, id);
      setText(c.cost, `${def.costP}·${def.costM}`);
      setText(c.count, `${n}/${f.caps[id] ?? '∞'}`);
      const order = f.orders.find((o) => o.unitId === id);
      const block = canStart(w, f, def, false);
      let state = '';
      let cls = '';
      if (w.time < def.unlockSeconds) {
        state = t('prod.unlockShort', { s: Math.ceil(def.unlockSeconds - w.time) });
        cls = 'locked';
      } else if (f.paused[id]) {
        state = t('prod.pause');
        cls = 'paused';
      } else if (order) {
        state = order.blocked ? t('prod.blocked') : t('prod.building', { p: Math.floor((1 - order.remaining / order.total) * 100) });
        cls = 'building';
      } else if (f.protectedOrder?.unitId === id) {
        state = t('prod.protecting', { unit: unitShortName(id) });
        cls = 'protect';
      } else if (block && block !== 'LOCKED') {
        state = t(`block.${block}`);
        cls = 'blocked';
      } else state = `${Math.round((norm.get(id) ?? 0) * 100)}%`;
      setText(c.state, state);
      const nextCls = `card ${cls} ${this.openUnit === id ? 'open' : ''}`;
      if (c.el.className !== nextCls) c.el.className = nextCls;
      c.bar.style.transform = `scaleX(${order ? 1 - order.remaining / order.total : 0})`;
    }
    const qsig = JSON.stringify([f.orders.map((o) => [o.id, o.unitId]), f.manualQueue.length]);
    if (this.queue.dataset.sig !== qsig) {
      this.queue.dataset.sig = qsig;
      this.queue.innerHTML = '';
      for (const o of f.orders) {
        this.queue.append(h('button', { class: 'qitem', title: t('prod.cancel'), onclick: () => this.ctx.issue({ type: 'cancelOrder', orderId: o.id }) }, natoSymbol(o.unitId), unitShortName(o.unitId), o.manual ? ' ✱' : ''));
      }
      for (const q of f.manualQueue) this.queue.append(h('span', { class: 'qitem pending' }, natoSymbol(q.unitId), unitShortName(q.unitId), ' …'));
    }
    this.renderPop();
  }

  private renderPop(): void {
    const id = this.openUnit;
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    if (!id) {
      this.pop.style.display = 'none';
      return;
    }
    const sig = JSON.stringify([id, f.weights[id], f.caps[id], f.paused[id], f.unitSector[id]]);
    if (sig === this.popSig) return;
    this.popSig = sig;
    const def = w.data.units.get(id)!;
    const weight = f.weights[id] ?? 0;
    const cap = f.caps[id] ?? 0;
    const sectorSel = h('select', { class: 'sel', onchange: (e: Event) => this.ctx.issue({ type: 'setUnitSector', unitId: id, sectorId: Number((e.target as HTMLSelectElement).value) }) },
      h('option', { value: '-1' }, t('prod.autoSector')),
      ...f.sectors.map((s) => h('option', { value: String(s.id) }, t(`sector.${s.key}`))));
    sectorSel.value = String(f.unitSector[id] ?? -1);
    const wInput = h('input', { type: 'number', min: 0, max: 100, step: 1, value: weight, class: 'numin',
      onchange: (e: Event) => this.ctx.issue({ type: 'setWeight', unitId: id, weight: Number((e.target as HTMLInputElement).value) }) });
    const cInput = h('input', { type: 'number', min: 0, max: 40, step: 1, value: cap, class: 'numin',
      onchange: (e: Event) => this.ctx.issue({ type: 'setCap', unitId: id, cap: Number((e.target as HTMLInputElement).value) }) });
    const primary = def.primaryWeapon ? w.data.weapons.get(def.primaryWeapon) : null;
    this.pop.innerHTML = '';
    this.pop.style.display = '';
    const card = this.cards.get(id)?.el;
    if (card) {
      const host = this.el.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      this.pop.style.left = `${Math.max(8, Math.min(host.width - 330, r.left - host.left))}px`;
    }
    this.pop.append(
      h('div', { class: 'title' }, natoSymbol(id), unitName(id), h('button', { class: 'btn icon close', 'aria-label': '×', onclick: () => this.open(null) }, '×')),
      h('div', { class: 'stats num' },
        `${t('prod.cost')} ${def.costP}P / ${def.costM}M · HP ${def.maxHp} · ${def.speed} m/s`,
        primary ? ` · ${primary.range} m` : '',
        def.armorFront > 0 ? ` · ${def.armorFront}/${def.armorSide}/${def.armorRear} mm` : ''),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, t('prod.weight')), wInput),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, t('prod.cap')), cInput),
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, t('prod.sector')), sectorSel),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => this.ctx.issue({ type: 'togglePause', unitId: id }) }, f.paused[id] ? t('prod.resume') : t('prod.pause')),
        h('button', { class: 'btn primary', onclick: () => this.ctx.issue({ type: 'queueUnit', unitId: id, sectorId: Math.max(0, f.unitSector[id] ?? f.mainSector) }) }, `＋ ${t('prod.addOne')}`)),
    );
  }
}
