import { dist, type V2 } from './vec';

/**
 * 3.0 road graph (V30_SPEC §10): the map's road polylines as nodes (settlements at road ends,
 * junctions where roads meet or cross, bridges) and edges with their length. Built once per
 * match from `MapDef.roads` (pure geometry, deterministic); engineer-built segments are added at
 * run time (`addSegment`). Read by the transport lab (fights near junctions), the AI road-link
 * helper (transportjobs.ts) and the economic-zone link test (WP-F).
 */

export type RoadNodeKind = 'town' | 'junction' | 'bridge';

export interface RoadNode {
  readonly id: number;
  readonly pos: V2;
  kind: RoadNodeKind;
  /** Edge ids touching this node. */
  readonly edges: number[];
}

export interface RoadEdge {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly len: number;
  readonly pts: V2[];
  /** Laid by engineers during the match. */
  readonly built: boolean;
}

/** Points of different roads closer than this become one node (m). */
const MERGE_M = 30;
/** A road end this close to another road's centreline joins it (T-junction, m). */
const T_SNAP_M = 25;
/** A bridge this close to a road becomes a node on it (m). */
const BRIDGE_SNAP_M = 20;
/** Segment bucket size for the crossing search (m). */
const BUCKET_M = 120;

interface Split { readonly s: number; readonly p: V2; readonly kind: RoadNodeKind }

export class RoadNet {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];

  /** Build the graph from road polylines (and fixed bridge positions). */
  static build(roads: readonly (readonly V2[])[], bridges: readonly V2[] = []): RoadNet {
    const net = new RoadNet();
    const lines = roads.filter((r) => r.length >= 2);
    const cum = lines.map(cumLengths);
    const splits: Split[][] = lines.map((r, i) => [
      { s: 0, p: r[0], kind: 'town' },
      { s: cum[i][cum[i].length - 1], p: r[r.length - 1], kind: 'town' },
    ]);
    // Crossings between different roads (bucketed segment pairs).
    const buckets = new Map<number, number[]>();
    const segs: { l: number; k: number }[] = [];
    lines.forEach((r, l) => {
      for (let k = 0; k < r.length - 1; k++) {
        const id = segs.length;
        segs.push({ l, k });
        for (const key of bucketKeys(r[k], r[k + 1])) {
          const list = buckets.get(key);
          if (list) list.push(id);
          else buckets.set(key, [id]);
        }
      }
    });
    const seen = new Set<number>();
    for (const list of buckets.values()) {
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const A = segs[list[x]];
          const B = segs[list[y]];
          if (A.l === B.l) continue;
          const pair = list[x] * 1048576 + list[y];
          if (seen.has(pair)) continue;
          seen.add(pair);
          const ra = lines[A.l];
          const rb = lines[B.l];
          const hit = segHit(ra[A.k], ra[A.k + 1], rb[B.k], rb[B.k + 1]);
          if (!hit) continue;
          splits[A.l].push({ s: cum[A.l][A.k] + hit.t * dist(ra[A.k], ra[A.k + 1]), p: hit.p, kind: 'junction' });
          splits[B.l].push({ s: cum[B.l][B.k] + hit.u * dist(rb[B.k], rb[B.k + 1]), p: hit.p, kind: 'junction' });
        }
      }
    }
    // T-junctions: a road end that stops on another road's centreline.
    lines.forEach((r, l) => {
      for (const end of [r[0], r[r.length - 1]]) {
        lines.forEach((o, m) => {
          if (m === l) return;
          const near = nearestOn(o, cum[m], end);
          if (near.d < T_SNAP_M && near.s > 1 && near.s < cum[m][cum[m].length - 1] - 1) splits[m].push({ s: near.s, p: near.p, kind: 'junction' });
        });
      }
    });
    for (const b of bridges) {
      let best = -1;
      let bs = { d: Infinity, s: 0, p: b };
      lines.forEach((r, l) => {
        const near = nearestOn(r, cum[l], b);
        if (near.d < bs.d) { bs = near; best = l; }
      });
      if (best >= 0 && bs.d < BRIDGE_SNAP_M) splits[best].push({ s: bs.s, p: bs.p, kind: 'bridge' });
    }
    // Nodes: split points merged within MERGE_M (first come keeps the position; kinds rank up).
    const nodeOf = (p: V2, kind: RoadNodeKind): number => net.nodeAt(p, kind);
    lines.forEach((r, l) => {
      const list = splits[l].sort((a, b) => a.s - b.s);
      let prevNode = -1;
      let prevS = 0;
      for (const sp of list) {
        const n = nodeOf(sp.p, sp.kind);
        if (prevNode >= 0 && n !== prevNode && sp.s - prevS > 1) net.link(prevNode, n, slice(r, cum[l], prevS, sp.s), false);
        if (n !== prevNode) { prevNode = n; prevS = sp.s; }
      }
    });
    // A node where three or more edges meet is a junction even if it started as a road end.
    for (const n of net.nodes) if (n.kind === 'town' && n.edges.length >= 3) n.kind = 'junction';
    return net;
  }

  /** Node within MERGE_M of p (upgrading its kind), or a new one. */
  private nodeAt(p: V2, kind: RoadNodeKind): number {
    for (const n of this.nodes) {
      if (dist(n.pos, p) < MERGE_M) {
        if (kind === 'bridge' || (kind === 'junction' && n.kind === 'town')) n.kind = kind === 'bridge' ? 'bridge' : n.kind === 'bridge' ? 'bridge' : 'junction';
        return n.id;
      }
    }
    const id = this.nodes.length;
    this.nodes.push({ id, pos: { x: p.x, z: p.z }, kind, edges: [] });
    return id;
  }

  private link(a: number, b: number, pts: V2[], built: boolean): RoadEdge {
    const id = this.edges.length;
    const e: RoadEdge = { id, a, b, len: polyLen(pts), pts, built };
    this.edges.push(e);
    this.nodes[a].edges.push(id);
    this.nodes[b].edges.push(id);
    return e;
  }

  /** An engineer-built road a→b: joins the nearest nodes (or new ends) and returns the edge. */
  addSegment(a: V2, b: V2): RoadEdge {
    const na = this.nodeAt(a, 'town');
    const nb = this.nodeAt(b, 'town');
    for (const id of [na, nb]) if (this.nodes[id].edges.length >= 2 && this.nodes[id].kind === 'town') this.nodes[id].kind = 'junction';
    return this.link(na, nb, [{ ...a }, { ...b }], true);
  }

  /** Junctions (three or more roads) and bridges: where armies funnel. */
  junctions(): RoadNode[] {
    return this.nodes.filter((n) => n.kind === 'bridge' || n.edges.length >= 3);
  }

  /** Nearest node to p within maxD (m), or null. */
  nearestNode(p: V2, maxD = Infinity): RoadNode | null {
    let best: RoadNode | null = null;
    let bd = maxD;
    for (const n of this.nodes) {
      const d = dist(n.pos, p);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** Distance from p to the nearest road centreline (m). */
  distanceToRoad(p: V2): number {
    let best = Infinity;
    for (const e of this.edges) {
      for (let k = 0; k < e.pts.length - 1; k++) best = Math.min(best, segDist(p, e.pts[k], e.pts[k + 1]));
    }
    return best;
  }

  /** Shortest road distance between two nodes (Dijkstra; Infinity when not connected). */
  roadDistance(from: number, to: number): number {
    const n = this.nodes.length;
    const d = new Float64Array(n).fill(Infinity);
    const done = new Uint8Array(n);
    d[from] = 0;
    for (;;) {
      let cur = -1;
      for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (cur < 0 || d[i] < d[cur])) cur = i;
      if (cur < 0) return Infinity;
      if (cur === to) return d[cur];
      done[cur] = 1;
      for (const eid of this.nodes[cur].edges) {
        const e = this.edges[eid];
        const o = e.a === cur ? e.b : e.a;
        if (d[cur] + e.len < d[o]) d[o] = d[cur] + e.len;
      }
    }
  }

  /** Connected component label per node (equal labels = linked by road). */
  components(): Int32Array {
    const lab = new Int32Array(this.nodes.length).fill(-1);
    let next = 0;
    for (const n of this.nodes) {
      if (lab[n.id] >= 0) continue;
      const stack = [n.id];
      lab[n.id] = next;
      while (stack.length) {
        const cur = stack.pop()!;
        for (const eid of this.nodes[cur].edges) {
          const e = this.edges[eid];
          const o = e.a === cur ? e.b : e.a;
          if (lab[o] < 0) { lab[o] = next; stack.push(o); }
        }
      }
      next++;
    }
    return lab;
  }
}

