import { frontById, frontUnits } from '../sim/fronts';
import type { Front, OrderKind } from '../sim/types';
import type { GameContext } from './context';
import { fmtTime, h } from './dom';
import { t } from './i18n';
import { frontLabel, localizeParams } from './labels';

/** Palette order and hotkeys (see `ORDER_KEYS` in input.ts). */
const ORDERS: { kind: OrderKind; key: string }[] = [
  { kind: 'attack', key: 'Z' }, { kind: 'defend', key: 'X' }, { kind: 'fortify', key: 'C' },
  { kind: 'fallBack', key: 'V' }, { kind: 'auto', key: 'B' },
];
/** Order glyphs: chevron, shield line, crenel, return arrow, compass. */
const GLYPH: Record<OrderKind, string> = { attack: '➤', defend: '┳', fortify: '♜', fallBack: '↶', auto: '✥' };
/** Game seconds the opening briefing stays up (unless dismissed or an order is given). */
const BRIEFING_S = 150;

/**
 * Left column (2.0): the player is the supreme HQ. A stamped orders card (palette Z/X/C/V/B and
 * the order's target front), one dossier card per front (name, standing order stamp, commander
 * HP / status, troops, the commander's reason and plan; ★ = main effort), the opening briefing and
 * the event log. Orders are placed on the map by the input controller (click = point, drag = line).
 * Rebuilt only when the content signature changes (HUD refresh is 5 Hz).
 */
export class FrontsPanel {
  readonly el: HTMLElement;
  private readonly command: HTMLElement;
  private readonly cards: HTMLElement;
  /** Opening briefing slip (mounted by the HUD, bottom centre). */
  readonly briefing: HTMLElement;
  private readonly log: HTMLElement;
  private expanded: number | null = null;
  /** Front the order under the cursor would go to (nearest-front preview), for highlighting. */
  previewTarget: number | null = null;
  private lastLogSig = '';
  private sig = '';
  private cmdSig = '';
  private briefingDone = false;
  /** Last seen order per front (`issuedAt|kind`) to stamp / announce fresh orders. */
  private seenOrders = new Map<number, string>();
  private fresh = new Map<number, number>();

  constructor(private readonly ctx: GameContext) {
    this.command = h('section', { class: 'hq-card orders panel paper-stack' });
    this.cards = h('div', { class: 'front-cards' });
    this.briefing = h('div', { class: 'briefing panel' });
    this.log = h('div', { class: 'eventlog' });
    this.el = h('aside', { class: 'left' }, this.command, this.cards, this.log);
  }

  /** Expand / collapse a front (the expanded front is the target of the next order). */
  toggle(id: number | null): void {
    this.expanded = this.expanded === id ? null : id;
    this.sig = '';
    this.cmdSig = '';
    const m = this.ctx.mode;
    if (m.kind === 'frontOrder') this.ctx.mode = { ...m, frontId: this.expanded };
  }

  relabel(): void {
    this.sig = '';
    this.cmdSig = '';
    this.lastLogSig = '';
  }

