import { stationOwner } from '../sim/rail';
import type { World } from '../sim/world';
import type { GameContext } from './context';
import { h, PressGuard } from './dom';
import { lang, t } from './i18n';

/** Station label: its settlement's name, or its capital's. */
export function stationName(w: World, placeIdx: number): string {
  if (placeIdx >= 0) return w.objectives[placeIdx]?.name[lang()] ?? '?';
  return w.map.cities[-1 - placeIdx]?.name[lang()] ?? '?';
}

/** Engineers that are free to take a job (the mirror has no job list, so units on a manual order do not count). */
function freeEngineers(w: World, owner: number): number {
  let n = 0;
  for (const u of w.aliveUnits) if (u.owner === owner && u.hp > 0 && u.def.id === 'engineer' && !u.manual) n++;
  return n;
}

/**
 * 3.0 Engineering popover (V30_SPEC section 10): build a road (two map points), rebuild a cut own
 * rail line (list), extend the rail from a station to a town (two clicks). The map clicks are
 * handled by the input controller through `ctx.mode = { kind: 'engineer', ... }`.
 */
export class EngineeringPanel {
  readonly el: HTMLElement;
  private open = false;
  private sig = '';
  private readonly guard: PressGuard;

  constructor(private readonly ctx: GameContext) {
    this.el = h('div', { class: 'eco eng panel' });
    this.el.style.display = 'none';
    this.guard = new PressGuard(this.el);
  }

  dispose(): void {
    this.guard.dispose();
  }

  toggle(): void {
    this.open = !this.open;
    this.sig = '';
    if (!this.open && this.ctx.mode.kind === 'engineer') this.ctx.mode = { kind: 'normal' };
  }

  relabel(): void {
    this.sig = '';
  }

  /** Map-pick hint for the HUD mode strip ('' when not picking). */
  modeHint(): string {
    const m = this.ctx.mode;
    if (m.kind !== 'engineer') return '';
    if (m.tool === 'road') return t(m.a ? 'eng.pickRoadB' : 'eng.pickRoadA');
    return t(m.station === null ? 'eng.pickStation' : 'eng.pickTown');
  }

  private cutLines(w: World): { id: number; a: number; b: number; held: boolean }[] {
    const st = w.transport;
    const me = this.ctx.playerId;
    if (!st) return [];
    const out: { id: number; a: number; b: number; held: boolean }[] = [];
    for (const l of st.lines) {
      if (!l.cut) continue;
      const sa = st.stations[l.a];
      const sb = st.stations[l.b];
      const oa = stationOwner(w, sa);
      const ob = stationOwner(w, sb);
      if (oa !== me && ob !== me) continue;
      out.push({ id: l.id, a: sa.placeIdx, b: sb.placeIdx, held: oa === me && ob === me });
    }
    return out;
  }

  refresh(): void {
    const w = this.ctx.match.world;
    if (!this.open || !w.transport || this.ctx.spectator) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const cuts = this.cutLines(w);
    const eng = freeEngineers(w, this.ctx.playerId);
    const m = this.ctx.mode;
    const tool = m.kind === 'engineer' ? m.tool : '';
    const sig = JSON.stringify([cuts, eng, tool, lang()]);
    if (sig === this.sig || this.guard.held) return;
    this.sig = sig;
    const pick = (mode: typeof m): void => { this.ctx.mode = mode; this.sig = ''; };
    this.el.innerHTML = '';
    this.el.append(
      h('div', { class: 'title' }, t('eng.title'), h('button', { class: 'btn icon close', onclick: () => this.toggle() }, '×')),
      h('div', { class: 'row' },
        h('button', { class: `btn ${tool === 'road' ? 'on' : ''}`, onclick: () => pick(tool === 'road' ? { kind: 'normal' } : { kind: 'engineer', tool: 'road', a: null }) }, t('eng.road')),
        h('button', { class: `btn ${tool === 'extend' ? 'on' : ''}`, onclick: () => pick(tool === 'extend' ? { kind: 'normal' } : { kind: 'engineer', tool: 'extend', station: null }) }, t('eng.extend'))),
      h('div', { class: 'small' }, t('eng.engineers', { n: eng })),
      ...(eng === 0 ? [h('div', { class: 'small' }, t('eng.noEngineer'))] : []),
      h('div', { class: 'title small' }, t('eng.repair')),
      ...(cuts.length === 0 ? [h('div', { class: 'small' }, t('eng.noCut'))] : []),
      ...cuts.map((c) => h('div', { class: 'row' },
        h('span', { class: 'small' }, t('eng.line', { n: c.id + 1, a: stationName(w, c.a), b: stationName(w, c.b) }), c.held ? '' : ` ${t('eng.notHeld')}`),
        h('button', { class: 'btn', disabled: !c.held, onclick: () => this.ctx.issue({ type: 'repairRail', lineId: c.id }) }, t('eng.fix')))),
    );
  }
}
