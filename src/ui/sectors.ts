import { sectorUnits } from '../sim/sectors';
import type { Posture } from '../sim/types';
import type { GameContext } from './context';
import { fmtTime, h } from './dom';
import { t } from './i18n';
import { localizeParams } from './labels';

const POSTURES: Posture[] = ['cautious', 'assault', 'hold', 'fortify', 'withdraw'];

/** Left column: sector tags (always on) + expandable sector detail + short event strip. */
export class SectorsPanel {
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
      const counts = f.sectors.map((s) => sectorUnits(w, f.id, s.id).length);
      const dirs = f.command?.directives ?? [];
      const sig = JSON.stringify([f.sectors.map((s) => [s.posture, s.reason, s.reasonParams, s.share, s.manualTarget]), f.mainSector, counts, this.expanded, dirs.map((d) => [d.kind, d.obj, d.assigned])]);
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
    this.command.innerHTML = '';
    this.command.style.display = dirs.length ? '' : 'none';
    this.command.append(h('div', { class: 'hq-title' }, t('hq.title')));
    for (const d of dirs) {
      this.command.append(h('button', {
        class: `hq-row k-${d.kind}`,
        title: t('hq.goto'),
        onclick: () => this.ctx.renderer.rig.lookAt(d.pos.x, d.pos.z),
      },
      h('span', { class: 'hq-kind' }, t(`hq.${d.kind}`)),
      h('span', { class: 'hq-obj' }, localizeParams(w, { point: d.obj }).point as string),
      h('span', { class: 'hq-n' }, d.assigned > 0 ? t('sector.units', { n: d.assigned }) : ''),
      ));
    }
  }

  private renderTags(counts: number[]): void {
    const w = this.ctx.match.world;
    const f = w.factions[this.ctx.playerId];
    this.tags.innerHTML = '';
    for (const s of f.sectors) {
      const main = s.id === f.mainSector;
      this.tags.append(h('button', {
        class: `sector-tag panel ${this.expanded === s.id ? 'open' : ''} ${main ? 'main' : ''}`,
        onclick: () => this.toggle(s.id),
      },
      h('div', { class: 'row' }, h('b', {}, t(`sector.${s.key}`)), main ? h('span', { class: 'stamp' }, t('sector.main')) : null, h('span', { class: 'share' }, `${Math.round(s.share * 100)}%`)),
      h('div', { class: 'row small' }, h('span', { class: `posture p-${s.posture}` }, t(`posture.${s.posture}`)), h('span', {}, t('sector.units', { n: counts[s.id] }))),
      h('div', { class: 'reason' }, t(s.reason, localizeParams(w, s.reasonParams))),
      ));
    }
  }

  private renderDetail(): void {
    const id = this.expanded;
    this.detail.innerHTML = '';
    this.detail.style.display = id === null ? 'none' : '';
    if (id === null) return;
    const f = this.ctx.match.world.factions[this.ctx.playerId];
    const s = f.sectors[id];
    const pbtns = POSTURES.map((p) => h('button', { class: `btn ${s.posture === p ? 'on' : ''}`, onclick: () => this.ctx.issue({ type: 'setPosture', sectorId: id, posture: p }) }, t(`posture.${p}`)));
    const shares = f.sectors.map((x) => x.share);
    const bump = (d: number): void => {
      const next = [...shares] as [number, number, number];
      next[id] = Math.max(0, next[id] + d);
      this.ctx.issue({ type: 'setShares', shares: next });
    };
    this.detail.append(
      h('div', { class: 'title' }, t(`sector.${s.key}`)),
      h('div', { class: 'btn-grid' }, ...pbtns),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { this.ctx.mode = { kind: 'sectorTarget', sectorId: id }; } }, t('sector.setTarget')),
        h('button', { class: 'btn', disabled: !s.manualTarget, onclick: () => this.ctx.issue({ type: 'setSectorTarget', sectorId: id, pos: null }) }, t('sector.clearTarget'))),
      h('div', { class: 'row' },
        h('span', { class: 'lbl' }, t('sector.share')),
        h('button', { class: 'btn icon', onclick: () => bump(-0.1) }, '−'),
        h('span', { class: 'num' }, `${Math.round(s.share * 100)}%`),
        h('button', { class: 'btn icon', onclick: () => bump(0.1) }, '+')),
      h('div', { class: 'row' },
        h('button', { class: `btn ${f.mainSector === id ? 'on' : ''}`, onclick: () => this.ctx.issue({ type: 'setMainSector', sectorId: id }) }, `★ ${t('sector.main')}`),
        h('button', { class: 'btn', onclick: () => this.ctx.issue({ type: 'regroupSector', sectorId: id }) }, t('sector.regroup'))),
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