  /** Palette / hotkey: arm an order for placement on the map (same key again disarms). */
  pickOrder(kind: OrderKind): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    if (!f || this.ctx.spectator) return;
    const m = this.ctx.mode;
    if (m.kind === 'frontOrder' && m.order === kind) {
      this.ctx.mode = { kind: 'normal' };
      return;
    }
    const target = this.expanded !== null ? frontById(f, this.expanded) : undefined;
    if (this.expanded !== null && !target) this.expanded = null;
    if (kind === 'auto' && target) {
      // Handing the front back to its commander needs no place.
      this.ctx.issue({ type: 'frontOrder', frontId: target.id, kind: 'auto', a: target.targetPos });
      this.ordered(target.id, 'auto');
      if (m.kind === 'frontOrder') this.ctx.mode = { kind: 'normal' };
      return;
    }
    this.ctx.mode = { kind: 'frontOrder', frontId: target?.id ?? null, order: kind };
  }

  /** The input controller placed an order (closes the opening briefing). */
  ordered(_frontId: number | null, _kind: OrderKind): void {
    this.briefingDone = true;
  }

  /** Mode hint while an order is armed. */
  modeHint(): string {
    const m = this.ctx.mode;
    if (m.kind !== 'frontOrder') return '';
    const w = this.ctx.match.world;
    const target = m.frontId !== null ? frontLabel(w, this.ctx.playerId, m.frontId)
      : this.previewTarget !== null ? t('order.nearestIs', { front: frontLabel(w, this.ctx.playerId, this.previewTarget) }) : t('order.nearest');
    return t(m.order === 'auto' ? 'order.pickAuto' : 'order.pick', { order: t(`order.${m.order}`), front: target });
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const hide = !f || this.ctx.spectator;
    this.command.style.display = hide ? 'none' : '';
    this.cards.style.display = hide ? 'none' : '';
    if (hide) this.briefing.style.display = 'none';
    else {
      if (this.expanded !== null && !frontById(f, this.expanded)) this.expanded = null;
      this.announce();
      this.renderCommand();
      this.renderBriefing();
      const counts = f.fronts.map((s) => frontUnits(w, f.id, s.id).length);
      const now = w.time;
      const sig = JSON.stringify([
        f.fronts.map((s) => {
          const c = w.unitAlive(s.commanderId);
          return [s.id, s.name, s.order.kind, s.order.issuedAt, s.reason, s.reasonParams, s.op, s.opPhase, s.posture,
            c ? Math.round((c.hp / c.def.maxHp) * 20) : -1, c?.status, s.commanderLostAt >= 0 && !c ? Math.round(now - s.commanderLostAt) : 0,
            this.fresh.has(s.id)];
        }),
        f.mainFront, counts, this.expanded, this.previewTarget, this.modeKey(),
      ]);
      if (sig !== this.sig) {
        this.sig = sig;
        this.renderCards(counts);
      }
    }
    this.renderLog();
  }

  private modeKey(): string {
    const m = this.ctx.mode;
    return m.kind === 'frontOrder' ? `${m.order}|${m.frontId}` : m.kind;
  }

  /** Toast + stamp animation when a front receives a new manual order (the command landed). */
  private announce(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const first = this.seenOrders.size === 0;
    for (const s of f.fronts) {
      const key = `${s.order.issuedAt}|${s.order.kind}`;
      const prev = this.seenOrders.get(s.id);
      this.seenOrders.set(s.id, key);
      if (first || prev === undefined || prev === key || !s.order.manual) continue;
      this.fresh.set(s.id, performance.now());
      this.ctx.toast(t('order.issued', { front: frontLabel(w, f.id, s.id), order: t(`order.${s.order.kind}`) }));
    }
    for (const [id, at] of this.fresh) if (performance.now() - at > 1600) this.fresh.delete(id);
  }

  /** Supreme-HQ card: title, capital alert, order target and the order palette. */
  private renderCommand(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const home = f.command?.homeThreat;
    const dirs = (f.command?.directives ?? []).slice(0, 3);
    const sig = JSON.stringify([this.modeKey(), this.expanded, this.expanded !== null ? frontLabel(w, f.id, this.expanded) : '', home?.active, Math.round((home?.eta ?? 0) / 10), home?.recall.length, dirs.map((d) => [d.kind, d.obj, d.assigned])]);
    if (sig === this.cmdSig) return;
    this.cmdSig = sig;
    const m = this.ctx.mode;
    const armed = m.kind === 'frontOrder' ? m.order : null;
    this.command.innerHTML = '';
    this.command.append(h('div', { class: 'hq-head' },
      h('span', { class: 'hq-title' }, t('hq.supreme')),
      h('span', { class: 'hq-sub' }, t('order.title'))));
    if (home?.active) {
      const hq = w.hqPos(this.ctx.playerId);
      this.command.append(h('button', { class: 'hq-row k-defend alert', title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(hq.x, hq.z) },
        h('span', { class: 'hq-kind' }, t('hq.home')),
        h('span', { class: 'hq-obj' }, home.eta >= 0 ? t('hq.homeEta', { eta: Math.round(home.eta) }) : ''),
        h('span', { class: 'hq-n' }, home.recall.length > 0 ? t('hq.homeGroups', { n: home.recall.length }) : '')));
    }
    for (const d of dirs) {
      this.command.append(h('button', { class: `hq-row k-${d.kind}`, title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(d.pos.x, d.pos.z) },
        h('span', { class: 'hq-kind' }, t(`hq.${d.kind}`)),
        h('span', { class: 'hq-obj' }, localizeParams(w, { point: d.obj }).point as string),
        h('span', { class: 'hq-n' }, d.assigned > 0 ? t('front.units', { n: d.assigned }) : '')));
    }
    const target = this.expanded !== null ? frontLabel(w, f.id, this.expanded) : t('order.nearest');
    this.command.append(
      h('div', { class: 'order-target' }, h('span', { class: 'lbl' }, t('order.target')), h('b', {}, target)),
      h('div', { class: 'order-palette', role: 'toolbar', 'aria-label': t('order.title') },
        ...ORDERS.map((o) => h('button', {
          class: `obtn k-${o.kind} ${armed === o.kind ? 'armed' : ''}`,
          title: `${t(`order.${o.kind}Tip`)} (${o.key})`,
          'aria-pressed': String(armed === o.kind),
          onclick: () => this.pickOrder(o.kind),
        }, h('span', { class: 'og', 'aria-hidden': 'true' }, GLYPH[o.kind]), h('span', { class: 'on' }, t(`order.short.${o.kind}`)), h('kbd', {}, o.key)))),
      h('div', { class: 'order-how' }, armed ? t('order.howArmed') : t('order.how')),
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
    const armed = this.ctx.mode.kind === 'frontOrder';
    f.fronts.forEach((s, i) => {
      const main = s.id === f.mainFront;
      const open = this.expanded === s.id;
      const aimed = armed && (this.ctx.mode.kind === 'frontOrder' && this.ctx.mode.frontId === s.id || (this.expanded === null && this.previewTarget === s.id));
      const card = h('div', {
        class: `front-card panel k-${s.order.kind} ${open ? 'open' : ''} ${main ? 'main' : ''} ${aimed ? 'aimed' : ''} ${this.fresh.has(s.id) ? 'fresh' : ''}`,
        role: 'button', tabindex: 0,
        title: t('front.cardTip'),
        onclick: () => this.select(s),
        onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') this.select(s); },
      },
      h('div', { class: 'fc-top' },
        h('span', { class: 'fc-idx num' }, String(i + 1)),
        h('b', { class: 'fc-name' }, frontLabel(w, f.id, s.id)),
        main ? h('span', { class: 'fc-main', title: t('front.mainTip') }, '★') : null,
        h('span', { class: `order-stamp k-${s.order.kind}` }, t(`order.${s.order.kind}`))),
      this.commanderRow(s, counts[i]),
      h('div', { class: 'fc-reason' }, this.reasonText(s)));
      if (open) card.append(this.detail(s));
      this.cards.append(card);
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

  /** Expanded card: commander's plan, how long the order has stood, main effort, locate. */
  private detail(s: Front): HTMLElement {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const main = f.mainFront === s.id;
    const stop = (fn: () => void) => (e: Event): void => { e.stopPropagation(); fn(); };
    const plan = `${t(`op.${s.op}`)}${s.opPhase ? ` · ${t(`phase.${s.opPhase}`)}` : ''} · ${t(`posture.${s.posture}`)}`;
    const since = s.order.kind === 'auto' ? '' : t('front.orderSince', { t: fmtTime(Math.max(0, w.time - s.order.issuedAt)), who: s.order.manual ? t('front.byYou') : t('front.byHq') });
    return h('div', { class: 'fc-detail' },
      h('div', { class: 'kv' }, h('span', {}, t('front.plan')), h('b', { title: t(`op.${s.op}Tip`) }, plan)),
      since ? h('div', { class: 'kv' }, h('span', {}, t('front.order')), h('b', {}, since)) : null,
      h('div', { class: 'row' },
        h('button', { class: `btn ${main ? 'on' : ''}`, disabled: main, title: t('front.mainTip'), onclick: stop(() => this.ctx.issue({ type: 'setMainFront', frontId: s.id })) }, `★ ${t('front.main')}`),
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
