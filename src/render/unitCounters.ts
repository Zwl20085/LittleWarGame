import type { Unit } from '../sim/types';
import type { World } from '../sim/world';
import { unitIconSlot, type AtlasSlot } from './icons';
import type { ScreenOverlay } from './screenOverlay';
import type { UnitViews } from './unitViews';

/** Zoom bands in CSS pixels per metre. */
export const LOD = { far: 0.9, close: 3.0 } as const;

/** Priority when one counter stands for an aggregated cell (heavier kit wins). */
const TYPE_RANK: Record<string, number> = {
  heavy_tank: 9, medium_tank: 8, light_tank: 7, howitzer: 6, at_gun: 5, aa: 4, mortar: 4, mg: 3, infantry: 2, engineer: 2, recon: 1, supply_truck: 0,
};

interface Cell {
  owner: number;
  n: number;
  sx: number;
  sy: number;
  type: string;
  rank: number;
  hp: number;
  maxHp: number;
  selected: boolean;
}

const P = { x: 0, y: 0 };

/**
 * NATO counters + HP bars drawn on the 2D overlay with zoom LOD:
 * far — aggregated per screen cell with a count; medium — individual, decluttered;
 * close — models only, counters just for selected / hovered units.
 */
export class UnitCounters {
  private dpr = 1;
  private readonly slots = new Map<string, Map<string, AtlasSlot>>();
  private occ = new Uint8Array(1);
  private occW = 1;
  private occH = 1;
  private cellW = 1;
  private cellH = 1;

  /** One counter per screen cell: cheap declutter for thousands of counters. */
  private place(x: number, y: number): boolean {
    const i = Math.floor(x / this.cellW);
    const j = Math.floor(y / this.cellH);
    if (i < 0 || j < 0 || i >= this.occW || j >= this.occH) return true;
    const k = j * this.occW + i;
    if (this.occ[k]) return false;
    this.occ[k] = 1;
    return true;
  }
  private readonly cells = new Map<number, Cell>();

  constructor(private readonly world: World, private readonly views: UnitViews) {}

  draw(o: ScreenOverlay, ppm: number, playerId: number, fog: boolean): void {
    const g = o.ctx;
    const w = this.world;
    const sel = this.views.selected;
    const hov = this.views.hovered;
    const band = ppm < LOD.far ? 'far' : ppm < LOD.close ? 'medium' : 'close';
    const scale = this.views.markerScale;
    const cw = (band === 'far' ? 26 : 22) * scale;
    const ch = cw * (2 / 3);
    this.dpr = o.dpr;
    this.cellW = cw * 1.2;
    this.cellH = ch * 1.35;
    this.occW = Math.ceil(o.w / this.cellW) + 1;
    this.occH = Math.ceil(o.h / this.cellH) + 1;
    if (this.occ.length < this.occW * this.occH) this.occ = new Uint8Array(this.occW * this.occH);
    else this.occ.fill(0, 0, this.occW * this.occH);
    this.cells.clear();
    const priority: [Unit, number, number][] = [];
    for (const u of w.units.values()) {
      if (u.hp <= 0) continue;
      const v = this.views.views.get(u.id);
      if (!v || !v.visible || !v.onScreen) continue;
      if (!o.project(v.x, v.y + v.spec.top, v.z, P) || !o.onScreen(P)) continue;
      const isSel = sel.has(u.id) || hov === u.id;
      if (isSel) {
        priority.push([u, P.x, P.y]);
        continue;
      }
      if (band === 'close') continue;
      if (band === 'far') {
        const cell = 34 * scale;
        const key = (Math.floor(P.y / cell) * 4096 + Math.floor(P.x / cell)) * 16 + u.owner;
        const rank = TYPE_RANK[u.fixed ? 'mg' : u.def.id] ?? 2;
        const c = this.cells.get(key);
        const maxHp = u.fixed ? 1400 : u.def.maxHp;
        if (!c) this.cells.set(key, { owner: u.owner, n: 1, sx: P.x, sy: P.y, type: u.fixed ? 'bunker' : u.def.id, rank, hp: u.hp, maxHp, selected: false });
        else {
          c.n++;
          c.sx += P.x;
          c.sy += P.y;
          c.hp += u.hp;
          c.maxHp += maxHp;
          if (rank > c.rank) {
            c.rank = rank;
            c.type = u.def.id;
          }
        }
        continue;
      }
      // Medium: individual counters, first come first placed (stable by id order).
      if (!this.place(P.x, P.y - ch / 2)) continue;
      this.counter(g, u, P.x, P.y, cw, ch, false);
    }
    if (band === 'far') {
      for (const c of this.cells.values()) {
        const x = c.sx / c.n;
        const y = c.sy / c.n;
        if (!this.place(x, y - ch / 2)) continue;
        const f = w.factions[c.owner];
        this.icon(g, c.type, f.color, f.roman, x - cw / 2, y - ch, cw, ch, false);
        if (c.n > 1) this.badge(g, String(c.n), x + cw / 2, y - ch);
        if (c.hp < c.maxHp * 0.98) this.bar(g, x - cw / 2, y + 1, cw, c.hp / c.maxHp);
      }
    }
    // Selected / hovered last, always on top.
    const big = 30 * scale;
    for (const [u, x, y] of priority) this.counter(g, u, x, y, big, big * (2 / 3), true);
    this.drawGhosts(o, cw, ch, playerId, fog);
  }

