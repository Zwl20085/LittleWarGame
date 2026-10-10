import { frontById, frontUnits } from '../sim/fronts';
import type { Directive, DirectiveKind, Front, OrderKind } from '../sim/types';
import { dist, type V2 } from '../sim/vec';
import type { World } from '../sim/world';
import type { GameContext } from './context';
import { fmtTime, h, PressGuard } from './dom';
import { t } from './i18n';
import { factionLabel, frontLabel, localizeParams, objectiveLabel } from './labels';
import { inPosition, ZonesSection } from './zones';

/** The five directives: palette order, hotkey (input.ts DIRECTIVE_KEYS), glyph and the order colour they read as. */
export const DIRECTIVES: readonly { kind: DirectiveKind; key: string; glyph: string; tone: OrderKind }[] = [
  { kind: 'offensive', key: 'Z', glyph: '➤', tone: 'attack' },
  { kind: 'advance', key: 'X', glyph: '✥', tone: 'auto' },
  { kind: 'defend', key: 'C', glyph: '┳', tone: 'defend' },
  { kind: 'fortify', key: 'V', glyph: '♜', tone: 'fortify' },
  { kind: 'contract', key: 'B', glyph: '↶', tone: 'fallBack' },
];
export const DIRECTIVE_TONE = Object.fromEntries(DIRECTIVES.map((d) => [d.kind, d.tone])) as Record<DirectiveKind, OrderKind>;
/** Directives that take an optional place after the button: an axis click, or (fortify) a dragged line. */
const PLACED = new Set<DirectiveKind>(['offensive', 'defend', 'fortify']);
/** Game seconds the opening briefing stays up (unless dismissed or a directive is given). */
const BRIEFING_S = 150;
/** More fronts than this: collapsed cards shrink to one row (the expanded one keeps the detail). */
const COMPACT_OVER = 3;

/** Name of the settlement nearest `p` (for axis / line captions). */
function placeNear(w: World, p: V2): string {
  let best = '';
  let bd = Infinity;
  for (const o of w.objectives) {
    const d = dist(o.pos, p);
    if (d < bd) { bd = d; best = o.id; }
  }
  return best ? objectiveLabel(w, best) : '—';
}

/** `{place}` for a front's response: its objective, an enemy capital, else '—'. */
function responseText(w: World, s: Front): string {
  if (!s.response) return '';
  const p = s.responseParams;
  const place = typeof p.city === 'number' ? factionLabel(w, p.city) : typeof p.point === 'string' && p.point ? objectiveLabel(w, p.point) : '—';
  return t(s.response, { ...p, place });
}

/**
 * Left column (2.2, docs/V22_SPEC.md §1): the player is the supreme HQ and gives ONE directive — a
 * five-button palette (Z X C V B) with an optional axis click / fortify line on the map. Fronts are
 * opened, merged and closed by the theatre; their cards are read-only dossiers: the commander's
 * response to the directive and its reason, the commander, troops and (expanded) the plan.
 * Re-rendered only when the content signature changes and never while a pointer is pressed on the
 * panel (PressGuard: a rebuild between press and release swallowed clicks in 2.1).
 */
export class FrontsPanel {
  readonly el: HTMLElement;
  private readonly command: HTMLElement;
  private readonly cards: HTMLElement;
  /** Opening briefing slip (mounted by the HUD, bottom centre). */
  readonly briefing: HTMLElement;
  private readonly log: HTMLElement;
  private readonly guard: PressGuard;
  private expanded: number | null = null;
  /** Front the directive's place under the cursor would go to (nearest front), for highlighting. */
  previewTarget: number | null = null;
  private lastLogSig = '';
  private sig = '';
  private cmdSig = '';
  private briefingDone = false;
  /** Last seen order per front (`issuedAt|kind`) to stamp fresh orders. */
  private seenOrders = new Map<number, string>();
  private fresh = new Map<number, number>();
  /** Fortified-zone list on the supreme-HQ card (2.1). */
  private readonly zones: ZonesSection;
  /** Front last scrolled into view (only a newly expanded card is scrolled to). */
  private scrolledTo: number | null = null;

