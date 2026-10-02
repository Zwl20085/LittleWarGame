import * as THREE from 'three';
import type { V2 } from '../sim/vec';
import type { GameContext } from './context';
import { h } from './dom';
import { lang, t } from './i18n';

const REST_MS = 380;

export interface TerrainInfo {
  readonly height: number;
  readonly slopeDeg: number;
  readonly ground: number;
  readonly cover: number;
  readonly feature?: { readonly kind: string; readonly name: string; readonly dist: number };
}

type InfoSource = { terrainInfoAt?: (p: V2) => Partial<TerrainInfo> | null };

/**
 * Ground-conditions readout: when the pointer rests on the battlefield a small paper tag
 * shows ground type, height, slope, cover and the nearest named feature.
 */
export class TerrainTip {
  readonly el: HTMLElement;
  private timer = 0;
  private readonly off: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ctx: GameContext) {
    this.el = h('div', { class: 'terrain-tip', role: 'status' });
    this.el.style.display = 'none';
    const on = <K extends keyof HTMLElementEventMap>(ev: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
      canvas.addEventListener(ev, fn as EventListener);
      this.off.push(() => canvas.removeEventListener(ev, fn as EventListener));
    };
    on('mousemove', (e) => this.arm(e));
    on('mouseleave', () => this.hide());
    on('mousedown', () => this.hide());
    on('wheel', () => this.hide());
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const f of this.off) f();
    this.el.remove();
  }

  private hide(): void {
    clearTimeout(this.timer);
    this.el.style.display = 'none';
  }

  private arm(e: MouseEvent): void {
    this.hide();
    if (e.buttons !== 0) return;
    const x = e.clientX;
    const y = e.clientY;
    this.timer = window.setTimeout(() => this.show(x, y), REST_MS);
  }

  private info(p: V2): TerrainInfo {
    const w = this.ctx.match.world;
    const ter = w.terrain;
    const src = this.ctx.renderer as unknown as InfoSource;
    const ext = typeof src.terrainInfoAt === 'function' ? src.terrainInfoAt(p) : null;
    const base: TerrainInfo = {
      height: ter.heightAt(p.x, p.z),
      slopeDeg: ter.slopeAt(p.x, p.z),
      ground: ter.groundAt(p.x, p.z) as number,
      cover: ter.coverAt(p.x, p.z),
      feature: this.nearestFeature(p),
    };
    return ext ? { ...base, ...ext, feature: base.feature } : base;
  }

  private nearestFeature(p: V2): TerrainInfo['feature'] {
    const feats = this.ctx.match.world.map.features ?? [];
    let best: TerrainInfo['feature'];
    let bestScore = Infinity;
    for (const f of feats) {
      const d = Math.hypot(f.pos.x - p.x, f.pos.z - p.z);
      const score = d - f.radius;
      if (score < bestScore && d < f.radius + 350) {
        bestScore = score;
        best = { kind: f.kind, name: f.name[lang()], dist: Math.max(0, Math.round(d - f.radius)) };
      }
    }
    return best;
  }

  private show(cx: number, cy: number): void {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const p = this.ctx.renderer.groundAt(ndc);
    if (!p || !this.ctx.match.world.terrain.inBounds(p.x, p.z)) return;
    const i = this.info(p);
    const going = i.ground === 5 ? t('terr.impassable') : i.ground === 1 ? t('terr.fast') : i.ground === 4 || i.ground === 6 || i.ground === 2 ? t('terr.slow') : '';
    this.el.innerHTML = '';
    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'tt-head' }, h('span', { class: `swatch g${i.ground}` }), h('b', {}, t(`ground.${i.ground}`)), going ? h('span', { class: `going ${i.ground === 5 ? 'bad' : ''}` }, going) : null),
      h('div', { class: 'tt-grid' },
        h('span', {}, t('terr.height')), h('b', { class: 'num' }, `${Math.round(i.height)} m`),
        h('span', {}, t('terr.slope')), h('b', { class: 'num' }, `${Math.round(i.slopeDeg)}°`),
        h('span', {}, t('terr.cover')), h('b', {}, t(`cover.${Math.max(0, Math.min(2, Math.round(i.cover)))}`))),
      i.feature ? h('div', { class: 'tt-feat' }, `${t('terr.near')} · ${i.feature.name}${lang() === 'zh' ? '（' : ' ('}${t(`feat.${i.feature.kind}`)}${lang() === 'zh' ? '）' : ')'}${i.feature.dist > 0 ? ` · ${i.feature.dist} m` : ''}`) : null,
    ];
    this.el.append(...parts.filter((x): x is HTMLElement => x !== null));
    this.el.style.display = '';
    const tw = this.el.offsetWidth;
    const th = this.el.offsetHeight;
    this.el.style.left = `${Math.min(window.innerWidth - tw - 8, cx + 16)}px`;
    this.el.style.top = `${Math.max(8, Math.min(window.innerHeight - th - 8, cy + 18))}px`;
  }
}
