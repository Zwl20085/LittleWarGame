import { researchBlock, researchProgress, upgradeCost, UPGRADE_IDS, type UpgradeId } from '../sim/upgrades';
import { upgradeBit } from '../sim/upgradestats';
import type { Faction, Unit } from '../sim/types';
import type { GameContext } from './context';
import { h, PressGuard } from './dom';
import { t } from './i18n';

/** Description key: tiers share one line. */
const descKey = (id: UpgradeId): string => (id.startsWith('armour') ? 'upgd.armour' : id.startsWith('gun_') ? 'upgd.gun' : `upgd.${id}`);

/** Names of the upgrades a unit carries (unit card). */
export function unitUpgradeNames(u: Unit): string[] {
  const out: string[] = [];
  for (const id of UPGRADE_IDS) {
    if ((u.upg & upgradeBit(id)) === 0) continue;
    // Tiers: only the highest of a family (armour_2 hides armour_1).
    const next = id.replace(/_(\d)$/, (_m, n: string) => `_${Number(n) + 1}`);
    if (next !== id && (u.upg & upgradeBit(next)) !== 0) continue;
    out.push(t(`upg.${id}`));
  }
  return out;
}

/**
 * 3.0 Upgrades panel (V30_SPEC §9): the tree with prices and research times, the research under
 * way with its progress and a cancel button. Toggled by its HUD button or Y.
 */
export class UpgradesPanel {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private open = false;
  private sig = '';
  private readonly guard: PressGuard;

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'upg panel' });
    this.el.style.display = 'none';
    this.guard = new PressGuard(this.el);
    this.button = h('button', { class: 'btn upg-btn', title: t('upg.buttonTip'), onclick: () => this.toggle() }, t('upg.button'));
    const on = !!ctx.match.world.data.rules.upgrades?.enabled && !ctx.spectator;
    if (!on) this.button.style.display = 'none';
  }

  dispose(): void {
    this.guard.dispose();
  }

  toggle(): void {
    if (this.button.style.display === 'none') return;
    this.open = !this.open;
    this.sig = '';
  }

  relabel(): void {
    this.button.textContent = t('upg.button');
    this.button.title = t('upg.buttonTip');
    this.sig = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    this.button.classList.toggle('on', this.open);
    if (!this.open || !f?.upgrades) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const res = f.upgrades.research;
    const sig = JSON.stringify([f.upgrades.owned, res?.id, Math.round(researchProgress(w, f) * 50), Math.round(f.p / 10), Math.round(f.m / 10)]);
    if (sig === this.sig || this.guard.held) return;
    this.sig = sig;
    this.el.innerHTML = '';
    this.el.append(
      h('div', { class: 'title' }, t('upg.title'), h('button', { class: 'btn icon close', onclick: () => this.toggle() }, '×')),
      this.current(f),
      h('div', { class: 'upg-list' }, ...UPGRADE_IDS.map((id) => this.row(f, id))),
      h('div', { class: 'small' }, t('upg.note')),
    );
  }

  private current(f: Faction): HTMLElement {
    const w = this.ctx.match.world;
    const res = f.upgrades.research;
    if (!res) return h('div', { class: 'reason' }, t('upg.idle'));
    const pct = Math.round((w.data.rules.upgrades?.cancel_refund_ratio ?? 0) * 100);
    const frac = researchProgress(w, f);
    return h('div', { class: 'upg-now' },
      h('div', { class: 'meter' }, h('span', { class: 'lbl' }, t('upg.researching', { name: t(`upg.${res.id}`) })),
        h('div', { class: 'bar' }, h('div', { class: 'fill', style: `transform:scaleX(${frac})` })),
        h('span', { class: 'num small' }, `${Math.max(0, Math.ceil(res.endsAt - w.time))}s`)),
      h('button', { class: 'btn danger', onclick: () => this.ctx.issue({ type: 'cancelResearch' }) }, t('upg.cancel', { pct })));
  }

  private row(f: Faction, id: UpgradeId): HTMLElement {
    const w = this.ctx.match.world;
    const r = w.data.rules.upgrades;
    const c = upgradeCost(w, f, id);
    const block = researchBlock(w, f, id);
    const req = (r?.items[id]?.requires ?? []).map((q) => t(`upg.${q}`)).join(', ');
    const state = block === 'OWNED'
      ? h('span', { class: 'upg-owned' }, `✓ ${t('upg.owned')}`)
      : block === 'LOCKED'
        ? h('span', { class: 'small' }, t('upg.locked', { req }))
        : h('button', { class: `btn ${block === null ? 'primary' : ''}`, disabled: block !== null, title: block ? t(`fail.${block}`) : '', onclick: () => this.ctx.issue({ type: 'research', upgradeId: id }) },
          block === 'BUSY' ? t('upg.busy') : t('upg.buy'));
    return h('div', { class: `upg-row ${block === 'OWNED' ? 'done' : ''}` },
      h('div', { class: 'upg-name' }, h('b', {}, t(`upg.${id}`)), h('div', { class: 'small' }, t(descKey(id)))),
      h('div', { class: 'upg-cost small' }, t('upg.cost', { p: c.p, m: c.m, s: r?.items[id]?.seconds ?? 0 })),
      state);
  }
}
