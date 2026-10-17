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
 * - Two storage forms (WP-M2). A field being expanded is hot: one dense Int32 per cell, the
 *   loop below unchanged. A field that only serves lookups is cold: just the 32-cell chunks of the
 *   linear cell index the search touched (10-30 % of a large map). nav.ts keeps a few fields hot and
 *   cools the least recently used one when another has to expand again. Untouched cells read
 *   FIELD_INF in both forms, exactly as before, so every value, and every path, is unchanged.
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

/** Cells per storage chunk of the compact form (a power of two; a strip of one row of the linear cell index). */
const CHUNK_SHIFT = 5;
const CHUNK = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK - 1;
/** Chunk table entry of an untouched chunk. */
const NO_CHUNK = 0xffff;
const EMPTY = new Int32Array(0);

/**
 * Supplies dense working buffers (nav.ts FieldPool): `heat(f)` must call `f.warm(buffer)`, cooling
 * another field to free one if it has to.
 */
export interface FieldHost {
  heat(f: FlowField): void;
}

export class FlowField {
  /** Dense form (one Int32 per cell) while the field is hot (being expanded), else null. */
  dense: Int32Array | null;
  /** Compact form while cold: per chunk its ordinal in `slab`, or NO_CHUNK when untouched. */
  readonly chunkOf: Uint16Array;
  private slab: Int32Array = EMPTY;
  used = 0;
  /** Every bucket below this distance has been fully processed (those cells are final). */
  private frontier = 0;
  private pending = 1;
  /** Bucket ring of Dial's algorithm; slots are created on first use. */
  private buckets: (number[] | undefined)[] | null;

  /**
   * Starts hot. `dense` (length n) and `chunkOf` are recycled buffers of other fields (optional);
   * `host` hands out dense buffers when a cold field has to expand again.
   */
  constructor(private readonly edges: EdgeTable, readonly n: number, goal: number, opts: { dense?: Int32Array; chunkOf?: Uint16Array; host?: FieldHost } = {}) {
    const chunks = (n + CHUNK_MASK) >> CHUNK_SHIFT;
    if (chunks >= NO_CHUNK) throw new Error(`flow field: ${n} cells exceed the chunk table`);
    this.chunkOf = opts.chunkOf && opts.chunkOf.length === chunks ? opts.chunkOf : new Uint16Array(chunks);
    this.host = opts.host ?? null;
    this.dense = opts.dense && opts.dense.length === n ? opts.dense : new Int32Array(n);
    this.dense.fill(FIELD_INF);
    this.dense[goal] = 0;
    this.buckets = new Array<number[] | undefined>(edges.ring);
    this.buckets[0] = [goal];
  }

  private readonly host: FieldHost | null;

  /** Bytes held by this field's typed arrays. */
  get bytes(): number {
    return this.chunkOf.byteLength + (this.dense ? this.dense.byteLength : this.slab.byteLength);
  }

  /** Cells of the 32-cell chunks the search has touched (diagnostics; scans a hot field). */
  get touchedCells(): number {
    if (!this.dense) return this.slab.length;
    let t = 0;
    for (let c = 0; c < this.chunkOf.length; c++) if (this.chunkTouched(this.dense, c)) t += CHUNK;
    return t;
  }

  /** Raw distance of cell k (tentative or final; FIELD_INF when untouched). */
  at(k: number): number {
    const d = this.dense;
    if (d !== null) return d[k];
    const o = this.chunkOf[k >> CHUNK_SHIFT];
    return o === NO_CHUNK ? FIELD_INF : this.slab[(o << CHUNK_SHIFT) | (k & CHUNK_MASK)];
  }

  /** Final cost-to-goal of cell k, or FIELD_INF when unreachable or not yet settled. */
  value(k: number): number {
    const v = this.at(k);
    return v < this.frontier ? v : FIELD_INF;
  }

  private chunkTouched(d: Int32Array, c: number): boolean {
    const end = Math.min(this.n, (c + 1) << CHUNK_SHIFT);
    for (let k = c << CHUNK_SHIFT; k < end; k++) if (d[k] !== FIELD_INF) return true;
    return false;
  }

  /** Make the dense form current in `buffer` (length n) from the compact form. */
  warm(buffer: Int32Array): void {
    if (this.dense) return;
    buffer.fill(FIELD_INF);
    const slab = this.slab;
    for (let c = 0; c < this.chunkOf.length; c++) {
      const o = this.chunkOf[c];
      if (o === NO_CHUNK) continue;
      const at = c << CHUNK_SHIFT;
      const len = Math.min(CHUNK, this.n - at);
      buffer.set(slab.subarray(o << CHUNK_SHIFT, (o << CHUNK_SHIFT) + len), at);
    }
    this.dense = buffer;
    this.slab = EMPTY;
  }

  /** Store the touched chunks compactly and give back the dense buffer. */
  cool(): Int32Array {
    const d = this.dense!;
    const chunkOf = this.chunkOf;
    let used = 0;
    for (let c = 0; c < chunkOf.length; c++) {
      if (this.chunkTouched(d, c)) chunkOf[c] = used++;
      else chunkOf[c] = NO_CHUNK;
    }
    const slab = new Int32Array(used << CHUNK_SHIFT).fill(FIELD_INF);
    for (let c = 0; c < chunkOf.length; c++) {
      const o = chunkOf[c];
      if (o === NO_CHUNK) continue;
      const at = c << CHUNK_SHIFT;
      slab.set(d.subarray(at, Math.min(this.n, at + CHUNK)), o << CHUNK_SHIFT);
    }
    this.slab = slab;
    this.dense = null;
    return d;
  }

  /** Expand the search until cell `k` is final (or the whole reachable area is). Returns cells popped. */
  settle(k: number): number {
    if (this.at(k) < this.frontier || this.pending === 0) return 0;
    if (!this.dense) {
      if (this.host) this.host.heat(this);
      else this.warm(new Int32Array(this.n));
    }
    const dist = this.dense!;
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

