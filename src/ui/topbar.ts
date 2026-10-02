import { economyRates } from '../sim/economy';
import { populationCap } from '../sim/production';
import type { GameContext } from './context';
import { fmtTime, h, setText } from './dom';
import { BrassGauge } from './icons';
import { lang, setLang, t } from './i18n';
import { factionLabel } from './labels';

const SPEEDS = [1, 2, 4, 8] as const;

/**
 * Always-on layer 1 (VISUAL_UX §4.2) as a riveted gunmetal plate: stencilled nameplates with
 * recessed ivory read-outs, brass gauges for logistics and own resolve, clock and speed keys.
 */
export class TopBar {
  readonly el: HTMLElement;
  private readonly p = h('span', { class: 'num big' });
  private readonly pRate = h('span', { class: 'rate num' });
  private readonly m = h('span', { class: 'num big' });
  private readonly mRate = h('span', { class: 'rate num' });
  private readonly pop = h('span', { class: 'num' });
  private readonly logi = h('span', { class: 'num' });
  private readonly logiGauge = new BrassGauge(0.4);
  private readonly resolveGauge = new BrassGauge(0.25);
  private readonly resolveNum = h('span', { class: 'num' });
  private readonly resolveWrap = h('div', { class: 'resolves' });
  private readonly time = h('span', { class: 'num big' });
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly pauseBtn: HTMLButtonElement;
  private readonly autoBtn: HTMLButtonElement;
  private readonly langBtn: HTMLButtonElement;
  private readonly logiPlate: HTMLElement;
  private readonly resolvePlate: HTMLElement;
  private readonly labels: { el: HTMLElement; key: string }[] = [];

  constructor(private readonly ctx: GameContext, onEconomy: () => void, onHelp: () => void) {
    const lbl = (key: string): HTMLElement => {
      const el = h('span', { class: 'lbl' }, t(key));
      this.labels.push({ el, key });
      return el;
    };
    this.pauseBtn = h('button', { class: 'key', onclick: () => (ctx.paused = !ctx.paused) }, '❚❚');
    for (const s of SPEEDS) {
      const b = h('button', { class: 'key speed', onclick: () => { ctx.speed = s; ctx.paused = false; } }, `${s}×`);
      this.speedBtns.push(b);
    }
    this.autoBtn = h('button', { class: 'key wide', onclick: onEconomy }, '');
    this.langBtn = h('button', { class: 'key', onclick: () => setLang(lang() === 'zh' ? 'en' : 'zh') }, t('lang.toggle'));
    this.logiPlate = h('div', { class: 'np gauge-np' }, this.logiGauge.el, h('div', { class: 'np-col' }, lbl('hud.log'), h('div', { class: 'window' }, this.logi)));
    this.resolvePlate = h('div', { class: 'np gauge-np' }, this.resolveGauge.el, h('div', { class: 'np-col' }, lbl('hud.resolve'), h('div', { class: 'window' }, this.resolveNum)));
    const spectator = ctx.spectator;
    // Without the resolve system (default) the side bars show territory: settlements held.
    const resolveOn = !!ctx.match.world.data.rules.victory.resolve_enabled;
    this.el = h('header', { class: `topbar plate ${spectator ? 'spectator' : ''}` },
      h('i', { class: 'rivet tl' }), h('i', { class: 'rivet tr' }), h('i', { class: 'rivet bl' }), h('i', { class: 'rivet br' }),
      spectator ? null : h('div', { class: 'np' }, lbl('hud.p'), h('div', { class: 'window' }, this.p, this.pRate)),
      spectator ? null : h('div', { class: 'np' }, lbl('hud.m'), h('div', { class: 'window' }, this.m, this.mRate)),
      spectator ? null : h('div', { class: 'np' }, lbl('hud.pop'), h('div', { class: 'window' }, this.pop)),
      spectator ? null : this.logiPlate,
      spectator ? null : this.autoBtn,
      spectator || !resolveOn ? null : this.resolvePlate,
      h('div', { class: 'np grow' }, lbl(!resolveOn ? 'hud.territory' : ctx.spectator ? 'hud.resolve' : 'hud.sides'), this.resolveWrap),
      h('div', { class: 'np' }, lbl('hud.time'), h('div', { class: 'window' }, this.time)),
      h('div', { class: 'keys' }, this.pauseBtn, ...this.speedBtns),
      h('div', { class: 'keys' }, h('button', { class: 'key', onclick: onHelp, 'aria-label': t('hud.help') }, '?'), this.langBtn),
    );
    this.relabel();
  }

