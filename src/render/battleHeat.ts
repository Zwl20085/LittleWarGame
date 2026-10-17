import type { FxEvent } from '../sim/types';

/** A place worth filming: heat-weighted centre of the hottest 3×3 block of cells. */
export interface Hotspot {
  readonly x: number;
  readonly z: number;
  readonly score: number;
}

/** Tuning of the battle-cam heat map (render only; the sim never reads it). */
export const HEAT = {
  /** Cell size (m). */
  cell: 90,
  /** Heat halves every this many real seconds. */
  halfLife: 7,
  /** A new shot avoids the previous one by this distance (m) when another fight is hot. */
  avoidRadius: 260,
  /** Below this score a spot is not a fight (stray shots, a lone ricochet). */
  minScore: 4,
  weight: {
    explosionBase: 2,
    /** Extra per metre of blast radius. */
    explosionPerM: 0.12,
    deathInfantry: 2.5,
    deathVehicle: 7,
    tracerHit: 0.6,
    tracerMiss: 0.2,
    muzzleBig: 0.6,
    muzzle: 0.08,
    ricochet: 0.15,
  },
} as const;

/** Heat added by one fx event, and where (null = ignore). */
export function fxHeat(e: FxEvent): { x: number; z: number; w: number } | null {
  const W = HEAT.weight;
  switch (e.t) {
    case 'explosion':
      return { x: e.pos.x, z: e.pos.z, w: W.explosionBase + e.radius * W.explosionPerM };
    case 'death':
      return { x: e.pos.x, z: e.pos.z, w: e.vehicle ? W.deathVehicle : W.deathInfantry };
    case 'tracer':
      return { x: e.to.x, z: e.to.z, w: e.hit ? W.tracerHit : W.tracerMiss };
    case 'muzzle':
      return { x: e.pos.x, z: e.pos.z, w: e.big ? W.muzzleBig : W.muzzle };
    case 'ricochet':
      return { x: e.pos.x, z: e.pos.z, w: W.ricochet };
    default:
      return null;
  }
}

/**
 * Decaying grid of recent combat (shots, blasts, deaths) for the battle camera. It reads the
 * render-side fx stream only, so it costs nothing in the sim and is deterministic for a given
 * event sequence (tests feed it synthetic events).
 */
export class HeatGrid {
  readonly cols: number;
  readonly rows: number;
  readonly heat: Float32Array;
  /** Heat-weighted position sums per cell (for a centre that follows the fight, not the cell). */
  private readonly sx: Float32Array;
  private readonly sz: Float32Array;

  constructor(readonly width: number, readonly depth: number, readonly cell: number = HEAT.cell) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(depth / cell));
    const n = this.cols * this.rows;
    this.heat = new Float32Array(n);
    this.sx = new Float32Array(n);
    this.sz = new Float32Array(n);
  }

  private index(x: number, z: number): number {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const j = Math.min(this.rows - 1, Math.max(0, Math.floor(z / this.cell)));
    return j * this.cols + i;
  }

  add(x: number, z: number, w: number): void {
    if (!(w > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const k = this.index(x, z);
    this.heat[k] += w;
    this.sx[k] += x * w;
    this.sz[k] += z * w;
  }

  /** `seen` (fog of war): only events at places the player can see add heat. */
  ingest(events: readonly FxEvent[], seen: ((x: number, z: number) => boolean) | null = null): void {
    for (const e of events) {
      const h = fxHeat(e);
      if (h && (!seen || seen(h.x, h.z))) this.add(h.x, h.z, h.w);
    }
  }

  /** Exponential decay over `dt` seconds. */
  decay(dt: number, halfLife: number = HEAT.halfLife): void {
    if (dt <= 0) return;
    const f = Math.pow(0.5, dt / halfLife);
    const { heat, sx, sz } = this;
    for (let k = 0; k < heat.length; k++) {
      if (heat[k] === 0) continue;
      if (heat[k] < 0.01) {
        heat[k] = 0; sx[k] = 0; sz[k] = 0;
        continue;
      }
      heat[k] *= f; sx[k] *= f; sz[k] *= f;
    }
  }

  /** Heat summed over the 3×3 block around a map point. */
  scoreAt(x: number, z: number): number {
    return this.block(this.index(x, z)).score;
  }

  private block(k: number): Hotspot {
    const i = k % this.cols;
    const j = (k - i) / this.cols;
    let s = 0;
    let x = 0;
    let z = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= this.rows) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= this.cols) continue;
        const q = jj * this.cols + ii;
        s += this.heat[q];
        x += this.sx[q];
        z += this.sz[q];
      }
    }
    return s > 0 ? { x: x / s, z: z / s, score: s } : { x: (i + 0.5) * this.cell, z: (j + 0.5) * this.cell, score: 0 };
  }

  /**
   * The hottest fight, preferring one at least `avoidRadius` from `avoid` (the current shot) so
   * consecutive cuts show different places; falls back to the hottest overall. Null when nothing
   * scores `minScore`.
   */
  hottest(avoid: { x: number; z: number } | null = null, avoidRadius: number = HEAT.avoidRadius, minScore: number = HEAT.minScore, seen: ((x: number, z: number) => boolean) | null = null): Hotspot | null {
    let best: Hotspot | null = null;
    let bestFar: Hotspot | null = null;
    const r2 = avoidRadius * avoidRadius;
    for (let k = 0; k < this.heat.length; k++) {
      if (this.heat[k] === 0) continue;
      const b = this.block(k);
      if (b.score < minScore || (seen && !seen(b.x, b.z))) continue;
      if (!best || b.score > best.score) best = b;
      const far = !avoid || (b.x - avoid.x) ** 2 + (b.z - avoid.z) ** 2 > r2;
      if (far && (!bestFar || b.score > bestFar.score)) bestFar = b;
    }
    return bestFar ?? best;
  }

  clear(): void {
    this.heat.fill(0);
    this.sx.fill(0);
    this.sz.fill(0);
  }
}

/**
 * Fog of war for the battle cam: the cells (and their neighbours, ~1–2 cells) around the
 * player's own units and the enemy units the player currently sees. A fight elsewhere is never
 * filmed, so the camera cannot reveal hidden enemies. Rebuilt a few times a second.
 */
export class SeenMask {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Uint8Array;

  constructor(width: number, depth: number, readonly cell: number = HEAT.cell) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(depth / cell));
    this.cells = new Uint8Array(this.cols * this.rows);
  }

  private ij(v: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.floor(v / this.cell)));
  }

  /** Rebuild from the positions the player can see (own units and visible enemies). */
  rebuild(points: Iterable<{ readonly x: number; readonly z: number }>): void {
    this.cells.fill(0);
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const i = this.ij(p.x, this.cols);
      const j = this.ij(p.z, this.rows);
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= this.rows) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii >= 0 && ii < this.cols) this.cells[jj * this.cols + ii] = 1;
        }
      }
    }
  }

  readonly has = (x: number, z: number): boolean => this.cells[this.ij(z, this.rows) * this.cols + this.ij(x, this.cols)] === 1;
}
