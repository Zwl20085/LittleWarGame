import { frontUnits } from '../sim/fronts';
import type { OrderKind } from '../sim/types';
import type { GameContext } from './context';
import { fmtTime, h } from './dom';
import { t } from './i18n';
import { frontLabel, localizeParams } from './labels';

const ORDERS: OrderKind[] = ['attack', 'defend', 'fortify', 'fallBack', 'auto'];

/**
 * Left column (2.0 baseline; the orders UI agent replaces this): the supreme-HQ card, one tag
 * per front (name, commander, standing order, troops, the commander's current reason) and the
 * order buttons for the expanded front. Postures, battle plans and shares are no longer shown as
 * controls — they are the front commander's business.
 */
export class FrontsPanel {
  readonly el: HTMLElement;
  private readonly command: HTMLElement;
  private readonly tags: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly log: HTMLElement;
  private expanded: number | null = null;
  private lastLogSig = '';
  private sig = '';

  constructor(private readonly ctx: GameContext) {
    this.command = h('div', { class: 'hq-card panel' });
    this.tags = h('div', { class: 'sector-tags' });
    this.detail = h('div', { class: 'sector-detail panel' });
    this.log = h('div', { class: 'eventlog' });
    this.el = h('aside', { class: 'left' }, this.command, this.tags, this.detail, this.log);
  }

  toggle(id: number | null): void {
    this.expanded = this.expanded === id ? null : id;
    this.sig = '';
  }

  relabel(): void {
    this.sig = '';
    this.lastLogSig = '';
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    if (!f || this.ctx.spectator) {
      this.tags.style.display = 'none';
      this.detail.style.display = 'none';
      this.command.style.display = 'none';
    } else {
      const counts = f.fronts.map((s) => frontUnits(w, f.id, s.id).length);
      const dirs = f.command?.directives ?? [];
      const sig = JSON.stringify([f.fronts.map((s) => [s.id, s.name, s.order.kind, s.reason, s.reasonParams, s.commanderId, s.opPhase, s.mode]), f.mainFront, counts, this.expanded, dirs.map((d) => [d.kind, d.obj, d.assigned]), f.command?.homeThreat?.active, Math.round((f.command?.homeThreat?.eta ?? 0) / 10), this.ctx.mode.kind]);
      if (sig !== this.sig) {
        this.sig = sig;
        this.renderCommand();
        this.renderTags(counts);
        this.renderDetail();
      }
    }
    this.renderLog();
  }

  /** High command card: the theatre directives (defend / attack / occupy) with assigned units. */
  private renderCommand(): void {
    const w = this.ctx.match.world;
    const dirs = w.factions[this.ctx.playerId].command?.directives ?? [];
    const home = w.factions[this.ctx.playerId].command?.homeThreat;
    this.command.innerHTML = '';
    this.command.style.display = dirs.length || home?.active ? '' : 'none';
    this.command.append(h('div', { class: 'hq-title' }, t('hq.title')));
    if (home?.active) {
      const hq = w.hqPos(this.ctx.playerId);
      this.command.append(h('button', { class: 'hq-row k-defend', title: t('hq.goto'), onclick: () => this.ctx.renderer.rig.lookAt(hq.x, hq.z) },
        h('span', { class: 'hq-kind' }, t('hq.home')),
        h('span', { class: 'hq-obj' }, home.eta >= 0 ? t('hq.homeEta', { eta: Math.round(home.eta) }) : ''),
        h('span', { class: 'hq-n' }, home.recall.length > 0 ? t('hq.homeGroups', { n: home.recall.length }) : ''),
      ));
    }
    for (const d of dirs) {
      this.command.append(h('button', {
        class: `hq-row k-${d.kind}`,
        title: t('hq.goto'),
        onclick: () => this.ctx.renderer.rig.lookAt(d.pos.x, d.pos.z),
      },
      h('span', { class: 'hq-kind' }, t(`hq.${d.kind}`)),
      h('span', { class: 'hq-obj' }, localizeParams(w, { point: d.obj }).point as string),
      h('span', { class: 'hq-n' }, d.assigned > 0 ? t('front.units', { n: d.assigned }) : ''),
      ));
    }
  }