  relabel(): void {
    for (const l of this.labels) setText(l.el, t(l.key));
    setText(this.langBtn, t('lang.toggle'));
    this.pauseBtn.title = t('hud.pauseTip');
    this.speedBtns.forEach((b) => (b.title = t('hud.speedTip')));
    this.logiPlate.title = t('hud.logiTip');
    this.resolvePlate.title = t('hud.resolveTip');
    this.resolveWrap.innerHTML = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const initial = w.data.rules.victory.initial_resolve;
    if (f && !this.ctx.spectator) {
      const rates = economyRates(f.alloc, w.data.rules);
      setText(this.p, String(Math.floor(f.p)));
      setText(this.m, String(Math.floor(f.m)));
      setText(this.pRate, `+${Math.round(f.incomeP)}${t('hud.perMin')}`);
      setText(this.mRate, `+${Math.round(f.incomeM)}${t('hud.perMin')}`);
      setText(this.pop, `${f.popPresent}+${f.popReserved}/${populationCap(w, f)}`);
      const ratio = f.supplyDemand > 0 ? Math.min(1, f.logistics / f.supplyDemand) : 1;
      setText(this.logi, `${Math.round(f.logistics)}/${Math.round(f.supplyDemand)}`);
      this.logiGauge.set(ratio);
      this.logiPlate.classList.toggle('warn', ratio < 0.8);
      setText(this.resolveNum, String(Math.round(f.resolve)));
      this.resolveGauge.set(f.resolve / initial);
      this.resolvePlate.classList.toggle('warn', f.resolve / initial < 0.25);
      setText(this.autoBtn, `${f.autoEconomy ? t('hud.auto') : t('hud.manual')} ${Math.round(f.alloc[0] * 100)}/${Math.round(f.alloc[1] * 100)}/${Math.round(f.alloc[2] * 100)}`);
      this.autoBtn.title = t('eco.buildMul', { v: rates.buildTimeMul.toFixed(2) });
    }
    // Resolve of every side (own included), each with roman numeral + colour (not colour alone).
    if (this.resolveWrap.childElementCount !== w.factions.length) {
      this.resolveWrap.innerHTML = '';
      for (const fac of w.factions) {
        this.resolveWrap.append(h('div', { class: 'resolve', 'data-f': fac.id, title: factionLabel(w, fac.id) },
          h('span', { class: 'roman', style: `background:${fac.color}` }, fac.roman),
          h('div', { class: 'bar' }, h('div', { class: 'fill', style: `background:${fac.color}` })),
          h('span', { class: 'num small' })));
      }
    }
    const resolveOn = !!w.data.rules.victory.resolve_enabled;
    const held = w.factions.map(() => 0);
    if (!resolveOn) for (const o of w.objectives) if (o.owner >= 0) held[o.owner]++;
    const total = Math.max(1, w.objectives.length);
    for (const fac of w.factions) {
      const row = this.resolveWrap.querySelector(`[data-f="${fac.id}"]`) as HTMLElement;
      const value = resolveOn ? fac.resolve : held[fac.id];
      const frac = Math.max(0, resolveOn ? fac.resolve / initial : Math.min(1, (held[fac.id] / total) * 2));
      (row.querySelector('.fill') as HTMLElement).style.transform = `scaleX(${frac})`;
      setText(row.querySelector('.num') as HTMLElement, fac.alive ? String(Math.round(value)) : '✕');
      row.classList.toggle('dead', !fac.alive);
      row.classList.toggle('me', fac.id === this.ctx.playerId && !this.ctx.spectator);
    }
    setText(this.time, fmtTime(w.time));
    this.speedBtns.forEach((b, i) => b.classList.toggle('on', !this.ctx.paused && this.ctx.speed === SPEEDS[i]));
    this.pauseBtn.classList.toggle('on', this.ctx.paused);
  }
}
