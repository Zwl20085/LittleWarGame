/**
 * Lazily-expanded Dijkstra (Dial's bucket queue) cost-to-goal field on the nav grid.
 *
 * Performance notes (results are bit-identical to a full eager build):
 * - Edge weights are integers (decimetres × terrain cost), precomputed once per nav grid in
 *   `EdgeTable`, so the inner loop is a table lookup instead of bounds/corner checks + rounding.
 * - The search is resumable: it only expands buckets until the requested start cell is settled.
 *   Dial's invariant guarantees every cell with distance < `frontier` is final; all other cells
 *   read as unreachable, which is safe for steepest descent because a descent from `start` only
 *   ever moves to cells strictly cheaper than `dist[start]` (< frontier). Later requests from
 *   farther away simply resume the same search.
 */

/** Distance value of an unreached / not-yet-settled cell. */
export const FIELD_INF = 0x7fffffff;

/** Neighbour order of the eight edge slots per cell. */
const DIRS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];

/** Integer edge weights for all 8 neighbours of every cell (0 = no edge). Static per grid. */
export class EdgeTable {
  /** Int16 halves the table's cache footprint; weights are < 700 (asserted in the constructor). */
  readonly w: Int16Array;
  readonly off: Int32Array;
  /** Bucket ring size: strictly larger than any edge weight. */
  readonly ring: number;

  constructor(cost: Float32Array, nx: number, nz: number, cell: number) {
    const n = nx * nz;
    this.w = new Int16Array(n * 8);
    this.off = Int32Array.from(DIRS, ([di, dj]) => dj * nx + di);
    const straight = cell * 10 * 0.5;
    const diag = straight * 1.4142;
    this.ring = Math.ceil(1.4142 * cell * 10 * 6) + 3;
    let maxW = 0;
    for (let cj = 0; cj < nz; cj++) {
      for (let ci = 0; ci < nx; ci++) {
        const cur = cj * nx + ci;
        const cc = cost[cur];
        for (let d = 0; d < 8; d++) {
          const [di, dj] = DIRS[d];
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
          const c = cost[nj * nx + ni];
          if (c <= 0) continue;
          const isDiag = di !== 0 && dj !== 0;
          if (isDiag && (cost[cj * nx + ni] <= 0 || cost[nj * nx + ci] <= 0)) continue;
          const wt = Math.round((isDiag ? diag : straight) * (c + cc));
          if (wt > 0x7fff) throw new Error(`nav edge weight ${wt} exceeds Int16 range`);
          this.w[cur * 8 + d] = wt;
          if (wt > maxW) maxW = wt;
        }
      }
    }
    // The bucket ring must exceed the largest edge, or entries would wrap into the current bucket.
    if (maxW >= this.ring) this.ring = maxW + 1;
  }
}

export class FlowField {
  readonly dist: Int32Array;
  used = 0;
  /** Every bucket below this distance has been fully processed (those cells are final). */
  private frontier = 0;
  private pending = 1;
  /** Bucket ring of Dial's algorithm; slots are created on first use. */
  private buckets: (number[] | undefined)[] | null;

  /** `buffer` (optional) is recycled storage of an evicted field, avoiding a fresh 400 KB allocation. */
  constructor(private readonly edges: EdgeTable, n: number, goal: number, buffer?: Int32Array) {
    this.dist = buffer && buffer.length === n ? buffer : new Int32Array(n);
    this.dist.fill(FIELD_INF);
    this.buckets = new Array<number[] | undefined>(edges.ring);
    this.dist[goal] = 0;
    this.buckets[0] = [goal];
  }

  /** Final cost-to-goal of cell k, or FIELD_INF when unreachable or not yet settled. */
  value(k: number): number {
    const v = this.dist[k];
    return v < this.frontier ? v : FIELD_INF;
  }

  /** Expand the search until cell `k` is final (or the whole reachable area is). Returns cells popped. */
  settle(k: number): number {
    const dist = this.dist;
    if (dist[k] < this.frontier || this.pending === 0) return 0;
    const buckets = this.buckets!;
    const B = buckets.length;
    const W = this.edges.w;
    const OFF = this.edges.off;
    let d = this.frontier;
    let pending = this.pending;
    let popped = 0;
    while (pending > 0 && d <= dist[k]) {
      const bucket = buckets[d % B];
      while (bucket !== undefined && bucket.length > 0) {
        const cur = bucket.pop()!;
        pending--;
        if (dist[cur] !== d) continue;
        popped++;
        const base = cur * 8;
        for (let e = 0; e < 8; e++) {
          const wt = W[base + e];
          if (wt === 0) continue;
          const nb = cur + OFF[e];
          const nd = d + wt;
          if (nd < dist[nb]) {
            dist[nb] = nd;
            const slot = nd % B;
            const q = buckets[slot];
            if (q === undefined) buckets[slot] = [nb];
            else q.push(nb);
            pending++;
          }
        }
      }
      d++;
    }
    this.frontier = pending === 0 ? FIELD_INF : d;
    this.pending = pending;
    if (pending === 0) this.buckets = null;
    return popped;
  }
}
