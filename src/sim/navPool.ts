import { EdgeTable, FlowField, type FieldHost } from './flowfield';
import { Ground, type Terrain } from './terrain';

/** Nav cell size (m); every movement class uses the same lattice. */
export const NAV_CELL = 8;

/**
 * Flow-field cache budget shared by every movement class of one terrain (WP-M2), in bytes of field
 * storage. Least recently used fields are evicted across classes. A cold field keeps only the
 * chunks its search touched (flowfield.ts), 0.1-0.5 MB on a large map; HOT_FIELDS fields stay
 * dense while they expand.
 */
const FIELD_BUDGET_BYTES = 192 * 1024 * 1024;
let fieldBudgetBytes = FIELD_BUDGET_BYTES;
/** Dense (expanding) fields kept per terrain; the least recently used one is cooled for another. */
const HOT_FIELDS = 16;

/** Test hook: set the shared flow-field budget (bytes); returns the previous one. */
export function setFieldBudgetBytes(bytes: number): number {
  const prev = fieldBudgetBytes;
  fieldBudgetBytes = bytes;
  return prev;
}

/** Minimal interface of a grid participating in the shared `FieldPool`. */
export interface PooledGrid {
  oldestField(except: FlowField): { k: number; used: number } | null;
  evictField(k: number): FlowField | undefined;
}

/** Shared flow-field cache of one terrain's nav grids. */
export class FieldPool implements FieldHost {
  bytes = 0;
  clock = 0;
  readonly grids: PooledGrid[] = [];
  /** Hot fields (dense form). */
  private readonly hot: FlowField[] = [];
  /** Dense buffers and chunk tables of evicted / cooled fields, for reuse (counted in `bytes`). */
  private spareDense: Int32Array | null = null;
  private spareChunks: Uint16Array | null = null;
  /** Times a cold field had to be made dense again (diagnostics). */
  static warms = 0;

  /** A new (hot) field of `n` cells toward `goal`. */
  create(edges: EdgeTable, n: number, goal: number): FlowField {
    const dense = this.takeDense(null);
    const chunkOf = this.spareChunks ?? undefined;
    if (chunkOf) {
      this.bytes -= chunkOf.byteLength;
      this.spareChunks = null;
    }
    const f = new FlowField(edges, n, goal, { dense: dense ?? undefined, chunkOf, host: this });
    this.hot.push(f);
    this.bytes += f.bytes;
    return f;
  }

  heat(f: FlowField): void {
    FieldPool.warms++;
    const before = f.bytes;
    f.warm(this.takeDense(f) ?? new Int32Array(f.n));
    this.hot.push(f);
    this.bytes += f.bytes - before;
    this.trim(f);
  }

  /** A dense buffer: the spare one, or one freed by cooling the oldest hot field when HOT_FIELDS are hot. */
  private takeDense(keep: FlowField | null): Int32Array | null {
    let buf: Int32Array | null = null;
    if (this.hot.length >= HOT_FIELDS || (this.hot.length >= 2 && this.bytes >= fieldBudgetBytes)) {
      let oldest = -1;
      for (let i = 0; i < this.hot.length; i++) if (this.hot[i] !== keep && (oldest < 0 || this.hot[i].used < this.hot[oldest].used)) oldest = i;
      if (oldest >= 0) {
        const f = this.hot[oldest];
        this.hot.splice(oldest, 1);
        const before = f.bytes;
        buf = f.cool();
        this.bytes += f.bytes - before + buf.byteLength;
        this.spareDense ??= buf;
        if (this.spareDense !== buf) this.bytes -= buf.byteLength;
      }
    }
    const d = this.spareDense;
    if (d) {
      this.bytes -= d.byteLength;
      this.spareDense = null;
    }
    return d;
  }

  /** A field left the cache (evicted or dropped): keep its buffers for reuse. */
  dropped(f: FlowField): void {
    this.bytes -= f.bytes;
    const i = this.hot.indexOf(f);
    if (i >= 0) {
      this.hot.splice(i, 1);
      if (!this.spareDense && f.dense) {
        this.spareDense = f.dense;
        this.bytes += f.dense.byteLength;
      }
    }
    if (!this.spareChunks) {
      this.spareChunks = f.chunkOf;
      this.bytes += f.chunkOf.byteLength;
    }
  }