  constructor(private readonly ctx: GameContext) {
    this.command = h('section', { class: 'hq-card orders panel paper-stack' });
    this.cards = h('div', { class: 'front-cards' });
    this.briefing = h('div', { class: 'briefing panel' });
    this.log = h('div', { class: 'eventlog' });
    this.zones = new ZonesSection(ctx);
    this.el = h('aside', { class: 'left' }, this.command, this.cards, this.log);
    this.guard = new PressGuard(this.el);
  }

  dispose(): void {
    this.guard.dispose();
  }

  /** Expand / collapse a front's dossier. */
  toggle(id: number | null): void {
    this.expanded = this.expanded === id ? null : id;
    if (this.expanded === null) this.scrolledTo = null;
    this.sig = '';
  }

  relabel(): void {
    this.sig = '';
    this.cmdSig = '';
    this.lastLogSig = '';
    this.zones.relabel();
  }

  /**
   * Palette / hotkey: the directive is issued at once; offensive / defend / fortify then wait for an
   * optional place on the map (the same key again, Esc or RMB ends the placing).
   */
  pickDirective(kind: DirectiveKind): void {
    const f = this.ctx.match.world.factions[this.ctx.playerId];
    if (!f || this.ctx.spectator) return;
    const m = this.ctx.mode;
    if (m.kind === 'directive' && m.directive === kind) {
      this.ctx.mode = { kind: 'normal' };
      return;
    }
    this.ctx.issue({ type: 'setDirective', kind });
    this.ctx.toast(t('dir.issued', { dir: t(`dir.${kind}`) }));
    this.briefingDone = true;
    this.ctx.mode = PLACED.has(kind) ? { kind: 'directive', directive: kind } : { kind: 'normal' };
    this.cmdSig = '';
  }

  /** The input controller placed the directive's axis / line (the command is already issued). */
  placed(kind: DirectiveKind, at: V2, line: boolean): void {
    const w = this.ctx.match.world;
    this.ctx.toast(line ? t('dir.lineSet', { place: placeNear(w, at) }) : t('dir.axisSet', { dir: t(`dir.${kind}`), place: placeNear(w, at) }));
  }

  /** Mode hint while a directive's place is being picked. */
  modeHint(): string {
    const m = this.ctx.mode;
    return m.kind === 'directive' ? t(`dir.pick.${m.directive}`) : '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const hide = !f || this.ctx.spectator;
    this.command.style.display = hide ? 'none' : '';
    this.cards.style.display = hide ? 'none' : '';
    if (hide) this.briefing.style.display = 'none';
    // Never replace the panel's elements under a pressed pointer (the click would be lost).
    if (this.guard.held) return;
    if (!hide) {
      if (this.expanded !== null && !frontById(f, this.expanded)) this.expanded = null;
      this.announce();
      this.renderCommand();
      this.zones.refresh();
      this.renderBriefing();
      const counts = f.fronts.map((s) => frontUnits(w, f.id, s.id).length);
      const openFront = this.expanded !== null ? frontById(f, this.expanded) : undefined;
      const pos = openFront ? inPosition(w, f, openFront) : null;
      const now = w.time;
      const sig = JSON.stringify([
        f.fronts.map((s) => {
          const c = w.unitAlive(s.commanderId);
          return [s.id, s.name, s.order.kind, s.order.issuedAt, s.order.manual, s.response, s.responseParams, s.reason, s.reasonParams, s.op, s.opPhase, s.posture,
            c ? Math.round((c.hp / c.def.maxHp) * 20) : -1, c?.status, s.commanderLostAt >= 0 && !c ? Math.round(now - s.commanderLostAt) : 0,
            this.fresh.has(s.id)];
        }),
        f.mainFront, counts, this.expanded, this.previewTarget, pos,
      ]);
      if (sig !== this.sig) {
        this.sig = sig;
        this.renderCards(counts);
      }
    }
    this.renderLog();
  }

