import { economyRates } from '../sim/economy';
import { econCounts } from '../sim/econ';
import { zoneOutput, zoneRules } from '../sim/econZones';
import { stockSummary } from '../sim/settlements';
import type { GameContext } from './context';
import { h, PressGuard } from './dom';
import { t } from './i18n';

/** Layer-3 popover: labour shares, locks, steward toggle and its reason (§6.2). */
export class EconomyPanel {
  readonly el: HTMLElement;
  private open = false;
  private sig = '';
  /** Income and the investment fund change every second: hold rebuilds while a button is pressed. */
  private readonly guard: PressGuard;

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'eco panel' });
    this.el.style.display = 'none';
    this.guard = new PressGuard(this.el);
  }

  dispose(): void {
    this.guard.dispose();
  }

  toggle(): void {
    this.open = !this.open;
    this.sig = '';
  }

  relabel(): void {
    this.sig = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    if (!this.open || !f) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const sig = JSON.stringify([f.alloc.map((a) => Math.round(a * 100)), f.locks, f.autoEconomy, f.autoInvest, Math.round(f.econFund.p), Math.round(f.econFund.m), f.stewardReason, f.stewardParams, Math.round(f.incomeP), Math.round(f.incomeM), Math.round(f.econP), Math.round(f.econM), Math.round(f.depot / 10), econCounts(w, f.id), w.econZones.map((z) => (z.owner === f.id ? `${z.level}${z.ruined ? 'x' : ''}${z.linked ? 'l' : ''}` : '')).join()]);
    if (sig === this.sig || this.guard.held) return;
    this.sig = sig;
    const rates = economyRates(f.alloc, w.data.rules);
    const names = ['eco.mobil', 'eco.industry', 'eco.logistics'];
    const outputs = [`+${Math.round(f.incomeP)} P${t('hud.perMin')}`, `+${Math.round(f.incomeM)} M${t('hud.perMin')}`, `L ${Math.round(rates.logistics)}`];
    this.el.innerHTML = '';
    this.el.append(
      h('div', { class: 'title' }, t('eco.title'), h('button', { class: 'btn icon close', onclick: () => this.toggle() }, '×')),
      h('div', { class: 'row' },
        h('button', { class: `btn ${f.autoEconomy ? 'on' : ''}`, onclick: () => this.ctx.issue({ type: 'setAuto', on: !f.autoEconomy }) }, f.autoEconomy ? t('eco.autoOn') : t('eco.autoOff')),
        h('button', { class: 'btn', onclick: () => this.ctx.issue({ type: 'resetAlloc' }) }, t('eco.reset'))),
      // 2.2.1: the steward invests in economic buildings unless the player takes it over.
      h('div', { class: 'row' },
        h('button', { class: `btn ${f.autoInvest ? 'on' : ''}`, title: t('eco.investTip'), onclick: () => this.ctx.issue({ type: 'setAutoInvest', on: !f.autoInvest }) }, f.autoInvest ? t('eco.investOn') : t('eco.investOff')),
        f.autoInvest && (f.econFund.p >= 1 || f.econFund.m >= 1) ? h('span', { class: 'small' }, t('eco.investFund', { p: Math.round(f.econFund.p), m: Math.round(f.econFund.m) })) : null),
      ...f.alloc.map((a, i) => {
        const slider = h('input', { type: 'range', min: 0, max: 100, value: Math.round(a * 100), disabled: f.autoEconomy && !f.locks[i] ? false : false,
          onchange: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value) / 100;
            const next: [number, number, number] = [...f.alloc];
            const others = [0, 1, 2].filter((k) => k !== i);
            const rest = Math.max(0, 1 - v);
            const sumO = others.reduce((s, k) => s + next[k], 0) || 1;
            for (const k of others) next[k] = (next[k] / sumO) * rest;
            next[i] = v;
            this.ctx.issue({ type: 'setAlloc', alloc: next });
            if (f.autoEconomy) this.ctx.issue({ type: 'setLock', index: i, locked: true });
          } });
        return h('div', { class: 'alloc' },
          h('span', { class: 'lbl' }, t(names[i])), slider, h('span', { class: 'num' }, `${Math.round(a * 100)}%`),
          h('label', { class: 'lock' }, h('input', { type: 'checkbox', checked: f.locks[i], onchange: (e: Event) => this.ctx.issue({ type: 'setLock', index: i, locked: (e.target as HTMLInputElement).checked }) }), t('eco.lock')),
          h('span', { class: 'small' }, outputs[i]));
      }),
      h('div', { class: 'small' }, t('eco.buildMul', { v: rates.buildTimeMul.toFixed(2) })),
      // 2.2: economic buildings and the settlement supply stocks.
      (() => {
        const c = econCounts(w, f.id);
        return h('div', { class: 'small' }, t('eco.buildings', { f: c.factory, r: c.recruit, d: c.depot, p: Math.round(f.econP), m: Math.round(f.econM) }));
      })(),
      (() => {
        const s = stockSummary(w, f);
        return h('div', { class: 'small' }, t('eco.stock', { s: Math.round(s.stock), c: Math.round(s.cap) }));
      })(),
      // 3.0: economic zones — summary and the build button (click on the map to site one).
      (() => {
        let lv = 0;
        let n = 0;
        let p = 0;
        let m = 0;
        for (const z of w.econZones) {
          if (z.owner !== f.id) continue;
          n++;
          lv += z.level;
          const o = zoneOutput(w, z);
          p += o.p;
          m += o.m;
        }
        return h('div', { class: 'row' },
          h('button', { class: 'btn', title: t('zone.buildTip'), disabled: !zoneRules(w), onclick: () => { this.ctx.mode = { kind: 'placeZone' }; } }, t('zone.build')),
          h('span', { class: 'small' }, t('zone.count', { n, lv, p: Math.round(p), m: Math.round(m) })));
      })(),
      h('div', { class: 'reason' }, t(f.stewardReason, f.stewardParams)),
    );
  }
}