  private counter(g: CanvasRenderingContext2D, u: Unit, x: number, y: number, cw: number, ch: number, highlight: boolean): void {
    const f = this.world.factions[u.owner];
    g.globalAlpha = u.routing ? 0.55 : 1;
    this.icon(g, u.fixed ? 'bunker' : u.def.id, f.color, f.roman, x - cw / 2, y - ch, cw, ch, false);
    if (highlight) {
      g.strokeStyle = '#f4ecd9';
      g.lineWidth = 1.5;
      g.strokeRect(x - cw / 2 + 1.5, y - ch + 2.5, cw - 3, ch - 4);
    }
    g.globalAlpha = 1;
    const maxHp = u.fixed ? 1400 : u.def.maxHp;
    if (highlight || u.hp < maxHp) this.bar(g, x - cw / 2 + 2, y + 1, cw - 4, u.hp / maxHp);
  }

  /** Blit a pre-scaled icon at device-pixel resolution (snapped to whole pixels). */
  private icon(g: CanvasRenderingContext2D, type: string, color: string, roman: string, x: number, y: number, w: number, h: number, ghost: boolean): void {
    const dpr = this.dpr;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    // Small per-size cache avoids building string keys for every counter.
    let byType = this.slots.get(color);
    if (!byType) this.slots.set(color, (byType = new Map()));
    const sk = `${type}${ghost ? '~' : ''}`;
    let s = byType.get(sk);
    if (!s || s.w !== pw || s.h !== ph) {
      s = unitIconSlot(type, color, roman, pw, ph, ghost);
      byType.set(sk, s);
    }
    g.drawImage(s.canvas, s.sx, s.sy, s.w, s.h, Math.round(x * dpr) / dpr, Math.round(y * dpr) / dpr, s.w / dpr, s.h / dpr);
  }

  private bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    g.fillStyle = '#1f231e';
    g.fillRect(x - 1, y - 1, w + 2, 4);
    g.fillStyle = r > 0.6 ? '#7fa05a' : r > 0.3 ? '#c8a040' : '#a63f36';
    g.fillRect(x, y, w * r, 2);
  }

  private badge(g: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    g.font = '600 10px "Oswald", "Microsoft YaHei", sans-serif';
    const tw = g.measureText(text).width + 6;
    g.fillStyle = '#272c27';
    g.fillRect(x - tw + 3, y - 5, tw, 12);
    g.fillStyle = '#f4ecd9';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x - tw / 2 + 3, y + 1);
  }

  private drawGhosts(o: ScreenOverlay, cw: number, ch: number, playerId: number, fog: boolean): void {
    const w = this.world;
    const seen = w.lastSeen[playerId];
    if (!fog || !seen) return;
    for (const [id, s] of seen) {
      if (w.visibleTo[playerId].has(id)) continue;
      const u = w.units.get(id);
      if (!u) continue;
      if (!o.project(s.pos.x, w.terrain.heightAt(s.pos.x, s.pos.z) + 7, s.pos.z, P) || !o.onScreen(P)) continue;
      if (!this.place(P.x, P.y - ch / 2)) continue;
      const f = w.factions[u.owner];
      o.ctx.globalAlpha = 0.8;
      this.icon(o.ctx, u.def.id, f.color, f.roman, P.x - cw / 2, P.y - ch, cw, ch, true);
      o.ctx.globalAlpha = 1;
    }
  }
}