  private renderTags(counts: number[]): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    this.tags.innerHTML = '';
    f.fronts.forEach((s, i) => {
      const main = s.id === f.mainFront;
      const cmd = w.unitAlive(s.commanderId);
      const lost = !cmd && s.commanderLostAt >= 0 ? Math.max(0, Math.round(w.data.rules.command.commander_respawn_seconds - (w.time - s.commanderLostAt))) : -1;
      this.tags.append(h('button', {
        class: `sector-tag panel ${this.expanded === s.id ? 'open' : ''} ${main ? 'main' : ''}`,
        onclick: () => this.toggle(s.id),
      },
      h('div', { class: 'row' }, h('b', {}, frontLabel(w, f.id, s.id)), main ? h('span', { class: 'stamp' }, t('front.main')) : null, h('span', { class: 'share' }, `${Math.round(s.share * 100)}%`)),
      h('div', { class: 'row small' }, h('span', { class: `posture p-${s.order.kind === 'auto' ? 'cautious' : s.order.kind === 'attack' ? 'assault' : 'hold'}` }, t(`order.${s.order.kind}`)), h('span', {}, t('front.units', { n: counts[i] }))),
      h('div', { class: 'reason' }, lost >= 0 ? t('front.noCommander', { s: lost }) : t(s.reason, localizeParams(w, s.reasonParams))),
      h('div', { class: 'op-line small' }, `${t(`op.${s.op}`)}${s.opPhase ? ` · ${t(`phase.${s.opPhase}`)}` : ''}`),
      ));
    });
  }

  private renderDetail(): void {
    const id = this.expanded;
    this.detail.innerHTML = '';
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    const s = id === null ? undefined : f.fronts.find((x) => x.id === id);
    this.detail.style.display = s ? '' : 'none';
    if (!s || id === null) return;
    const picking = this.ctx.mode.kind === 'frontOrder' && this.ctx.mode.frontId === id ? this.ctx.mode.order : null;
    const obtns = ORDERS.map((o) => h('button', {
      class: `btn ${s.order.kind === o && !picking ? 'on' : ''} ${picking === o ? 'on' : ''}`,
      title: t(`order.${o}Tip`),
      onclick: () => {
        if (o === 'auto') this.ctx.issue({ type: 'frontOrder', frontId: id, kind: 'auto', a: s.targetPos });
        else this.ctx.mode = { kind: 'frontOrder', frontId: id, order: o };
      },
    }, t(`order.${o}`)));
    const cmd = w.unitAlive(s.commanderId);
    this.detail.append(
      h('div', { class: 'title' }, frontLabel(w, f.id, s.id)),
      h('div', { class: 'row small' }, h('span', { class: 'lbl' }, t('front.commander')), h('span', {}, cmd ? `${Math.round(cmd.hp)} HP · ${t(cmd.status || 'status.commanderPost')}` : '—')),
      h('div', { class: 'lbl' }, t('order.title')),
      h('div', { class: 'btn-grid' }, ...obtns),
      h('div', { class: 'row' },
        h('button', { class: `btn ${f.mainFront === id ? 'on' : ''}`, onclick: () => this.ctx.issue({ type: 'setMainFront', frontId: id }) }, `★ ${t('front.main')}`),
        h('button', { class: 'btn', onclick: () => this.ctx.renderer.rig.lookAt(s.front.x, s.front.z) }, t('hq.goto'))),
    );
  }

  private renderLog(): void {
    const w = this.ctx.match.world;
    const last = w.log[w.log.length - 1];
    const sig = last ? `${w.log.length}|${last.tick}|${last.key}` : '';
    if (sig === this.lastLogSig) return;
    this.lastLogSig = sig;
    const pid = this.ctx.playerId;
    const mine = w.log.filter((l) => (this.ctx.spectator ? l.severity !== 'info' || l.key === 'log.pointTaken' : l.faction === pid) && !l.key.startsWith('log.protect')).slice(-7);
    this.log.innerHTML = '';
    for (const l of mine.reverse()) {
      this.log.append(h('div', { class: `ev ${l.severity}` }, h('span', { class: 'ts' }, fmtTime(l.tick / w.tickHz)), ' ', t(l.key, localizeParams(w, l.params))));
    }
  }
}