function cumLengths(r: readonly V2[]): number[] {
  const out = [0];
  for (let k = 1; k < r.length; k++) out.push(out[k - 1] + dist(r[k - 1], r[k]));
  return out;
}

function polyLen(r: readonly V2[]): number {
  let s = 0;
  for (let k = 1; k < r.length; k++) s += dist(r[k - 1], r[k]);
  return s;
}

/** Point at arc length s along a polyline. */
function pointAt(r: readonly V2[], cum: readonly number[], s: number): V2 {
  for (let k = 0; k < r.length - 1; k++) {
    if (s <= cum[k + 1] || k === r.length - 2) {
      const L = cum[k + 1] - cum[k];
      const t = L > 0 ? Math.min(1, Math.max(0, (s - cum[k]) / L)) : 0;
      return { x: r[k].x + (r[k + 1].x - r[k].x) * t, z: r[k].z + (r[k + 1].z - r[k].z) * t };
    }
  }
  return { ...r[r.length - 1] };
}

/** Sub-polyline between arc lengths s0 < s1. */
function slice(r: readonly V2[], cum: readonly number[], s0: number, s1: number): V2[] {
  const out = [pointAt(r, cum, s0)];
  for (let k = 1; k < r.length - 1; k++) if (cum[k] > s0 && cum[k] < s1) out.push({ ...r[k] });
  out.push(pointAt(r, cum, s1));
  return out;
}

function nearestOn(r: readonly V2[], cum: readonly number[], p: V2): { d: number; s: number; p: V2 } {
  let best = { d: Infinity, s: 0, p: r[0] };
  for (let k = 0; k < r.length - 1; k++) {
    const a = r[k];
    const b = r[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const q = { x: a.x + dx * t, z: a.z + dz * t };
    const d = dist(p, q);
    if (d < best.d) best = { d, s: cum[k] + t * Math.sqrt(l2), p: q };
  }
  return best;
}

export function segDist(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

function segHit(a: V2, b: V2, c: V2, d: V2): { p: V2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { p: { x: a.x + rx * t, z: a.z + rz * t }, t, u };
}

function bucketKeys(a: V2, b: V2): number[] {
  const i0 = Math.floor(Math.min(a.x, b.x) / BUCKET_M);
  const i1 = Math.floor(Math.max(a.x, b.x) / BUCKET_M);
  const j0 = Math.floor(Math.min(a.z, b.z) / BUCKET_M);
  const j1 = Math.floor(Math.max(a.z, b.z) / BUCKET_M);
  const out: number[] = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(j * 4096 + i);
  return out;
}
