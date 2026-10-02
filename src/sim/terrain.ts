import type { MapDef, TownDef } from './mapdef';
import { ValueNoise } from './noise';
import { Rng } from './rng';
import { clamp, type V2 } from './vec';

export const enum Ground {
  Open = 0,
  Road = 1,
  Forest = 2,
  Town = 3,
  Mud = 4,
  /** Deep river water: impassable, no cover, does not block LOS. */
  Water = 5,
  /** Shallow ford: passable, slow (as mud). */
  Ford = 6,
}

export type BuildingKind = 'house' | 'barn' | 'block' | 'tower' | 'church' | 'factory';

export interface Building {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly rot: number;
  /** Visual archetype (houses have gable roofs; blocks/towers flat roofs; church has a steeple). */
  readonly kind: BuildingKind;
}

export interface Bridge {
  /** 'pontoon' = built during the match by engineers. */
  readonly kind?: 'fixed' | 'pontoon';
  readonly x: number;
  readonly z: number;
  /** Road direction across the river (radians, sim heading). */
  readonly angle: number;
  readonly length: number;
  readonly deckY: number;
}

export interface Tree {
  readonly x: number;
  readonly z: number;
  readonly s: number;
}

/** Heightfield + ground-type grid. All LOS / slope queries use this single source. */
export class Terrain {
  readonly cell = 4;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  readonly ground: Uint8Array;
  readonly buildings: Building[] = [];
  readonly trees: Tree[] = [];
  readonly bridges: Bridge[] = [];
  /** Water surface height per cell (NaN = no water). Rendering only; sim uses `ground`. */
  readonly waterSurface: Float32Array;
  /**
   * Heights for drawing only: identical to `heights` except the river channel continues under
   * bridges (the sim keeps the causeway at deck height so units cross on the bridge).
   */
  visualHeights: Float32Array = new Float32Array(0);
  maxHeight = 0;
  /**
   * Building occupancy raster (user request: buildings have collision and stop shells).
   * 2 m cells holding the roof height in metres (0 = open). Enclosed courtyards count as
   * low walls so nothing can get trapped inside a block.
   */
  readonly bcell = 2;
  bnx = 0;
  bnz = 0;
  bldH: Uint8Array = new Uint8Array(0);

  constructor(readonly def: MapDef) {
    this.nx = Math.floor(def.width / this.cell) + 1;
    this.nz = Math.floor(def.depth / this.cell) + 1;
    this.heights = new Float32Array(this.nx * this.nz);
    this.ground = new Uint8Array(this.nx * this.nz);
    this.waterSurface = new Float32Array(this.nx * this.nz).fill(NaN);
    this.buildHeights();
    this.paintGround();
    this.carveRivers();
    this.scatterProps();
    this.rasterizeBuildings();
  }

