import { TERRAIN_MOVE } from './config';
import { EdgeTable, FIELD_INF, FlowField } from './flowfield';
import { Ground, type Terrain } from './terrain';
import { clamp, dist2, type V2 } from './vec';

/** Flow-field goals snap to this lattice (fewer distinct fields to build and cache). */
const GOAL_LATTICE_M = 128;
/** Cached flow fields per navigation grid (each ~0.8 MB on a large map). */
const FIELD_CACHE = 128;

export interface NavClass {
  readonly vehicle: boolean;
  readonly maxSlopeDeg: number;
}

const groundKey = (g: Ground): keyof typeof TERRAIN_MOVE =>
  g === Ground.Road ? 'road' : g === Ground.Forest ? 'forest' : g === Ground.Town ? 'town' : g === Ground.Mud || g === Ground.Ford ? 'mud' : 'open';

/** Movement multiplier from ground type (BALANCE_SPEC §7). */
export function groundSpeedMul(g: Ground, vehicle: boolean): number {
  return TERRAIN_MOVE[groundKey(g)][vehicle ? 1 : 0];
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
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
 * `partial`: the path stops at the horizon short of the goal (the mover must ask for the rest).
 * `bestEffort`: the goal is cut off on this grid; the path only gets as close as possible.
 */
export type PathResult = { ok: true; points: V2[]; partial: boolean; bestEffort?: true } | { ok: false; reason: 'UNREACHABLE' | 'OUT_OF_BOUNDS' };

/** Coarse navigation grid (8 m) per movement class; derived from the same Terrain as LOS. */
export class NavGrid {
  readonly cell = 8;
  readonly nx: number;
  readonly nz: number;
  readonly cost: Float32Array; // 0 = blocked, else seconds-per-metre multiplier
  private readonly g: Float32Array;
  private readonly from: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closedAt: Uint32Array;
  private gen = 1;

  /** 1 where a cell touches a building: string-pulling then checks the 2 m raster too. */
  private readonly built: Uint8Array;
  /** 1 = walkable ignoring buildings (water/slope only); movement pairs it with the 2 m raster. */
  private readonly walk: Uint8Array;

  constructor(private readonly terrain: Terrain, readonly cls: NavClass) {
    this.nx = Math.floor(terrain.width / this.cell) + 1;
    this.nz = Math.floor(terrain.depth / this.cell) + 1;
    const n = this.nx * this.nz;
    this.cost = new Float32Array(n);
    this.g = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closedAt = new Uint32Array(n);
    this.built = new Uint8Array(n);
    this.walk = new Uint8Array(n);
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) this.cost[j * this.nx + i] = this.cellCost(terrain, i, j);
  }

  /** Travel-cost multiplier of cell (i, j) from the current terrain (0 = blocked). */
  private cellCost(terrain: Terrain, i: number, j: number): number {
    const x = Math.min(i * this.cell, terrain.width);
    const z = Math.min(j * this.cell, terrain.depth);
    const g = terrain.groundAt(x, z);
    this.walk[j * this.nx + i] = 0;
    if (g === Ground.Water) return 0;
    // Roads (graded, incl. bridge causeways) and fords with their banks ignore the slope limit:
    // slopeAt samples ±4 m and would otherwise "see" the carved channel beside a bridge or ford.
    const crossing = g === Ground.Road || g === Ground.Ford || nearFord(terrain, x, z);
    const slope = crossing ? Math.min(terrain.slopeAt(x, z), 10) : terrain.slopeAt(x, z);
    if (slope > this.cls.maxSlopeDeg) return 0;
    const mul = groundSpeedMul(g, this.cls.vehicle);
    const slopeMul = clamp(1 - 0.02 * slope, 0.45, 1);
    // Buildings: cells mostly inside one are walls; partly built-up cells are costly, so routes
    // follow the streets (the 2 m raster in movement does the exact collision).
    const built = g === Ground.Town || g === Ground.Open ? terrain.buildingCover(x, z, this.cell * 0.75) : 0;
    this.built[j * this.nx + i] = built > 0 ? 1 : 0;
    this.walk[j * this.nx + i] = 1;
    if (built > 0.55 || terrain.buildingH(x, z) > 0) return 0;
    return (1 + built * (this.cls.vehicle ? 4 : 2)) / (mul * slopeMul);
  }

  /**
   * Recompute cell costs inside the box [x0,x1]×[z0,z1] (metres) after a runtime terrain change
   * (e.g. a pontoon bridge), then drop the edge table and every cached flow field so later
   * searches see the new costs. Deterministic: depends only on terrain state.
   */
  refreshArea(terrain: Terrain, x0: number, z0: number, x1: number, z1: number): void {
    const i0 = clamp(Math.floor(Math.min(x0, x1) / this.cell), 0, this.nx - 1);
    const i1 = clamp(Math.ceil(Math.max(x0, x1) / this.cell), 0, this.nx - 1);
    const j0 = clamp(Math.floor(Math.min(z0, z1) / this.cell), 0, this.nz - 1);
    const j1 = clamp(Math.ceil(Math.max(z0, z1) / this.cell), 0, this.nz - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cost[j * this.nx + i] = this.cellCost(terrain, i, j);
    this.edges = null;
    this.fields.clear();
  }

  private idx(p: V2): number {
    const i = clamp(Math.round(p.x / this.cell), 0, this.nx - 1);
    const j = clamp(Math.round(p.z / this.cell), 0, this.nz - 1);
    return j * this.nx + i;
  }

  passable(p: V2): boolean {
    return this.cost[this.idx(p)] > 0;
  }

  /** Allocation-free `idx` for hot loops. */
  private idxXZ(x: number, z: number): number {
    const i = clamp(Math.round(x / this.cell), 0, this.nx - 1);
    const j = clamp(Math.round(z / this.cell), 0, this.nz - 1);
    return j * this.nx + i;
  }

  /** `walkableXZ` as a reusable callback for local searches. */
  readonly walkFn = (x: number, z: number): boolean => this.walk[this.idxXZ(x, z)] === 1;

  /** Terrain-only walkability (ignores buildings) for per-tick movement; see `walk`. */
  walkableXZ(x: number, z: number): boolean {
    return this.walk[this.idxXZ(x, z)] === 1;
  }

  /** Allocation-free `passable` for hot per-tick movement code. */
  passableXZ(x: number, z: number): boolean {
    return this.cost[this.idxXZ(x, z)] > 0;
  }

  /** Nearest passable cell centre within maxDist metres (spiral search). */
  nearestPassable(p: V2, maxDist = 40): V2 | null {
    if (this.passable(p)) return p;
    const ci = Math.round(p.x / this.cell);
    const cj = Math.round(p.z / this.cell);
    const R = Math.ceil(maxDist / this.cell);
    let best: V2 | null = null;
    let bestD = Infinity;
    for (let dj = -R; dj <= R; dj++) {
      for (let di = -R; di <= R; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) continue;
        if (this.cost[j * this.nx + i] <= 0) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = { x: i * this.cell, z: j * this.cell };
        }
      }
    }
    return best && Math.sqrt(bestD) * this.cell <= maxDist ? best : null;
  }

  /** Straight walk check used for string-pulling. */
  private lineClear(a: V2, b: V2): boolean {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.ceil(len / (this.cell * 0.5));
    // Do not shortcut through slower ground than the segment start (keeps road following).
    const ref = Math.max(this.cost[this.idx(a)], this.cost[this.idx(b)]) * 1.15;
    const cost = this.cost;
    const built = this.built;
    let touchesBuilt = built[this.idx(a)] | built[this.idx(b)];
    const nx = this.nx;
    const last = cost.length - 1;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const k2 = this.idxXZ(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      const c = cost[k2];
      if (c <= 0 || c > ref) return false;
      // Include the 4-neighbourhood so a segment clipping a built cell's corner is not missed.
      touchesBuilt |= built[k2] | built[k2 > 0 ? k2 - 1 : 0] | built[k2 < last ? k2 + 1 : last] | built[k2 >= nx ? k2 - nx : 0] | built[k2 + nx <= last ? k2 + nx : last];
    }
    // The fine 1.5 m building pass only matters where the segment crosses built-up cells
    // (open country, the common case, skips it entirely).
    return touchesBuilt === 0 || this.clearOfBuildings(a, b, len);
  }

  /**
   * Greedy string pulling with a bounded look-ahead: from `anchor`, keep the farthest point
   * (within `look` steps) that is reachable in a straight clear line. Open ground succeeds on
   * the first try; otherwise a binary search finds a clear cut in O(log look) line checks
   * instead of scanning every candidate.
   */
  private pull(anchor: V2, pts: V2[], look: number, out: V2[]): void {
    let i = 0;
    while (i < pts.length) {
      const hi = Math.min(pts.length - 1, i + look);
      let far = i;
      if (hi > i && this.lineClear(anchor, pts[hi])) far = hi;
      else if (hi > i) {
        let lo = i;
        let up = hi;
        while (up - lo > 1) {
          const m = (lo + up) >> 1;
          if (this.lineClear(anchor, pts[m])) lo = m;
          else up = m;
        }
        far = lo;
      }
      out.push(pts[far]);
      anchor = pts[far];
      i = far + 1;
    }
  }

  /** Fine check against the building raster, only where the segment touches built-up cells. */
  private clearOfBuildings(a: V2, b: V2, len: number): boolean {
    const n = Math.ceil(len / 1.5);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      if (this.built[this.idxXZ(x, z)] && this.terrain.buildingH(x, z) > 0) return false;
    }
    return true;
  }

  static builds = 0;
  /** Flow-field cache hits (perf diagnostics; builds = misses). */
  static fieldHits = 0;
  /** Cache evictions and distinct goal cells ever requested (perf diagnostics). */
  static evictions = 0;
  static readonly goalCells = new Set<number>();
  /** Cells settled by flow-field searches (perf diagnostics). */
  static expanded = 0;
  private readonly fields = new Map<number, FlowField>();
  private fieldClock = 0;
  private edges: EdgeTable | null = null;

  /**
   * Dijkstra cost-to-goal field shared by every unit heading to the same (quantised) goal.
   * Thousands of units can then path in O(path length) instead of one A* each. The field is
   * expanded lazily (see flowfield.ts); call `settle(start)` before reading it.
   */
  flowField(goal: V2): FlowField | null {
    // Snap goals to a coarse lattice so whole formations (and successive horizon stretches)
    // share one field; the exact last stretch is a short local search (pathByField).
    const q = GOAL_LATTICE_M;
    const snapped = { x: Math.round(goal.x / q) * q, z: Math.round(goal.z / q) * q };
    const g0 = this.nearestPassable(snapped, q * 0.75) ?? this.nearestPassable(goal, 48);
    if (!g0) return null;
    const gi = this.idx(g0);
    const hit = this.fields.get(gi);
    if (hit) {
      hit.used = ++this.fieldClock;
      NavGrid.fieldHits++;
      return hit;
    }
    let spare: Int32Array | undefined;
    if (this.fields.size >= FIELD_CACHE) {
      let oldK = -1;
      let oldU = Infinity;
      for (const [k, v] of this.fields) if (v.used < oldU) { oldU = v.used; oldK = k; }
      spare = this.fields.get(oldK)?.dist;
      this.fields.delete(oldK);
      NavGrid.evictions++;
    }
    if (NavGrid.goalCells.size < 50000) NavGrid.goalCells.add(gi * 4 + (this.cls.vehicle ? 1 : 0) + (this.cls.maxSlopeDeg === 25 ? 2 : 0));
    this.edges ??= new EdgeTable(this.cost, this.nx, this.nz, this.cell);
    const field = new FlowField(this.edges, this.nx * this.nz, gi, spare);
    field.used = ++this.fieldClock;
    this.fields.set(gi, field);
    NavGrid.builds++;
    return field;
  }

  private static readonly descent = new Int32Array(4096);

  /**
   * Path from `start` by descending a flow field toward `dest`, with bounded look-ahead smoothing.
   * `horizonCells` caps the path length (cells); a capped path is marked `partial` and the mover
   * asks for the next stretch when it gets there, so the per-call cost is bounded no matter how
   * far the goal is (the field itself is shared and cached).
   */
  pathByField(start: V2, dest: V2, horizonCells = 4000): PathResult {
    const field = this.flowField(dest);
    if (!field) return { ok: false, reason: 'UNREACHABLE' };
    const s0 = this.nearestPassable(start, 24) ?? start;
    let cur = this.idx(s0);
    NavGrid.expanded += field.settle(cur);
    // Start and goal in different pockets: get as close as the local search allows.
    if (field.value(cur) === FIELD_INF) {
      const local = this.findPath(start, dest, 4000);
      return local.ok ? local : this.findPath(start, dest, 4000, true);
    }
    const nx = this.nx;
    const nz = this.nz;
    // Every cell on a steepest descent from a settled start is final (strictly cheaper than the
    // start, hence below the frontier), so raw distances can be read without the frontier test.
    const dist = field.dist;
    const cells = NavGrid.descent;
    const limit = Math.min(cells.length, horizonCells);
    let n = 0;
    cells[n++] = cur;
    while (n < limit && dist[cur] > 0) {
      const ci = cur % nx;
      const cj = (cur / nx) | 0;
      let best = cur;
      let bv = dist[cur];
      const i0 = ci > 0 ? -1 : 0;
      const i1 = ci < nx - 1 ? 1 : 0;
      const j0 = cj > 0 ? -1 : 0;
      const j1 = cj < nz - 1 ? 1 : 0;
      for (let dj = j0; dj <= j1; dj++) {
        const row = (cj + dj) * nx + ci;
        for (let di = i0; di <= i1; di++) {
          const v = dist[row + di];
          if (v < bv) { bv = v; best = row + di; }
        }
      }
      if (best === cur) break;
      cur = best;
      cells[n++] = cur;
    }
    const partial = dist[cur] > 0;
    const pts: V2[] = new Array(n);
    for (let k = 0; k < n; k++) pts[k] = { x: (cells[k] % nx) * this.cell, z: ((cells[k] / nx) | 0) * this.cell };
    // Last stretch from the shared lattice goal to the exact destination.
    const tail = pts[n - 1];
    if (!partial && this.passable(dest) && dist2(tail, dest) > 1) {
      if (this.lineClear(tail, dest)) pts.push({ ...dest });
      else {
        const local = this.findPath(tail, dest, 3000);
        if (local.ok) pts.push(...local.points);
      }
    }
    const out: V2[] = [];
    // Pull from the unit's real position, past its own cell centre (which may lie behind it).
    this.pull(start, pts.length > 1 ? pts.slice(1) : pts, 24, out);
    return { ok: true, points: out, partial };
  }

  /**
   * A* on the coarse grid. `relaxCorners` allows diagonal steps between two blocked cells: not
   * for normal routes (it would cut river and wall corners) but as an escape for a unit that
   * drove into a graph island through such a squeeze (continuous movement allows it).
   */
  findPath(start: V2, goal: V2, maxExpand = 30000, relaxCorners = false): PathResult {
    const s0 = this.nearestPassable(start, 24) ?? start;
    const g0 = this.nearestPassable(goal, 40);
    if (!g0) return { ok: false, reason: 'UNREACHABLE' };
    const si = this.idx(s0);
    const gi = this.idx(g0);
    if (si === gi) return { ok: true, points: [g0], partial: false };
    const gen = ++this.gen;
    const nx = this.nx;
    const gx = gi % nx;
    const gz = (gi / nx) | 0;
    const heap = new Heap();
    this.g[si] = 0;
    this.stamp[si] = gen;
    this.from[si] = -1;
    heap.push(si, 0);
    // Closed set as a generation-stamped array (no per-search Set allocation).
    const closed = this.closedAt;
    let found = false;
    let expanded = 0;
    // Best effort: when the goal is cut off (a pocket behind steep ground, an island), the path
    // goes to the reachable cell nearest the goal instead of failing outright.
    let closest = si;
    let closestD = Infinity;
    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === gi) {
        found = true;
        break;
      }
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      {
        const dx = (cur % nx) - gx;
        const dz = ((cur / nx) | 0) - gz;
        const dd = dx * dx + dz * dz;
        if (dd < closestD) { closestD = dd; closest = cur; }
      }
      if (++expanded > maxExpand) break;
      const ci = cur % nx;
      const cj = (cur / nx) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= this.nz) continue;
          const nidx = nj * nx + ni;
          const c = this.cost[nidx];
          if (c <= 0) continue;
          if (!relaxCorners && di !== 0 && dj !== 0 && (this.cost[cj * nx + ni] <= 0 || this.cost[nj * nx + ci] <= 0)) continue;
          const step = (di !== 0 && dj !== 0 ? 1.4142 : 1) * this.cell * (c + this.cost[cur]) * 0.5;
          const ng = this.g[cur] + step;
          if (this.stamp[nidx] === gen && ng >= this.g[nidx]) continue;
          this.stamp[nidx] = gen;
          this.g[nidx] = ng;
          this.from[nidx] = cur;
          const hx = Math.abs(ni - gx);
          const hz = Math.abs(nj - gz);
          const h = (Math.max(hx, hz) + 0.4142 * Math.min(hx, hz)) * this.cell * 0.74;
          heap.push(nidx, ng + h);
        }
      }
    }
    if (!found && closest === si) return { ok: false, reason: 'UNREACHABLE' };
    const raw: V2[] = [];
    for (let c = found ? gi : closest; c !== -1 && c !== si; c = this.from[c]) raw.push({ x: (c % nx) * this.cell, z: ((c / nx) | 0) * this.cell });
    raw.reverse();
    if (found) raw[raw.length - 1] = g0;
    const out: V2[] = [];
    this.pull(start, raw, 48, out);
    return found ? { ok: true, points: out, partial: false } : { ok: true, points: out, partial: true, bestEffort: true };
  }

  /** Can `a` reach `b` on this grid (shares the cached flow field of `b`)? */
  connected(a: V2, b: V2): boolean {
    const field = this.flowField(b);
    if (!field) return false;
    const s0 = this.nearestPassable(a, 24);
    if (!s0) return false;
    const k = this.idx(s0);
    NavGrid.expanded += field.settle(k);
    return field.value(k) !== FIELD_INF;
  }
}

/** Within one terrain cell of a ford (its banks). */
function nearFord(terrain: Terrain, x: number, z: number): boolean {
  const e = terrain.cell * 1.5;
  return terrain.groundAt(x + e, z) === Ground.Ford || terrain.groundAt(x - e, z) === Ground.Ford
    || terrain.groundAt(x, z + e) === Ground.Ford || terrain.groundAt(x, z - e) === Ground.Ford;
}