  /** Evict least recently used fields (any movement class) until the budget holds. */
  trim(keep: FlowField): void {
    while (this.bytes > fieldBudgetBytes) {
      let grid: PooledGrid | null = null;
      let k = -1;
      let used = Infinity;
      for (const g of this.grids) {
        const o = g.oldestField(keep);
        if (o && o.used < used) { used = o.used; k = o.k; grid = g; }
      }
      if (!grid) return;
      grid.evictField(k);
    }
  }
}

const fieldPools = new WeakMap<Terrain, FieldPool>();

export function fieldPool(terrain: Terrain): FieldPool {
  let p = fieldPools.get(terrain);
  if (!p) {
    p = new FieldPool();
    fieldPools.set(terrain, p);
  }
  return p;
}

/** Binary min-heap keyed by f-score (reused across A* searches via `clear()`). */
export class Heap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  clear(): void {
    this.ids.length = 0;
    this.keys.length = 0;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/**
 * A* scratch arrays (cost so far, parent, generation stamps, binary heap). One set per terrain,
 * shared by every movement class (WP-M2): a search runs to completion before the next starts.
 */
export interface SearchScratch {
  readonly g: Float32Array;
  readonly from: Int32Array;
  readonly stamp: Uint32Array;
  readonly closedAt: Uint32Array;
  readonly heap: Heap;
  gen: number;
}

const searchScratches = new WeakMap<Terrain, SearchScratch>();

export function searchScratch(terrain: Terrain, n: number): SearchScratch {
  let s = searchScratches.get(terrain);
  if (!s) {
    s = { g: new Float32Array(n), from: new Int32Array(n), stamp: new Uint32Array(n), closedAt: new Uint32Array(n), heap: new Heap(), gen: 1 };
    searchScratches.set(terrain, s);
  }
  return s;
}

/**
 * Class-independent terrain samples per nav cell, shared by every movement class's grid (3.0
 * perf round).
 */
export interface NavBase {
  readonly nx: number;
  readonly nz: number;
  readonly ground: Uint8Array;
  /** slopeAt, clamped to 10° on roads, fords and ford banks (the effective nav slope). */
  readonly slope: Float64Array;
  /** buildingCover(x, z, 0.75 cell) on town / open ground, else 0. */
  readonly built: Float64Array;
  /** 1 where buildingH > 0 at the cell centre. */
  readonly house: Uint8Array;
}

const BASES = new WeakMap<Terrain, NavBase>();

/** Within one terrain cell of a ford (its banks). */
function nearFord(terrain: Terrain, x: number, z: number): boolean {
  const e = terrain.cell * 1.5;
  return terrain.groundAt(x + e, z) === Ground.Ford || terrain.groundAt(x - e, z) === Ground.Ford
    || terrain.groundAt(x, z + e) === Ground.Ford || terrain.groundAt(x, z - e) === Ground.Ford;
}

export function sampleBase(base: NavBase, terrain: Terrain, i: number, j: number): void {
  const x = Math.min(i * NAV_CELL, terrain.width);
  const z = Math.min(j * NAV_CELL, terrain.depth);
  const k = j * base.nx + i;
  const g = terrain.groundAt(x, z);
  base.ground[k] = g;
  if (g === Ground.Water) return;
  const crossing = g === Ground.Road || g === Ground.Ford || nearFord(terrain, x, z);
  base.slope[k] = crossing ? Math.min(terrain.slopeAt(x, z), 10) : terrain.slopeAt(x, z);
  base.built[k] = g === Ground.Town || g === Ground.Open ? terrain.buildingCover(x, z, NAV_CELL * 0.75) : 0;
  base.house[k] = terrain.buildingH(x, z) > 0 ? 1 : 0;
}

export function navBase(terrain: Terrain): NavBase {
  let base = BASES.get(terrain);
  if (base) return base;
  const nx = Math.floor(terrain.width / NAV_CELL) + 1;
  const nz = Math.floor(terrain.depth / NAV_CELL) + 1;
  const n = nx * nz;
  base = { nx, nz, ground: new Uint8Array(n), slope: new Float64Array(n), built: new Float64Array(n), house: new Uint8Array(n) };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) sampleBase(base, terrain, i, j);
  BASES.set(terrain, base);
  return base;
}