  /** Stamp: "奉命 · 突击" for an order under the player's directive (binding), "自主 · …" for the commander's own. */
  private stampText(s: Front): string {
    if (s.order.kind === 'auto') return t('order.stampAuto');
    const order = t(`order.short.${s.order.kind}`);
    return t(s.order.manual ? 'resp.stampBound' : 'resp.stampOwn', { order });
  }

  /** Stamp animation when a front's commander changes its order. */
  private announce(): void {
    const f = this.ctx.match.world.factions[this.ctx.playerId];
    const first = this.seenOrders.size === 0;
    for (const s of f.fronts) {
      const key = `${s.order.issuedAt}|${s.order.kind}`;
      const prev = this.seenOrders.get(s.id);
      this.seenOrders.set(s.id, key);
      if (!first && prev !== undefined && prev !== key) this.fresh.set(s.id, performance.now());
    }
    for (const [id, at] of this.fresh) if (performance.now() - at > 1600) this.fresh.delete(id);
  }

  /** Caption of the directive in force: its axis / line and when it was issued. */
  private directiveRow(w: World, d: Directive): HTMLElement {
    const tone = DIRECTIVE_TONE[d.kind];
    const where = d.line ? t('dir.line', { place: placeNear(w, { x: (d.line.a.x + d.line.b.x) / 2, z: (d.line.a.z + d.line.b.z) / 2 }) })
      : d.axis ? t(d.kind === 'offensive' ? 'dir.axis' : 'dir.threat', { place: placeNear(w, d.axis) }) : '';
    const focus = d.line ? { x: (d.line.a.x + d.line.b.x) / 2, z: (d.line.a.z + d.line.b.z) / 2 } : d.axis;
    return h('button', {
      class: `hq-row dir-now k-${tone}`, title: focus ? t('hq.goto') : t(`dir.tip.${d.kind}`),
      onclick: () => { if (focus) this.ctx.renderer.rig.lookAt(focus.x, focus.z); },
    },
    h('span', { class: 'hq-kind' }, t('dir.current')),
    h('span', { class: 'hq-obj' }, `${t(`dir.${d.kind}`)}${where ? ` · ${where}` : ''}`),
    h('span', { class: 'hq-n' }, d.manual ? fmtTime(d.issuedAt) : t('dir.byAi')));
  }

  /** Supreme-HQ card: title, capital alert, staff notes, the directive in force and the directive palette. */
  private renderCommand(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const home = f.command?.homeThreat;
    const dirs = (f.command?.directives ?? []).slice(0, 3);
    const d = f.directive;
    const m = this.ctx.mode;
    const armed = m.kind === 'directive' ? m.directive : null;
    const sig = JSON.stringify([armed, d, home?.active, Math.round((home?.eta ?? 0) / 10), home?.recall.length, dirs.map((x) => [x.kind, x.obj, x.assigned])]);
    if (sig === this.cmdSig) return;
    this.cmdSig = sig;
    this.command.innerHTML = '';
    this.command.append(h('div', { class: 'hq-head' },
      h('span', { class: 'hq-title' }, t('hq.supreme')),
      h('span', { class: 'hq-sub' }, t('dir.title'))));
    if (home?.active) {
      const hq = w.hqPos(this.ctx.playerId);
      this.command.append(h('button', { class: 'hq-row k-defend alert', title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(hq.x, hq.z) },
        h('span', { class: 'hq-kind' }, t('hq.home')),
        h('span', { class: 'hq-obj' }, home.eta >= 0 ? t('hq.homeEta', { eta: Math.round(home.eta) }) : ''),
        h('span', { class: 'hq-n' }, home.recall.length > 0 ? t('hq.homeGroups', { n: home.recall.length }) : '')));
    }
    for (const x of dirs) {
      this.command.append(h('button', { class: `hq-row k-${x.kind}`, title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(x.pos.x, x.pos.z) },
        h('span', { class: 'hq-kind' }, t(`hq.${x.kind}`)),
        h('span', { class: 'hq-obj' }, localizeParams(w, { point: x.obj }).point as string),
        h('span', { class: 'hq-n' }, x.assigned > 0 ? t('front.units', { n: x.assigned }) : '')));
    }
    this.command.append(
      this.directiveRow(w, d),
      h('div', { class: 'order-palette directive-palette', role: 'toolbar', 'aria-label': t('dir.title') },
        ...DIRECTIVES.map((o) => h('button', {
          class: `obtn k-${o.tone} ${armed === o.kind ? 'armed' : ''} ${d.kind === o.kind ? 'active' : ''}`,
          'data-directive': o.kind,
          title: `${t(`dir.${o.kind}`)} — ${t(`dir.tip.${o.kind}`)} (${o.key})`,
          'aria-pressed': String(d.kind === o.kind),
          onclick: () => this.pickDirective(o.kind),
        }, h('span', { class: 'og', 'aria-hidden': 'true' }, o.glyph), h('span', { class: 'on' }, t(`dir.short.${o.kind}`)), h('kbd', {}, o.key)))),
      h('div', { class: 'order-how' }, armed ? t(`dir.pick.${armed}`) : t('dir.how')),
      this.zones.el,
    );
  }

