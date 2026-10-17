import type { RailLineDef, RailStationDef } from './mapdef';
import { dist, type V2 } from './vec';

/**
 * 3.0 railway generation (V30_SPEC §10): every capital is linked to each city that lies nearer to
 * it than to any other capital, plus city–city links shorter than `cityLinkMaxM` (two per city at
 * most). One station per linked settlement, at its edge toward its first line. Lines are routed
 * on a 16 m grid with a strong grade penalty (gentle railway grades), avoid other settlements and
 * cross rivers only where they must. Pure geometry: it never draws from the map RNG, so adding
 * rails leaves every other part of a generated map as it was (apart from forests kept off the
 * track bed).
 */

export interface RailGenInput {
  readonly width: number;
  readonly depth: number;
  readonly capitals: readonly V2[];
  /** Map settlements in objective order (index = objective index). */
  readonly towns: readonly { readonly x: number; readonly z: number; readonly r: number; readonly kind: string }[];
  readonly slopeAt: (x: number, z: number) => number;
  readonly nearRiver: (p: V2) => number;
  readonly gridPath: (nx: number, nz: number, cell: number, cost: (i: number, j: number) => number, a: V2, b: V2) => V2[] | null;
  readonly smooth: (pts: V2[]) => V2[];
  readonly cityLinkMaxM: number;
}

export interface RailGenOutput {
  readonly rails: RailLineDef[];
  readonly stations: RailStationDef[];
}

/** Grid cell of the rail router (m). */
const RAIL_CELL = 16;
/** Grade above this (deg) is not laid; the cost of grade rises with its square below it. */
const MAX_GRADE_DEG = 16;
/** Capital radius used for its station offset (m, the capital town disc is 190 m). */
const CAPITAL_R = 190;
/** A capital without an own city links to its nearest town within this (m). */
const FALLBACK_TOWN_M = 1800;
/** Cities nearer than this to a capital count as its own (m). */
const OWN_CITY_MAX_M = 2600;
/** City–city links per city. */
const CITY_LINKS = 2;

export function generateRails(inp: RailGenInput): RailGenOutput {
  const caps = inp.capitals;
  const towns = inp.towns;
  // Settlement key: capital c → -1 - c; town k → k (its objective index).
  const posOf = (key: number): V2 => (key < 0 ? caps[-1 - key] : { x: towns[key].x, z: towns[key].z });
  const radiusOf = (key: number): number => (key < 0 ? CAPITAL_R : towns[key].r);
  const pairs: [number, number][] = [];
  const has = (a: number, b: number): boolean => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const nearestCap = (p: V2): { c: number; d: number } => {
    let best = { c: -1, d: Infinity };
    caps.forEach((c, i) => { const d = dist(c, p); if (d < best.d) best = { c: i, d }; });
    return best;
  };
  const cities = towns.map((t, k) => ({ t, k })).filter((x) => x.t.kind === 'city');
  for (let c = 0; c < caps.length; c++) {
    const own = cities.filter((x) => { const n = nearestCap(x.t); return n.c === c && n.d < OWN_CITY_MAX_M; });
    for (const x of own) pairs.push([-1 - c, x.k]);
    if (own.length === 0) {
      let best = -1;
      let bd = FALLBACK_TOWN_M;
      towns.forEach((t, k) => {
        if (t.kind !== 'town') return;
        const d = dist(t, caps[c]);
        if (d < bd && nearestCap(t).c === c) { bd = d; best = k; }
      });
      if (best >= 0) pairs.push([-1 - c, best]);
    }
  }
  for (const a of cities) {
    const near = cities.filter((b) => b.k !== a.k).map((b) => ({ k: b.k, d: dist(a.t, b.t) }))
      .filter((x) => x.d < inp.cityLinkMaxM).sort((x, y) => x.d - y.d || x.k - y.k).slice(0, CITY_LINKS);
    for (const b of near) if (!has(a.k, b.k)) pairs.push([Math.min(a.k, b.k), Math.max(a.k, b.k)]);
  }
  // Stations: one per settlement, at its edge toward the first line's far end.
  const stationOf = new Map<number, number>();
  const stations: RailStationDef[] = [];
  const station = (key: number, toward: V2): number => {
    const known = stationOf.get(key);
    if (known !== undefined) return known;
    const c = posOf(key);
    const d = dist(c, toward) || 1;
    const off = Math.min(radiusOf(key) * 0.85, d * 0.3);
    const pos = { x: c.x + ((toward.x - c.x) / d) * off, z: c.z + ((toward.z - c.z) / d) * off };
    const id = stations.length;
    stations.push({ pos, placeIdx: key });
    stationOf.set(key, id);
    return id;
  };
  const nx = Math.floor(inp.width / RAIL_CELL) + 1;
  const nz = Math.floor(inp.depth / RAIL_CELL) + 1;
  // Settlement key per router cell (NONE = open country): lines keep out of other settlements.
  const NONE = -1e6;
  const keyAt = new Float64Array(nx * nz).fill(NONE);
  const mark = (key: number): void => {
    const c = posOf(key);
    const r = radiusOf(key);
    for (let j = Math.max(0, Math.floor((c.z - r) / RAIL_CELL)); j <= Math.min(nz - 1, Math.ceil((c.z + r) / RAIL_CELL)); j++) {
      for (let i = Math.max(0, Math.floor((c.x - r) / RAIL_CELL)); i <= Math.min(nx - 1, Math.ceil((c.x + r) / RAIL_CELL)); i++) {
        if (Math.hypot(i * RAIL_CELL - c.x, j * RAIL_CELL - c.z) < r) keyAt[j * nx + i] = key;
      }
    }
  };
  towns.forEach((_, k) => mark(k));
  caps.forEach((_, c) => mark(-1 - c));
  // Grade and river cost per router cell, computed once on first use (shared by every line).
  const baseCost = new Float64Array(nx * nz).fill(NaN);
  const rails: RailLineDef[] = [];
  for (const [ka, kb] of pairs) {
    const a = station(ka, posOf(kb));
    const b = station(kb, posOf(ka));
    if (a === b) continue;
    const pa = stations[a].pos;
    const pb = stations[b].pos;
    const cost = (i: number, j: number): number => {
      const k = j * nx + i;
      let base = baseCost[k];
      if (Number.isNaN(base)) {
        const p = { x: i * RAIL_CELL, z: j * RAIL_CELL };
        const sl = inp.slopeAt(p.x, p.z);
        base = baseCost[k] = sl > MAX_GRADE_DEG ? Infinity : 1 + sl * sl * 0.08 + (inp.nearRiver(p) < 16 ? 20 : 0);
      }
      const key = keyAt[k];
      return base + (key !== NONE && key !== ka && key !== kb ? 12 : 0);
    };
    const path = inp.gridPath(nx, nz, RAIL_CELL, cost, pa, pb);
    const pts = path && path.length >= 2 ? [pa, ...path.slice(1, -1), pb] : [pa, pb];
    rails.push({ a, b, pts: inp.smooth(pts) });
  }
  return { rails, stations };
}
