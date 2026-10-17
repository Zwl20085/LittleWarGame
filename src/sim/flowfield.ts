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
 * - Storage is sparse (WP-M2): distances live in 32-cell chunks of the linear cell index, allocated
 *   the first time the search touches a cell of the chunk. A lazy field touches 10-30 % of a large
 *   map, so a field costs that share of a dense array, and the shared cache (nav.ts FieldPool)
 *   holds several times more fields in the same bytes. An untouched cell reads FIELD_INF, exactly
 *   what the dense array held, so every value, and every path, is unchanged.
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

/** Cells per storage chunk (a power of two; a strip of one row of the linear cell index). */
const CHUNK_SHIFT = 5;
const CHUNK = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK - 1;
/** Initial slab capacity (cells) and growth factor. */
const SLAB_MIN = 64 * CHUNK;
const SLAB_GROW = 1.5;

/** Reusable storage of an evicted field (nav.ts FieldPool): its chunk table. */
export interface FieldStore {
  readonly chunkOf: Int32Array;
}

export class FlowField {
  /** Per chunk: offset of its cells in `slab`, or -1 while the search has not touched it. */
  readonly chunkOf: Int32Array;
  /** Chunk storage, in the order the search reached the chunks. */
  slab: Int32Array;
  private top = 0;
  used = 0;
  /** Every bucket below this distance has been fully processed (those cells are final). */
  private frontier = 0;
  private pending = 1;
  /** Bucket ring of Dial's algorithm; slots are created on first use. */
  private buckets: (number[] | undefined)[] | null;

  /**
   * `store` (optional) is the storage of an evicted field, reused instead of fresh allocations.
   * `onGrow(bytes)` is told when the slab grows (the shared cache's byte budget).
   */
  constructor(private readonly edges: EdgeTable, n: number, goal: number, store?: FieldStore, private readonly onGrow?: (bytes: number) => void) {
    const chunks = (n + CHUNK_MASK) >> CHUNK_SHIFT;
    this.chunkOf = store && store.chunkOf.length === chunks ? store.chunkOf : new Int32Array(chunks);
    this.chunkOf.fill(-1);
    this.slab = new Int32Array(SLAB_MIN);
    this.buckets = new Array<number[] | undefined>(edges.ring);
    this.slab[this.chunk(goal) + (goal & CHUNK_MASK)] = 0;
    this.buckets[0] = [goal];
  }

  /** Bytes held by this field's typed arrays. */
  get bytes(): number {
    return this.chunkOf.byteLength + this.slab.byteLength;
  }

  /** Cells (of 32-cell chunks) the search has touched. */
  get touchedCells(): number {
    return this.top;
  }

  /** Raw distance of cell k (tentative or final; FIELD_INF when untouched). */
  at(k: number): number {
    const o = this.chunkOf[k >> CHUNK_SHIFT];
    return o < 0 ? FIELD_INF : this.slab[o + (k & CHUNK_MASK)];
  }

  /** Final cost-to-goal of cell k, or FIELD_INF when unreachable or not yet settled. */
  value(k: number): number {
    const v = this.at(k);
    return v < this.frontier ? v : FIELD_INF;
  }

  /** Slab offset of chunk c, allocating it (all FIELD_INF) on first touch. */
  private chunk(k: number): number {
    const c = k >> CHUNK_SHIFT;
    const o = this.chunkOf[c];
    if (o >= 0) return o;
    if (this.top + CHUNK > this.slab.length) {
      const grown = new Int32Array(Math.max(this.top + CHUNK, Math.ceil((this.slab.length * SLAB_GROW) / CHUNK) * CHUNK));
      grown.set(this.slab.subarray(0, this.top));
      this.onGrow?.(grown.byteLength - this.slab.byteLength);
      this.slab = grown;
    }
    const at = this.top;
    this.slab.fill(FIELD_INF, at, at + CHUNK);
    this.chunkOf[c] = at;
    this.top += CHUNK;
    return at;
  }

  /** Expand the search until cell `k` is final (or the whole reachable area is). Returns cells popped. */
  settle(k: number): number {
    if (this.at(k) < this.frontier || this.pending === 0) return 0;
    const buckets = this.buckets!;
    const B = buckets.length;
    const W = this.edges.w;
    const OFF = this.edges.off;
    const chunkOf = this.chunkOf;
    let slab = this.slab;
    let d = this.frontier;
    let pending = this.pending;
    let popped = 0;
    let target = this.at(k);
    while (pending > 0 && d <= target) {
      const bucket = buckets[d % B];
      while (bucket !== undefined && bucket.length > 0) {
        const cur = bucket.pop()!;
        pending--;
        // Every queued cell was written, so its chunk exists.
        if (slab[chunkOf[cur >> CHUNK_SHIFT] + (cur & CHUNK_MASK)] !== d) continue;
        popped++;
        const base = cur * 8;
        for (let e = 0; e < 8; e++) {
          const wt = W[base + e];
          if (wt === 0) continue;
          const nb = cur + OFF[e];
          const nd = d + wt;
          let o = chunkOf[nb >> CHUNK_SHIFT];
          if (o >= 0 && nd >= slab[o + (nb & CHUNK_MASK)]) continue;
          if (o < 0) {
            o = this.chunk(nb);
            slab = this.slab;
          }
          slab[o + (nb & CHUNK_MASK)] = nd;
          if (nb === k) target = nd;
          const slot = nd % B;
          const q = buckets[slot];
          if (q === undefined) buckets[slot] = [nb];
          else q.push(nb);
          pending++;
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
