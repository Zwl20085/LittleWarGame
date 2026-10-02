import { economyRates } from '../sim/economy';
import type { GameContext } from './context';
import { h } from './dom';
import { t } from './i18n';

/** Layer-3 popover: labour shares, locks, steward toggle and its reason (§6.2). */
export class EconomyPanel {
  readonly el: HTMLElement;
  private open = false;
  private sig = '';

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'eco panel' });
    this.el.style.display = 'none';
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
    const sig = JSON.stringify([f.alloc.map((a) => Math.round(a * 100)), f.locks, f.autoEconomy, f.stewardReason, f.stewardParams, Math.round(f.incomeP), Math.round(f.incomeM)]);
    if (sig === this.sig) return;
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
      h('div', { class: 'reason' }, t(f.stewardReason, f.stewardParams)),
    );
  }
}