  private rasterizeBuildings(): void {
    const c = this.bcell;
    this.bnx = Math.ceil(this.def.width / c) + 1;
    this.bnz = Math.ceil(this.def.depth / c) + 1;
    const H = (this.bldH = new Uint8Array(this.bnx * this.bnz));
    for (const b of this.buildings) {
      // Three.js Y rotation (as drawn): local (lx, lz) = (dx cos − dz sin, dx sin + dz cos).
      const cs = Math.cos(b.rot);
      const sn = Math.sin(b.rot);
      const hw = b.w / 2;
      const hd = b.d / 2;
      const r = Math.hypot(hw, hd);
      const h = Math.min(255, Math.ceil(b.h));
      const i0 = Math.max(0, Math.floor((b.x - r) / c));
      const i1 = Math.min(this.bnx - 1, Math.ceil((b.x + r) / c));
      const j0 = Math.max(0, Math.floor((b.z - r) / c));
      const j1 = Math.min(this.bnz - 1, Math.ceil((b.z + r) / c));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i * c - b.x;
          const dz = j * c - b.z;
          if (Math.abs(dx * cs - dz * sn) <= hw && Math.abs(dx * sn + dz * cs) <= hd) {
            const k = j * this.bnx + i;
            if (H[k] < h) H[k] = h;
          }
        }
      }
    }
    this.sealCourtyards();
  }

  /**
   * Flood open ground from the map border and from objective / city squares; open cells it
   * cannot reach (closed courtyards) become 3 m walls.
   */
  private sealCourtyards(): void {
    const H = this.bldH;
    const nx = this.bnx;
    const nz = this.bnz;
    const seen = new Uint8Array(nx * nz);
    const queue = new Int32Array(nx * nz);
    let head = 0;
    let tail = 0;
    const push = (k: number): void => {
      if (seen[k] || H[k] > 0) return;
      seen[k] = 1;
      queue[tail++] = k;
    };
    for (let i = 0; i < nx; i++) {
      push(i);
      push((nz - 1) * nx + i);
    }
    for (let j = 0; j < nz; j++) {
      push(j * nx);
      push(j * nx + nx - 1);
    }
    // Squares around objectives and city points stay open even inside a closed ring of houses.
    const seeds: V2[] = [...this.def.objectives.map((o) => o.pos), ...this.def.cities.flatMap((c) => [c.hq, c.exit, c.truck])];
    const R = 6;
    for (const p of seeds) {
      const ci = Math.round(p.x / this.bcell);
      const cj = Math.round(p.z / this.bcell);
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i >= 0 && j >= 0 && i < nx && j < nz) push(j * nx + i);
        }
      }
    }
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      if (i > 0) push(k - 1);
      if (i < nx - 1) push(k + 1);
      if (k >= nx) push(k - nx);
      if (k < (nz - 1) * nx) push(k + nx);
    }
    for (let k = 0; k < H.length; k++) if (!seen[k] && H[k] === 0) H[k] = 3;
  }

  /** Roof height of the building occupying (x, z), 0 if open ground. */
  buildingH(x: number, z: number): number {
    const i = Math.round(x / this.bcell);
    const j = Math.round(z / this.bcell);
    if (!(i >= 0 && j >= 0 && i < this.bnx && j < this.bnz)) return 0; // also rejects NaN
    return this.bldH[j * this.bnx + i];
  }

  /** Building cells within radius `r` of (x, z) — 8 m nav cells use this for their cost. */
  buildingCover(x: number, z: number, r: number): number {
    const c = this.bcell;
    const i0 = Math.max(0, Math.round((x - r) / c));
    const i1 = Math.min(this.bnx - 1, Math.round((x + r) / c));
    const j0 = Math.max(0, Math.round((z - r) / c));
    const j1 = Math.min(this.bnz - 1, Math.round((z + r) / c));
    let n = 0;
    let b = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        n++;
        if (this.bldH[j * this.bnx + i] > 0) b++;
      }
    }
    return n > 0 ? b / n : 0;
  }

  /**
   * Local detour around buildings: breadth-first search on the 2 m raster inside a square
   * window around `from`, returning waypoints to the reachable cell closest to `to`.
   * Called only when a unit is actually blocked by a building (rare, ≈2 000 cells).
   */
  detour(from: V2, to: V2, radius = 40, walk: Walk = ALWAYS): V2[] | null {
    const c = this.bcell;
    const R = Math.ceil(radius / c);
    const W = 2 * R + 1;
    const ci = Math.round(from.x / c);
    const cj = Math.round(from.z / c);
    const prev = (Terrain.detourPrev.length >= W * W ? Terrain.detourPrev : (Terrain.detourPrev = new Int32Array(W * W)));
    prev.fill(-2, 0, W * W);
    const queue = Terrain.detourQueue.length >= W * W ? Terrain.detourQueue : (Terrain.detourQueue = new Int32Array(W * W));
    const free = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < this.bnx && j < this.bnz && this.bldH[j * this.bnx + i] === 0 && walk(i * c, j * c);
    // Keep one cell of clearance from walls (relaxed right next to the start).
    const open = (li: number, lj: number): boolean => {
      const i = ci + li - R;
      const j = cj + lj - R;
      if (!free(i, j)) return false;
      if (Math.abs(li - R) <= 1 && Math.abs(lj - R) <= 1) return true;
      return free(i + 1, j) && free(i - 1, j) && free(i, j + 1) && free(i, j - 1);
    };
    const start = R * W + R;
    prev[start] = -1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    let best = start;
    let bestD = Infinity;
    const tx = to.x / c - ci + R;
    const tz = to.z / c - cj + R;
    while (head < tail) {
      const k = queue[head++];
      const li = k % W;
      const lj = (k - li) / W;
      const d = (li - tx) * (li - tx) + (lj - tz) * (lj - tz);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
      for (let n = 0; n < 8; n++) {
        const ni = li + DI[n];
        const nj = lj + DJ[n];
        if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
        const nk = nj * W + ni;
        if (prev[nk] !== -2 || !open(ni, nj)) continue;
        // No corner cutting through a wall.
        if (n >= 4 && (!open(li + DI[n], lj) || !open(li, lj + DJ[n]))) continue;
        prev[nk] = k;
        queue[tail++] = nk;
      }
    }
    if (best === start) return null;
    const cells: number[] = [];
    for (let k = best; k !== -1 && k !== start; k = prev[k]) cells.push(k);
    cells.reverse();
    // String-pull: keep only corner points whose straight legs stay clear of every wall.
    const at = (k: number): V2 => ({ x: (ci + (k % W) - R) * c, z: (cj + Math.floor(k / W) - R) * c });
    const pts: V2[] = [];
    let anchor: V2 = from;
    let s = 0;
    while (s < cells.length) {
      let far = s;
      for (let m = cells.length - 1; m > s; m--) {
        if (this.wallFree(anchor, at(cells[m]), walk)) {
          far = m;
          break;
        }
      }
      anchor = at(cells[far]);
      pts.push(anchor);
      s = far + 1;
    }
    return pts;
  }

  /** Straight segment clear of buildings (0.8 m samples on the 2 m raster). */
  wallFree(a: V2, b: V2, walk: Walk = ALWAYS): boolean {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.8);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (this.buildingH(x, z) > 0 || !walk(x, z)) return false;
    }
    return true;
  }

  private static detourPrev = new Int32Array(0);
  private static detourQueue = new Int32Array(0);

  /** Nearest point not inside a building (spiral on the 2 m raster), or `p` itself. */
  freeNear(p: V2, maxR = 40): V2 {
    if (this.buildingH(p.x, p.z) === 0) return p;
    const c = this.bcell;
    const ci = Math.round(p.x / c);
    const cj = Math.round(p.z / c);
    const R = Math.ceil(maxR / c);
    for (let rr = 1; rr <= R; rr++) {
      let best = -1;
      let bd = Infinity;
      for (let dj = -rr; dj <= rr; dj++) {
        for (let di = -rr; di <= rr; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.bnx || j >= this.bnz || this.bldH[j * this.bnx + i] > 0) continue;
          const d = di * di + dj * dj;
          if (d < bd) {
            bd = d;
            best = j * this.bnx + i;
          }
        }
      }
      if (best >= 0) return { x: (best % this.bnx) * c, z: Math.floor(best / this.bnx) * c };
    }
    return p;
  }

  get width(): number {
    return this.def.width;
  }
  get depth(): number {
    return this.def.depth;
  }

  private rawHeight(x: number, z: number, noise: ValueNoise): number {
    const d = this.def;
    let h = d.baseHeight + d.noiseAmp * (noise.fbm(x / 140, z / 140, 3) - 0.5) * 2;
    for (const hill of d.hills) {
      const r2 = ((x - hill.x) ** 2 + (z - hill.z) ** 2) / (hill.r * hill.r);
      let hh = hill.h * Math.exp(-r2 * 2.2);
      if (hill.plateau !== undefined) hh = Math.min(hh, hill.plateau + (hh - hill.plateau) * 0.08);
      h += hh;
    }
    for (const rd of d.ridges) {
      const t = segT(x, z, rd.a, rd.b);
      const px = rd.a.x + (rd.b.x - rd.a.x) * t;
      const pz = rd.a.z + (rd.b.z - rd.a.z) * t;
      const dd = Math.hypot(x - px, z - pz);
      const endFade = Math.min(1, Math.min(t, 1 - t) * 6 + 0.25);
      h += rd.h * Math.exp(-((dd / rd.width) ** 2) * 1.6) * endFade;
    }
    return Math.max(0, h);
  }

  private buildHeights(): void {
    const noise = new ValueNoise(this.def.seed);
    const hf = this.def.heightfield;
    if (hf && hf.length === this.heights.length) this.heights.set(hf);
    else {
      for (let j = 0; j < this.nz; j++) {
        for (let i = 0; i < this.nx; i++) {
          this.heights[j * this.nx + i] = this.rawHeight(i * this.cell, j * this.cell, noise);
        }
      }
    }
    // Flatten around cities and along roads so traffic flows (GAME_DESIGN §5.1.1).
    for (const town of this.def.towns) this.flattenDisc(town.x, town.z, town.r, 0.85);
    for (const road of this.def.roads) {
      for (let s = 0; s < road.length - 1; s++) this.smoothSegment(road[s], road[s + 1], 10);
    }
    for (let k = 0; k < this.heights.length; k++) this.maxHeight = Math.max(this.maxHeight, this.heights[k]);
  }

  private flattenDisc(cx: number, cz: number, r: number, strength: number): void {
    const target = this.sampleRaw(cx, cz);
    this.forCells(cx, cz, r * 1.3, (idx, d) => {
      const w = strength * clamp(1.3 - d / r, 0, 1);
      this.heights[idx] = this.heights[idx] * (1 - w) + target * w;
    });
  }

  private smoothSegment(a: V2, b: V2, halfWidth: number): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(len / this.cell);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      // Cap road grade by easing the centre toward a local average.
      const avg = (this.sampleRaw(x - 12, z) + this.sampleRaw(x + 12, z) + this.sampleRaw(x, z - 12) + this.sampleRaw(x, z + 12)) / 4;
      this.forCells(x, z, halfWidth * 2, (idx, d) => {
        const w = 0.6 * clamp(1.5 - d / halfWidth, 0, 1);
        this.heights[idx] = this.heights[idx] * (1 - w) + avg * w;
      });
    }
  }

  private sampleRaw(x: number, z: number): number {
    const i = clamp(Math.round(x / this.cell), 0, this.nx - 1);
    const j = clamp(Math.round(z / this.cell), 0, this.nz - 1);
    return this.heights[j * this.nx + i];
  }

  private forCells(cx: number, cz: number, r: number, fn: (idx: number, d: number) => void): void {
    const i0 = Math.max(0, Math.floor((cx - r) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.ceil((cx + r) / this.cell));
    const j0 = Math.max(0, Math.floor((cz - r) / this.cell));
    const j1 = Math.min(this.nz - 1, Math.ceil((cz + r) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * this.cell - cx, j * this.cell - cz);
        if (d <= r) fn(j * this.nx + i, d);
      }
    }
  }

  private paintGround(): void {
    for (const m of this.def.mud) this.forCells(m.x, m.z, m.r, (idx) => (this.ground[idx] = Ground.Mud));
    for (const f of this.def.forests) this.forCells(f.x, f.z, f.r, (idx) => (this.ground[idx] = Ground.Forest));
    for (const t of this.def.towns) this.forCells(t.x, t.z, t.r, (idx) => (this.ground[idx] = Ground.Town));
    for (const road of this.def.roads) {
      for (let s = 0; s < road.length - 1; s++) {
        const a = road[s];
        const b = road[s + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.ceil(len / 2);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          this.forCells(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 8, (idx) => (this.ground[idx] = Ground.Road));
        }
      }
    }
  }

  /** 1 where a cell lies within 9 m of a road centreline (built once, for river carving). */
  private nearRoadMask: Uint8Array | null = null;

  private nearRoad(idx: number): boolean {
    if (!this.nearRoadMask) {
      const mask = (this.nearRoadMask = new Uint8Array(this.nx * this.nz));
      for (const road of this.def.roads) {
        for (let s = 0; s < road.length - 1; s++) {
          const a = road[s];
          const b = road[s + 1];
          const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2));
          for (let k = 0; k <= steps; k++) this.forCells(a.x + ((b.x - a.x) * k) / steps, a.z + ((b.z - a.z) * k) / steps, 9, (i, d) => { if (d < 9) mask[i] = 1; });
        }
      }
    }
    return this.nearRoadMask[idx] === 1;
  }

  /**
   * Carve river channels after roads are painted: deep water is impassable, fords are
   * shallow; road crossings stay as causeways and are reported as bridges.
   */
  private carveRivers(): void {
    for (const river of this.def.rivers) {
      const pts = river.points;
      const half = river.width / 2;
      const bank = 10;
      // Surface follows the (pre-carve) valley floor along the centreline, smoothed.
      const surfAt = (x: number, z: number): number => {
        let best = Infinity;
        let bh = 0;
        for (let s = 0; s < pts.length - 1; s++) {
          const t = segT(x, z, pts[s], pts[s + 1]);
          const px = pts[s].x + (pts[s + 1].x - pts[s].x) * t;
          const pz = pts[s].z + (pts[s + 1].z - pts[s].z) * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < best) {
            best = d;
            bh = this.sampleRaw(px, pz);
          }
        }
        return bh;
      };
      const touched = new Map<number, { d: number; ford: boolean; surf: number }>();
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s];
        const b = pts[s + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.ceil(len / 3);
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const cx = a.x + (b.x - a.x) * t;
          const cz = a.z + (b.z - a.z) * t;
          const ford = river.fords.some((f) => Math.hypot(f.x - cx, f.z - cz) < half + 8);
          this.forCells(cx, cz, half + bank, (idx, d) => {
            const prev = touched.get(idx);
            if (!prev || d < prev.d) touched.set(idx, { d, ford: ford || (prev?.ford ?? false), surf: 0 });
          });
        }
      }
      // Record original surface first, then carve.
      for (const [idx, info] of touched) {
        const x = (idx % this.nx) * this.cell;
        const z = Math.floor(idx / this.nx) * this.cell;
        info.surf = surfAt(x, z) - 2.5;
      }
      for (const [idx, info] of touched) {
        if (this.ground[idx] === Ground.Road) continue; // bridge causeway
        if (this.nearRoad(idx)) continue;
        const inChannel = info.d <= half;
        const depth = info.ford ? 1.2 : 4.5;
        const bed = info.surf - depth;
        if (inChannel) {
          this.heights[idx] = Math.min(this.heights[idx], bed);
          this.ground[idx] = info.ford ? Ground.Ford : Ground.Water;
          this.waterSurface[idx] = info.surf;
        } else {
          // Bank: ease down toward the water line.
          const w = 1 - (info.d - half) / bank;
          const target = info.surf + 0.3;
          if (this.heights[idx] > target) this.heights[idx] = this.heights[idx] * (1 - w * 0.85) + target * w * 0.85;
          this.waterSurface[idx] = info.surf; // water continues under the bank; terrain clips a smooth shoreline
        }
      }
      // Visual channel under the road crossing (the bridge model spans it).
      if (this.visualHeights.length === 0) this.visualHeights = this.heights.slice();
      for (const [idx, info] of touched) {
        if (this.ground[idx] !== Ground.Road || info.d > half) continue;
        this.visualHeights[idx] = Math.min(this.visualHeights[idx], info.surf - 4.5);
        this.waterSurface[idx] = info.surf;
      }
      // Bridges = road segments crossing the river centreline.
      for (const road of this.def.roads) {
        for (let r = 0; r < road.length - 1; r++) {
          for (let s = 0; s < pts.length - 1; s++) {
            const hit = segIntersect(road[r], road[r + 1], pts[s], pts[s + 1]);
            if (!hit) continue;
            const ford = river.fords.some((f) => Math.hypot(f.x - hit.x, f.z - hit.z) < half + 8);
            if (ford || this.bridges.some((b) => Math.hypot(b.x - hit.x, b.z - hit.z) < 10)) continue;
            this.bridges.push({
              x: hit.x, z: hit.z, angle: Math.atan2(road[r + 1].z - road[r].z, road[r + 1].x - road[r].x),
              length: river.width + 14, deckY: this.heightAt(hit.x, hit.z) + 0.4,
            });
          }
        }
      }
    }
    this.maxHeight = 0;
    for (let k = 0; k < this.heights.length; k++) this.maxHeight = Math.max(this.maxHeight, this.heights[k]);
    if (this.visualHeights.length === 0) this.visualHeights = this.heights;
    else {
      // Carving happened before later rivers modified `heights`: re-sync non-bridge cells.
      for (let k = 0; k < this.heights.length; k++) {
        if (!(this.ground[k] === Ground.Road && !Number.isNaN(this.waterSurface[k]))) this.visualHeights[k] = this.heights[k];
      }
    }
  }

  private scatterProps(): void {
    const rng = new Rng(this.def.seed ^ 0x5eed);
    for (const t of this.def.towns) this.layoutSettlement(t, rng);
    for (const f of this.def.forests) {
      const count = Math.round((f.r * f.r) / 70);
      for (let k = 0; k < count; k++) {
        const a = rng.next() * Math.PI * 2;
        const r = Math.sqrt(rng.next()) * f.r;
        const x = f.x + Math.cos(a) * r;
        const z = f.z + Math.sin(a) * r;
        if (this.groundAt(x, z) !== Ground.Forest) continue;
        this.trees.push({ x, z, s: rng.range(0.8, 1.35) });
      }
    }
  }

  /**
   * Villages: organic clusters of houses and barns. Towns/cities/capitals: a street grid with
   * terraced blocks along streets, a church on the square, and (cities) tall towers/factories.
   */
  private layoutSettlement(t: TownDef, rng: Rng): void {
    const kind = t.kind ?? (t.buildings > 40 ? 'town' : 'village');
    const placed: Building[] = [];
    const fits = (x: number, z: number, w: number, d: number): boolean => {
      if (!this.inBounds(x, z)) return false;
      const g = this.groundAt(x, z);
      if (g === Ground.Road || g === Ground.Water || g === Ground.Ford) return false;
      if (this.slopeAt(x, z) > 14) return false;
      const rr = Math.max(w, d) * 0.55;
      for (const b of placed) if (Math.hypot(b.x - x, b.z - z) < rr + Math.max(b.w, b.d) * 0.55) return false;
      return true;
    };
    const add = (b: Building): void => {
      placed.push(b);
      this.buildings.push(b);
    };
    if (kind === 'village') {
      for (let tries = 0; tries < t.buildings * 14 && placed.length < t.buildings; tries++) {
        const a = rng.next() * Math.PI * 2;
        const r = Math.sqrt(rng.next()) * t.r * 0.95;
        const x = t.x + Math.cos(a) * r;
        const z = t.z + Math.sin(a) * r;
        const barn = rng.chance(0.18);
        const w = barn ? rng.range(12, 18) : rng.range(6, 11);
        const d = barn ? rng.range(8, 11) : rng.range(5, 8);
        if (!fits(x, z, w, d)) continue;
        // Houses face the village centre (roughly).
        const rot = Math.atan2(t.z - z, t.x - x) + (rng.chance(0.5) ? 0 : Math.PI / 2) + rng.range(-0.2, 0.2);
        add({ x, z, w, d, h: barn ? rng.range(6, 9) : rng.range(4.5, 7.5), rot, kind: barn ? 'barn' : 'house' });
      }
      return;
    }
    // Street grid, rotated to the town's local orientation.
    const ang = rng.range(0, Math.PI / 2);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const block = kind === 'town' ? 46 : 52;
    const street = 12;
    const toWorld = (u: number, v: number): { x: number; z: number } => ({ x: t.x + u * ca - v * sa, z: t.z + u * sa + v * ca });
    const big = kind === 'city' || kind === 'capital';
    // Landmarks first: church on the square; towers near the centre of cities.
    const sq = toWorld(block / 2 + street / 2, block / 2 + street / 2);
    if (fits(sq.x, sq.z, 14, 26)) add({ x: sq.x, z: sq.z, w: 26, d: 13, h: 14, rot: ang, kind: 'church' });
    if (big) {
      const towers = kind === 'capital' ? 7 : 4;
      for (let k = 0, tries = 0; k < towers && tries < 60; tries++) {
        const a = rng.next() * Math.PI * 2;
        const r = rng.range(15, t.r * 0.45);
        const p = { x: t.x + Math.cos(a) * r, z: t.z + Math.sin(a) * r };
        const w = rng.range(12, 18);
        if (!fits(p.x, p.z, w, w)) continue;
        add({ x: p.x, z: p.z, w, d: w * rng.range(0.8, 1.2), h: rng.range(22, 38), rot: ang, kind: 'tower' });
        k++;
      }
    }
    const half = t.r;
    const cell = block + street;
    for (let gu = -half; gu <= half; gu += cell) {
      for (let gv = -half; gv <= half; gv += cell) {
        // Terraced houses around the block perimeter.
        const per = Math.max(3, Math.floor(block / 9));
        for (let side = 0; side < 4; side++) {
          for (let k = 0; k < per; k++) {
            if (placed.length >= t.buildings) return;
            const along = -block / 2 + (k + 0.5) * (block / per);
            const inset = block / 2 - 5;
            const [u, v, rotOff] = side === 0 ? [gu + along, gv - inset, 0] : side === 1 ? [gu + inset, gv + along, Math.PI / 2] : side === 2 ? [gu - along, gv + inset, Math.PI] : [gu - inset, gv - along, -Math.PI / 2];
            const dc = Math.hypot(u, v);
            // Density falls off toward the edge (suburbs), keep a round silhouette.
            if (dc > half * (0.85 + rng.next() * 0.2)) continue;
            if (rng.chance(dc / half * 0.45)) continue;
            const p = toWorld(u, v);
            const w = block / per - 0.8;
            const d = rng.range(8, 11);
            if (!fits(p.x, p.z, Math.min(w, d), Math.min(w, d))) continue;
            const core = dc < half * 0.4;
            const isFactory = !core && big && rng.chance(0.05);
            add({
              x: p.x, z: p.z, w: isFactory ? w * 2 : w, d: isFactory ? d * 1.6 : d,
              h: isFactory ? rng.range(9, 13) : core ? rng.range(big ? 11 : 8, big ? 18 : 12) : rng.range(5.5, 9),
              rot: ang + rotOff, kind: isFactory ? 'factory' : core && big ? 'block' : 'house',
            });
          }
        }
      }
    }
  }

  /**
   * Runtime bridge (engineer pontoon): water cells along a→b become road at deck height so the
   * sim can cross; the visual channel stays carved so water still shows under the deck.
   */
  addBridge(a: V2, b: V2, width: number): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / 2));
    const deck = new Map<number, number>();
    for (let k = 0; k <= steps; k++) {
      const x = a.x + ((b.x - a.x) * k) / steps;
      const z = a.z + ((b.z - a.z) * k) / steps;
      this.forCells(x, z, width / 2 + 2, (idx) => {
        const g = this.ground[idx];
        if (g !== Ground.Water && g !== Ground.Ford) return;
        const surf = Number.isNaN(this.waterSurface[idx]) ? this.heights[idx] : this.waterSurface[idx];
        deck.set(idx, surf + 0.35);
      });
    }
    if (this.visualHeights === this.heights) this.visualHeights = this.heights.slice();
    for (const [idx, y] of deck) {
      this.heights[idx] = y;
      this.ground[idx] = Ground.Road;
    }
    this.bridges.push({ kind: 'pontoon', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, angle: Math.atan2(b.z - a.z, b.x - a.x), length: len + 6, deckY: this.heightAt((a.x + b.x) / 2, (a.z + b.z) / 2) });
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x <= this.def.width && z <= this.def.depth;
  }

  heightAt(x: number, z: number): number {
    const fx = clamp(x / this.cell, 0, this.nx - 1.0001);
    const fz = clamp(z / this.cell, 0, this.nz - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    const n = this.nx;
    const a = h[j * n + i];
    const b = h[j * n + i + 1];
    const c = h[(j + 1) * n + i];
    const d = h[(j + 1) * n + i + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  groundAt(x: number, z: number): Ground {
    const i = clamp(Math.round(x / this.cell), 0, this.nx - 1);
    const j = clamp(Math.round(z / this.cell), 0, this.nz - 1);
    return this.ground[j * this.nx + i] as Ground;
  }

  /** Slope in degrees at (x,z), from central differences. */
  slopeAt(x: number, z: number): number {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
  }

  /** Directional slope (deg, positive = uphill) along heading. */
  gradeAlong(x: number, z: number, heading: number): number {
    const e = 3;
    const h0 = this.heightAt(x, z);
    const h1 = this.heightAt(x + Math.cos(heading) * e, z + Math.sin(heading) * e);
    return (Math.atan((h1 - h0) / e) * 180) / Math.PI;
  }

  /**
   * 3D line of sight between two points with eye heights. Blocked by terrain, by
   * more than `forestDepth` metres of canopy (≈12 m tall), by street clutter in towns and by
   * every building (the occupancy raster, with real roof heights).
   */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number, forestDepth = 45, townDepth = 40, buildings = true): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1) return true;
    const step = 4;
    const n = Math.ceil(len / step);
    let canopy = 0;
    let town = 0;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const y = ay + (by - ay) * t;
      const g = this.heightAt(x, z);
      if (y < g + 0.3) return false;
      if (buildings && y < g + this.buildingH(x, z)) return false;
      const gt = this.groundAt(x, z);
      if (gt === Ground.Forest && y < g + 12) {
        canopy += step;
        if (canopy > forestDepth) return false;
      } else if (gt === Ground.Town && y < g + 7) {
        town += step;
        if (town > townDepth) return false;
      }
    }
    return true;
  }

  /** Cover level an infantry/crew unit standing here gets from terrain (0 none, 1 light, 2 heavy). */
  coverAt(x: number, z: number): 0 | 1 | 2 {
    const g = this.groundAt(x, z);
    if (g === Ground.Town) return 2;
    if (g === Ground.Forest) return 1;
    return 0;
  }
}

/** Extra walkability test for local searches (e.g. a unit class's slope/water limits). */
export type Walk = (x: number, z: number) => boolean;
const ALWAYS: Walk = () => true;
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

function segT(x: number, z: number, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  if (l2 === 0) return 0;
  return clamp(((x - a.x) * vx + (z - a.z) * vz) / l2, 0, 1);
}

function segIntersect(a: V2, b: V2, c: V2, d: V2): V2 | null {
  const r = { x: b.x - a.x, z: b.z - a.z };
  const q = { x: d.x - c.x, z: d.z - c.z };
  const den = r.x * q.z - r.z * q.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * q.z - (c.z - a.z) * q.x) / den;
  const u = ((c.x - a.x) * r.z - (c.z - a.z) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
}
