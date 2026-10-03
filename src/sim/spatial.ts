import type { Unit } from './types';

/** Minimal view of the world needed to build owner masks (avoids a circular import). */
interface HostilityView {
  readonly factions: readonly unknown[];
  isHostile(a: number, b: number): boolean;
}

/** Bit mask of the owners hostile to faction `f` (for `SpatialHash.queryOwners`). */
export function hostileMask(world: HostilityView, f: number): number {
  let m = 0;
  for (let o = 0; o < world.factions.length; o++) if (world.isHostile(f, o)) m |= 1 << o;
  return m;
}

/**
 * Uniform grid rebuilt each tick with a counting sort into flat typed arrays
 * (cell-sorted, cache friendly; no per-tick Map/array allocation). Positions are
 * copied into SoA arrays so the distance test does not touch unit objects.
 * Each cell also keeps a bit mask of the owners present, so owner-filtered queries
 * (e.g. "hostiles near me") skip whole cells that hold only friendly units.
 */
export class SpatialHash {
  private nx = 1;
  private nz = 1;
  private cellStart = new Int32Array(2);
  private cellFill = new Int32Array(1);
  private cellMask = new Int32Array(1);
  private order = new Int32Array(0);
  private xs = new Float32Array(0);
  private zs = new Float32Array(0);
  private ownerBit = new Int32Array(0);
  private units: Unit[] = [];
  private cellOf = new Int32Array(0);

  constructor(private readonly size: number, private width = 4096, private depth = 4096) {
    this.resize(width, depth);
  }

  setBounds(width: number, depth: number): void {
    if (width !== this.width || depth !== this.depth) this.resize(width, depth);
  }

  private resize(width: number, depth: number): void {
    this.width = width;
    this.depth = depth;
    this.nx = Math.max(1, Math.ceil(width / this.size) + 1);
    this.nz = Math.max(1, Math.ceil(depth / this.size) + 1);
    const cells = this.nx * this.nz;
    this.cellStart = new Int32Array(cells + 1);
    this.cellFill = new Int32Array(cells);
    this.cellMask = new Int32Array(cells);
  }

  private cellIndex(x: number, z: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor(x / this.size)));
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor(z / this.size)));
    return j * this.nx + i;
  }

  rebuild(units: Iterable<Unit>): void {
    const list = this.units;
    list.length = 0;
    for (const u of units) list.push(u);
    const n = list.length;
    if (this.order.length < n) {
      const cap = Math.max(64, n * 2);
      this.order = new Int32Array(cap);
      this.xs = new Float32Array(cap);
      this.zs = new Float32Array(cap);
      this.ownerBit = new Int32Array(cap);
      this.cellOf = new Int32Array(cap);
    }
    const start = this.cellStart;
    const mask = this.cellMask;
    const cellOf = this.cellOf;
    const cells = mask.length;
    start.fill(0);
    mask.fill(0);
    for (let k = 0; k < n; k++) {
      const u = list[k];
      const c = this.cellIndex(u.pos.x, u.pos.z);
      cellOf[k] = c;
      start[c + 1]++;
      mask[c] |= 1 << u.owner;
    }
    for (let c = 1; c <= cells; c++) start[c] += start[c - 1];
    const fill = this.cellFill;
    fill.set(start.subarray(0, cells));
    const order = this.order;
    const xs = this.xs;
    const zs = this.zs;
    const ownerBit = this.ownerBit;
    for (let k = 0; k < n; k++) {
      const slot = fill[cellOf[k]]++;
      const u = list[k];
      order[slot] = k;
      xs[slot] = u.pos.x;
      zs[slot] = u.pos.z;
      ownerBit[slot] = 1 << u.owner;
    }
  }

  /** Units within r of (x,z), using positions as of the last rebuild. */
  query(x: number, z: number, r: number, out: Unit[] = []): Unit[] {
    return this.queryOwners(x, z, r, -1, out);
  }

  /**
   * First unit within r whose owner bit is in `owners` and that satisfies `pred`, or null.
   * Stops at the first match (no result array), for the many "is any enemy near?" checks.
   */
  findOwner(x: number, z: number, r: number, owners: number, pred: (u: Unit) => boolean): Unit | null {
    const s = this.size;
    const i0 = Math.max(0, Math.floor((x - r) / s));
    const i1 = Math.min(this.nx - 1, Math.floor((x + r) / s));
    const j0 = Math.max(0, Math.floor((z - r) / s));
    const j1 = Math.min(this.nz - 1, Math.floor((z + r) / s));
    const r2 = r * r;
    const start = this.cellStart;
    const mask = this.cellMask;
    const xs = this.xs;
    const zs = this.zs;
    const ownerBit = this.ownerBit;
    const order = this.order;
    const units = this.units;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.nx;
      for (let c = row + i0; c <= row + i1; c++) {
        if ((mask[c] & owners) === 0) continue;
        const b = start[c + 1];
        for (let k = start[c]; k < b; k++) {
          if ((ownerBit[k] & owners) === 0) continue;
          const dx = xs[k] - x;
          const dz = zs[k] - z;
          if (dx * dx + dz * dz <= r2) {
            const u = units[order[k]];
            if (pred(u)) return u;
          }
        }
      }
    }
    return null;
  }

  /**
   * Like `query`, restricted to units whose owner bit is in `owners` (same relative order as
   * `query`). Cells without any such owner are skipped without scanning their units.
   */
  queryOwners(x: number, z: number, r: number, owners: number, out: Unit[] = []): Unit[] {
    out.length = 0;
    const s = this.size;
    const i0 = Math.max(0, Math.floor((x - r) / s));
    const i1 = Math.min(this.nx - 1, Math.floor((x + r) / s));
    const j0 = Math.max(0, Math.floor((z - r) / s));
    const j1 = Math.min(this.nz - 1, Math.floor((z + r) / s));
    const r2 = r * r;
    const start = this.cellStart;
    const mask = this.cellMask;
    const xs = this.xs;
    const zs = this.zs;
    const ownerBit = this.ownerBit;
    const order = this.order;
    const units = this.units;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.nx;
      for (let c = row + i0; c <= row + i1; c++) {
        if ((mask[c] & owners) === 0) continue;
        const b = start[c + 1];
        for (let k = start[c]; k < b; k++) {
          if ((ownerBit[k] & owners) === 0) continue;
          const dx = xs[k] - x;
          const dz = zs[k] - z;
          if (dx * dx + dz * dz <= r2) out.push(units[order[k]]);
        }
      }
    }
    return out;
  }
}
