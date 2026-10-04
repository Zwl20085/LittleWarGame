import { aliveMembers } from '../sim/formulas';
import type { Unit } from '../sim/types';
import type { World } from '../sim/world';
import type { GameContext } from './context';
import { h } from './dom';
import { natoSymbol, silhouette } from './icons';
import { t, unitName, unitShortName } from './i18n';
import { factionLabel, frontLabel } from './labels';

const isCommander = (w: World, u: Unit): boolean => u.def.id === w.data.rules.command.commander_unit;

/** Right detail panel — layer 2, only while something is selected (VISUAL_UX §4.2). */
export class SelectionPanel {
  readonly el: HTMLElement;
  private sig = '';
  inspectEnemy: number | null = null;

  constructor(private readonly ctx: GameContext) {
    this.el = h('aside', { class: 'right panel paper-stack', 'aria-live': 'polite' });
    this.el.style.display = 'none';
  }

  relabel(): void {
    this.sig = '';
  }

  private meter(label: string, v: number, max: number, cls = ''): HTMLElement {
    const frac = Math.max(0, Math.min(1, v / max));
    return h('div', { class: 'meter' }, h('span', { class: 'lbl' }, label),
      h('div', { class: `bar ${cls}` }, h('div', { class: 'fill', style: `transform:scaleX(${frac})` })),
      h('span', { class: 'num small' }, String(Math.round(v))));
  }

  private moraleText(u: Unit): string {
    if (u.routing) return t('morale.routing');
    if (u.moraleState !== 'normal') return t(`morale.${u.moraleState}`);
    if (u.wavering) return t('morale.wavering');
    return t('morale.normal');
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const sel = [...this.ctx.renderer.units.selected].map((id) => w.unitAlive(id)).filter((u): u is Unit => !!u);
    const enemy = this.inspectEnemy !== null ? w.unitAlive(this.inspectEnemy) : null;
    if (sel.length === 0 && !enemy) {
      this.el.style.display = 'none';
      this.sig = '';
      return;
    }
    this.el.style.display = '';
    const units = sel.length > 0 ? sel : [enemy!];
    const sig = JSON.stringify(units.map((u) => [u.id, Math.round(u.hp), Math.round(u.morale), Math.round(u.suppression), Math.round(u.ammo * 20), u.status, u.setup, u.manual?.type, u.supplied, u.routing, u.moraleState]));
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.innerHTML = '';
    if (units.length === 1) this.single(units[0], sel.length === 0);
    else this.multi(units);
    if (sel.length > 0 && !this.ctx.spectator) this.commands();
  }

  private single(u: Unit, enemyView: boolean): void {
    const w = this.ctx.match.world;
    const maxHp = u.fixed ? 1400 : u.def.maxHp;
    const f = w.factions[u.owner];
    this.el.append(
      h('div', { class: 'sel-head' },
        h('div', { class: 'sel-badge', style: `--fc:${f.color}` }, natoSymbol(u.fixed ? 'mg' : u.def.id), h('span', { class: 'roman', style: `background:${f.color}` }, f.roman)),
        h('div', { class: 'sel-id' }, h('div', { class: 'title' }, unitName(u.fixed ? 'mg' : u.def.id)), h('div', { class: 'sub' }, enemyView ? t('sel.enemy') : factionLabel(w, u.owner)),
          isCommander(w, u) ? h('div', { class: 'sel-cmd' }, t('sel.commanderOf', { front: frontLabel(w, u.owner, u.frontId) })) : null)),
      h('div', { class: 'sel-sil' }, silhouette(u.fixed ? 'mg' : u.def.id)),
      this.meter(`${t('sel.hp')} ${u.def.kind === 'vehicle' ? '' : `(${aliveMembers(u.def, u.hp, maxHp)}/${u.def.memberCount})`}`, u.hp, maxHp, u.hp < maxHp * 0.3 ? 'danger' : ''),
      this.meter(t('sel.morale'), u.morale, 100, u.morale < 40 ? 'danger' : ''),
      this.meter(t('sel.supp'), u.suppression, 100, 'supp'),
      this.meter(t('sel.ammo'), u.ammo * 100, 100, u.ammo < 0.3 ? 'danger' : ''),
      h('div', { class: 'kv' }, h('span', {}, t('sel.morale')), h('b', {}, this.moraleText(u))),
    );
    if (enemyView) return;
    this.el.append(h('div', { class: 'kv' }, h('span', {}, t('sel.supply')), h('b', {}, u.supplied ? `${Math.round(u.supplyRatio * 100)}%` : '✕')));
    if (u.def.setupSeconds > 0) this.el.append(h('div', { class: 'kv' }, h('span', {}, '⚙'), h('b', {}, t(`sel.setup.${u.setup}`))));
    this.el.append(
      h('div', { class: 'kv' }, h('span', {}, t('sel.mode')), h('b', { class: u.manual ? 'manual' : '' }, u.manual ? t('sel.manual') : t('sel.auto'))),
      h('div', { class: 'kv' }, h('span', {}, t('sel.front')), h('b', {}, frontLabel(w, u.owner, u.frontId))),
      h('div', { class: 'status' }, u.status ? t(u.status) : '—'),
    );
  }

  private multi(units: Unit[]): void {
    const counts = new Map<string, number>();
    for (const u of units) counts.set(u.def.id, (counts.get(u.def.id) ?? 0) + 1);
    const lowest = Math.min(...units.map((u) => u.morale));
    const unsupplied = units.filter((u) => !u.supplied).length;
    this.el.append(
      h('div', { class: 'title stencil-head' }, t('sel.multi', { n: units.length })),
      h('div', { class: 'chips' }, ...[...counts].map(([id, n]) => h('span', { class: 'chip' }, natoSymbol(id), `${unitShortName(id)} ×${n}`))),
      h('div', { class: 'kv' }, h('span', {}, t('sel.lowestMorale')), h('b', {}, String(Math.round(lowest)))),
      h('div', { class: 'kv' }, h('span', {}, t('sel.unsupplied')), h('b', {}, String(unsupplied))),
    );
  }

  private commands(): void {
    const ids = [...this.ctx.renderer.units.selected];
    const order = (o: 'hold' | 'retreat' | 'resume'): void => this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: o });
    this.el.append(
      h('div', { class: 'btn-grid cmds' },
        h('button', { class: 'btn', onclick: () => (this.ctx.mode = { kind: 'attackMove' }) }, t('cmd.attackMove')),
        h('button', { class: 'btn', onclick: () => order('hold') }, t('cmd.hold')),
        h('button', { class: 'btn danger', onclick: () => order('retreat') }, t('cmd.retreat')),
        h('button', { class: 'btn primary', onclick: () => order('resume') }, t('cmd.resume'))),
      h('div', { class: 'hint' }, t('cmd.hint')),
    );
  }
}