  private renderBriefing(): void {
    const w = this.ctx.match.world;
    const show = !this.briefingDone && w.time < BRIEFING_S && !this.ctx.spectator;
    this.briefing.style.display = show ? '' : 'none';
    if (!show || this.briefing.childElementCount > 0) return;
    this.briefing.append(
      h('div', { class: 'brief-head' }, h('span', { class: 'stamp' }, t('brief.stamp')), h('b', {}, t('brief.title')),
        h('button', { class: 'btn icon close', 'aria-label': '×', onclick: () => { this.briefingDone = true; this.briefing.style.display = 'none'; } }, '×')),
      h('div', { class: 'brief-body' }, t('brief.body')));
  }

  private renderCards(counts: number[]): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    this.cards.innerHTML = '';
    this.cards.classList.toggle('compact', f.fronts.length > COMPACT_OVER);
    // Many fronts: the supreme-HQ card drops its tutorial line and staff notes to leave room for the cards.
    this.el.classList.toggle('busy', f.fronts.length > COMPACT_OVER);
    f.fronts.forEach((s, i) => {
      const main = s.id === f.mainFront;
      const open = this.expanded === s.id;
      const aimed = this.ctx.mode.kind === 'directive' && this.previewTarget === s.id;
      const card = h('div', {
        class: `front-card panel k-${s.order.kind} ${open ? 'open' : ''} ${main ? 'main' : ''} ${aimed ? 'aimed' : ''} ${this.fresh.has(s.id) ? 'fresh' : ''}`,
        role: 'button', tabindex: 0, 'data-front': s.id,
        title: t('front.cardTip'),
        onclick: () => this.select(s),
        onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') this.select(s); },
      },
      h('div', { class: 'fc-top' },
        h('span', { class: 'fc-idx num' }, String(i + 1)),
        h('b', { class: 'fc-name' }, frontLabel(w, f.id, s.id)),
        main ? h('span', { class: 'fc-main', title: t('front.mainTip') }, '★') : null,
        h('span', { class: 'fc-mini num', title: t('front.troopsTip') }, String(counts[i])),
        h('span', { class: `order-stamp k-${s.order.kind} ${s.order.manual ? 'manual' : 'own'}` }, this.stampText(s))),
      h('div', { class: 'fc-resp' }, responseText(w, s)),
      this.commanderRow(s, counts[i]),
      h('div', { class: 'fc-reason' }, this.reasonText(s)));
      this.cards.append(card);
      if (open) {
        card.append(this.detail(s));
        // Keep the expanded front in view when the list scrolls (8 fronts on a short screen).
        if (this.scrolledTo !== s.id) requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest' }));
        this.scrolledTo = s.id;
      }
    });
  }

  private select(s: Front): void {
    const opening = this.expanded !== s.id;
    this.toggle(s.id);
    if (!opening) return;
    const c = this.ctx.match.world.unitAlive(s.commanderId);
    const p = c ? c.pos : s.front;
    this.ctx.renderer.rig.lookAt(p.x, p.z);
  }

  private reasonText(s: Front): string {
    const w = this.ctx.match.world;
    const c = w.unitAlive(s.commanderId);
    if (!c && s.commanderLostAt >= 0) {
      const left = Math.max(0, Math.round(w.data.rules.command.commander_respawn_seconds - (w.time - s.commanderLostAt)));
      return t('front.noCommander', { s: left });
    }
    return s.reason ? t(s.reason, localizeParams(w, s.reasonParams)) : '';
  }

  /** Commander pennant + HP bar + status, and the troop count. */
  private commanderRow(s: Front, troops: number): HTMLElement {
    const w = this.ctx.match.world;
    const c = w.unitAlive(s.commanderId);
    const frac = c ? Math.max(0, Math.min(1, c.hp / c.def.maxHp)) : 0;
    return h('div', { class: 'fc-cmd' },
      h('span', { class: `fc-flag ${c ? '' : 'lost'}`, title: t('front.commander'), style: `--fc:${w.factions[this.ctx.playerId].color}` }),
      h('span', { class: 'fc-hp', title: c ? `${Math.round(c.hp)} HP` : '' }, h('i', { style: `transform:scaleX(${frac.toFixed(2)})`, class: frac < 0.35 ? 'low' : '' })),
      h('span', { class: 'fc-status' }, c ? t(c.status || 'status.commanderPost') : t('front.leaderless')),
      h('span', { class: 'fc-troops num' }, t('front.units', { n: troops })));
  }

  /** Expanded dossier (read-only): the commander's plan, how long its action has stood, troops in position, locate. */
  private detail(s: Front): HTMLElement {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const stop = (fn: () => void) => (e: Event): void => { e.stopPropagation(); fn(); };
    const plan = `${t(`op.${s.op}`)}${s.opPhase ? ` · ${t(`phase.${s.opPhase}`)}` : ''} · ${t(`posture.${s.posture}`)}`;
    const since = s.order.kind === 'auto' ? '' : t('front.orderSince', { t: fmtTime(Math.max(0, w.time - s.order.issuedAt)), who: s.order.manual ? t('front.byYou') : t('front.byHq') });
    const pos = inPosition(w, f, s);
    return h('div', { class: 'fc-detail' },
      h('div', { class: 'kv plan' }, h('span', {}, t('front.plan')), h('b', { title: t(`op.${s.op}Tip`) }, plan)),
      since ? h('div', { class: 'kv' }, h('span', {}, t('front.order')), h('b', {}, since)) : null,
      pos && pos.total > 0 ? h('div', { class: 'kv obey', title: t('front.inPositionTip') },
        h('span', {}, t('front.inPosition')),
        h('span', { class: 'obey-bar', 'aria-hidden': 'true' }, h('i', { style: `transform:scaleX(${(pos.at / pos.total).toFixed(3)})` })),
        h('b', { class: 'num' }, `${pos.at}/${pos.total}`)) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: stop(() => this.ctx.renderer.rig.lookAt(s.targetPos.x, s.targetPos.z)) }, t('front.gotoObjective'))),
    );
  }

  private renderLog(): void {
    const w = this.ctx.match.world;
    const last = w.log[w.log.length - 1];
    const sig = last ? `${w.log.length}|${last.tick}|${last.key}` : '';
    if (sig === this.lastLogSig) return;
    this.lastLogSig = sig;
    const pid = this.ctx.playerId;
    const mine = w.log.filter((l) => (this.ctx.spectator ? l.severity !== 'info' || l.key === 'log.pointTaken' : l.faction === pid) && !l.key.startsWith('log.protect')).slice(-6);
    this.log.innerHTML = '';
    for (const l of mine.reverse()) {
      this.log.append(h('div', { class: `ev ${l.severity}` }, h('span', { class: 'ts' }, fmtTime(l.tick / w.tickHz)), ' ', t(l.key, localizeParams(w, l.params))));
    }
  }
}
