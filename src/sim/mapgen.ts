import type { CityDef, MapDef, MapFeature, ObjectiveDef, RiverDef } from './mapdef';
import { NameGen } from './names';
import { ValueNoise } from './noise';
import { Rng } from './rng';
import { clamp, dist, type V2 } from './vec';

export type MapSize = 'medium' | 'large';

export interface GenOptions {
  readonly seed: number;
  readonly factions: number;
  readonly size: MapSize;
}

const CELL = 4;

/** Generic 8-neighbour A* on a coarse grid. Returns cell centres or null. */
function gridPath(nx: number, nz: number, cell: number, cost: (i: number, j: number) => number, a: V2, b: V2): V2[] | null {
  const si = clamp(Math.round(a.x / cell), 0, nx - 1) + clamp(Math.round(a.z / cell), 0, nz - 1) * nx;
  const gi = clamp(Math.round(b.x / cell), 0, nx - 1) + clamp(Math.round(b.z / cell), 0, nz - 1) * nx;
  const g = new Float64Array(nx * nz).fill(Infinity);
  const from = new Int32Array(nx * nz).fill(-1);
  const heapK: number[] = [si];
  const heapF: number[] = [0];
  const push = (k: number, f: number): void => {
    let i = heapK.length;
    heapK.push(k);
    heapF.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapK[i] = heapK[p];
      heapF[i] = heapF[p];
      i = p;
    }
    heapK[i] = k;
    heapF[i] = f;
  };
  const pop = (): number => {
    const top = heapK[0];
    const lk = heapK.pop()!;
    const lf = heapF.pop()!;
    if (heapK.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heapK.length) break;
        const r = l + 1;
        const c = r < heapK.length && heapF[r] < heapF[l] ? r : l;
        if (heapF[c] >= lf) break;
        heapK[i] = heapK[c];
        heapF[i] = heapF[c];
        i = c;
      }
      heapK[i] = lk;
      heapF[i] = lf;
    }
    return top;
  };
  const closed = new Uint8Array(nx * nz);
  g[si] = 0;
  const gx = gi % nx;
  const gz = Math.floor(gi / nx);
  while (heapK.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === gi) break;
    const ci = cur % nx;
    const cj = Math.floor(cur / nx);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const c = cost(ni, nj);
        if (!Number.isFinite(c)) continue;
        const k = nj * nx + ni;
        const ng = g[cur] + c * (di && dj ? 1.4142 : 1);
        if (ng >= g[k]) continue;
        g[k] = ng;
        from[k] = cur;
        push(k, ng + Math.hypot(ni - gx, nj - gz) * 0.9);
      }
    }
  }
  if (from[gi] < 0 && gi !== si) return null;
  const out: V2[] = [];
  for (let k = gi; k !== -1; k = from[k]) out.push({ x: (k % nx) * cell, z: Math.floor(k / nx) * cell });
  return out.reverse();
}

/** Ramer–Douglas–Peucker simplification. */
function simplify(pts: V2[], eps: number): V2[] {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let idx = -1;
  let best = 0;
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.abs((b.x - a.x) * (a.z - p.z) - (a.x - p.x) * (b.z - a.z)) / L;
    if (d > best) {
      best = d;
      idx = i;
    }
  }
  if (best <= eps) return [a, b];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

/** Chaikin corner cutting for natural river curves. */
function chaikin(pts: V2[], iters: number): V2[] {
  let p = pts;
  for (let k = 0; k < iters; k++) {
    const out: V2[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

function distToPolyline(p: V2, pts: V2[]): { d: number; i: number; t: number } {
  let best = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const l2 = vx * vx + vz * vz || 1;
    const t = clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / l2, 0, 1);
    const d = Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
    if (d < best.d) best = { d, i, t };
  }
  return best;
}

interface Range {
  spine: V2[];
  h: number;
  w: number;
  passes: V2[];
}

/**
 * Procedural battlefield: mountain ranges with passes, rivers that follow valleys,
 * towns on flat ground (often by rivers), capitals per faction, road network, forests.
 * Deterministic for a given seed.
 */
export function generateMap(opt: GenOptions): MapDef {
  const rng = new Rng(opt.seed * 7919 + 13);
  const noise = new ValueNoise(opt.seed);
  const ridgeNoise = new ValueNoise(opt.seed + 101);
  const names = new NameGen(new Rng(opt.seed + 77));
  const n = clamp(opt.factions, 2, 4);
  const scale = opt.size === 'large' ? 1.3 : 1;
  const W = Math.round((n === 2 ? 2400 : 2600) * scale / 8) * 8;
  const D = Math.round((n === 2 ? 1600 : 2600) * scale / 8) * 8;
  const cx = W / 2;
  const cz = D / 2;

  // --- capitals ---
  const capitals: V2[] = [];
  if (n === 2) {
    const off = rng.range(-0.12, 0.12) * D;
    capitals.push({ x: 230, z: cz + off }, { x: W - 230, z: cz - off });
  } else {
    const R = Math.min(W, D) * 0.38;
    const a0 = rng.range(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      capitals.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R });
    }
  }
  const nearCapital = (p: V2, r: number): boolean => capitals.some((c) => dist(c, p) < r);

  // --- mountain ranges ---
  const ranges: Range[] = [];
  const wantRanges = n === 2 ? 2 + (rng.chance(0.5) ? 1 : 0) : 3 + (rng.chance(0.5) ? 1 : 0);
  for (let tries = 0; tries < 200 && ranges.length < wantRanges; tries++) {
    const start = { x: rng.range(0.1, 0.9) * W, z: rng.range(0.1, 0.9) * D };
    const ang = rng.range(0, Math.PI * 2);
    const len = rng.range(500, 1100) * scale;
    const spine: V2[] = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      const wob = rng.range(-90, 90);
      spine.push({ x: start.x + Math.cos(ang) * len * t - Math.sin(ang) * wob, z: start.z + Math.sin(ang) * len * t + Math.cos(ang) * wob });
    }
    if (spine.some((p) => nearCapital(p, 420) || p.x < 60 || p.z < 60 || p.x > W - 60 || p.z > D - 60)) continue;
    if (ranges.some((r) => r.spine.some((a) => spine.some((b) => dist(a, b) < 380)))) continue;
    const passes: V2[] = [];
    const np = 1 + (rng.chance(0.6) ? 1 : 0);
    for (let k = 0; k < np; k++) {
      const s = 1 + Math.floor(rng.next() * 3);
      passes.push({ x: (spine[s].x + spine[s + 1].x) / 2, z: (spine[s].z + spine[s + 1].z) / 2 });
    }
    ranges.push({ spine, h: rng.range(85, 135), w: rng.range(150, 220) * scale, passes });
  }
  const hills: { x: number; z: number; r: number; h: number }[] = [];
  const wantHills = Math.round((W * D) / 380000);
  for (let tries = 0; tries < 300 && hills.length < wantHills; tries++) {
    const p = { x: rng.range(0.06, 0.94) * W, z: rng.range(0.06, 0.94) * D };
    if (nearCapital(p, 260)) continue;
    hills.push({ x: p.x, z: p.z, r: rng.range(70, 160), h: rng.range(14, 45) });
  }

  // --- heightfield ---
  const nx = Math.floor(W / CELL) + 1;
  const nz = Math.floor(D / CELL) + 1;
  const H = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * CELL;
      const z = j * CELL;
      let h = 14 + 22 * (noise.fbm(x / 800, z / 800, 3) - 0.5) * 2 + 7 * (noise.fbm(x / 160 + 9, z / 160 + 3, 2) - 0.5);
      for (const r of ranges) {
        const q = distToPolyline({ x, z }, r.spine);
        if (q.d > r.w * 2.2) continue;
        const tAlong = (q.i + q.t) / (r.spine.length - 1);
        const endFade = clamp(Math.min(tAlong, 1 - tAlong) * 5 + 0.15, 0, 1);
        const ridged = 0.45 + 0.55 * (1 - Math.abs(2 * ridgeNoise.fbm(x / 120, z / 120, 4) - 1));
        let contrib = r.h * ridged * Math.exp(-((q.d / r.w) ** 2) * 2.2) * endFade;
        for (const ps of r.passes) contrib *= 1 - 0.8 * Math.exp(-((dist(ps, { x, z }) / 85) ** 2));
        h += contrib;
      }
      for (const hl of hills) {
        const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
        if (d2 < 9) h += hl.h * Math.exp(-d2 * 2.2);
      }
      // Capitals sit on gentle ground.
      for (const c of capitals) {
        const d = dist(c, { x, z });
        if (d < 300) {
          const w = clamp(1.2 - d / 300, 0, 1);
          h = h * (1 - w * 0.8) + 16 * w * 0.8;
        }
      }
      H[j * nx + i] = Math.max(0, h);
    }
  }
  const hAt = (x: number, z: number): number => H[clamp(Math.round(z / CELL), 0, nz - 1) * nx + clamp(Math.round(x / CELL), 0, nx - 1)];

  // --- rivers: valley-following paths edge to edge ---
  const rivers: RiverDef[] = [];
  const features: MapFeature[] = [];
  const wantRivers = n === 2 ? 2 : 2 + (rng.chance(0.5) ? 1 : 0);
  const riverSamples: V2[][] = [];
  const RC = 24;
  const rnx = Math.floor(W / RC) + 1;
  const rnz = Math.floor(D / RC) + 1;
  const edgePoint = (side: number, t: number): V2 =>
    side === 0 ? { x: t * W, z: 0 } : side === 1 ? { x: W, z: t * D } : side === 2 ? { x: t * W, z: D } : { x: 0, z: t * D };
  for (let tries = 0; tries < 30 && rivers.length < wantRivers; tries++) {
    const s0 = Math.floor(rng.next() * 4);
    const s1 = (s0 + 2) % 4;
    const a = edgePoint(s0, rng.range(0.15, 0.85));
    const b = edgePoint(s1, rng.range(0.15, 0.85));
    const path = gridPath(rnx, rnz, RC, (i, j) => {
      const x = i * RC;
      const z = j * RC;
      if (nearCapital({ x, z }, 280)) return Infinity;
      for (const rv of riverSamples) for (const q of rv) if (Math.abs(q.x - x) < 220 && Math.abs(q.z - z) < 220) return 40;
      return 1 + hAt(x, z) * 0.12 + noise.sample(x / 150 + 50, z / 150) * 3;
    }, a, b);
    if (!path) continue;
    const pts = chaikin(simplify(path, 18), 3);
    // Downhill surface: running minimum from the higher end.
    const flip = hAt(pts[0].x, pts[0].z) < hAt(pts[pts.length - 1].x, pts[pts.length - 1].z);
    const ordered = flip ? [...pts].reverse() : pts;
    const surf: number[] = [];
    let run = Infinity;
    for (const p of ordered) {
      run = Math.min(run, hAt(p.x, p.z));
      surf.push(run);
    }
    // Carve a valley toward the surface so the river reads as lying in low ground.
    const bestD = new Float32Array(nx * nz).fill(Infinity);
    const bestS = new Float32Array(nx * nz);
    const R = 140;
    for (let s = 0; s < ordered.length - 1; s++) {
      const p0 = ordered[s];
      const p1 = ordered[s + 1];
      const steps = Math.max(1, Math.ceil(dist(p0, p1) / 8));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = p0.x + (p1.x - p0.x) * t;
        const pz = p0.z + (p1.z - p0.z) * t;
        const sv = surf[s] + (surf[s + 1] - surf[s]) * t;
        const i0 = Math.max(0, Math.floor((px - R) / CELL));
        const i1 = Math.min(nx - 1, Math.ceil((px + R) / CELL));
        const j0 = Math.max(0, Math.floor((pz - R) / CELL));
        const j1 = Math.min(nz - 1, Math.ceil((pz + R) / CELL));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(i * CELL - px, j * CELL - pz);
            const idx = j * nx + i;
            if (d < bestD[idx]) {
              bestD[idx] = d;
              bestS[idx] = sv;
            }
          }
        }
      }
    }
    for (let k = 0; k < H.length; k++) {
      if (bestD[k] > R) continue;
      const w = Math.exp(-((bestD[k] / 80) ** 2));
      H[k] = Math.min(H[k], H[k] * (1 - w) + (bestS[k] + 3) * w);
    }
    const fords: V2[] = [];
    const nf = 1 + (rng.chance(0.5) ? 1 : 0);
    for (let k = 0; k < nf; k++) {
      const p = ordered[Math.floor(rng.range(0.25, 0.75) * ordered.length)];
      if (!nearCapital(p, 350)) fords.push(p);
    }
    rivers.push({ points: ordered, width: rng.range(20, 30), fords });
    riverSamples.push(ordered.filter((_, i) => i % 6 === 0));
    features.push({ kind: 'river', name: names.river(), pos: ordered[Math.floor(ordered.length * 0.4)], radius: 60 });
    for (const f of fords) features.push({ kind: 'ford', name: { zh: '浅滩', en: 'Ford' }, pos: f, radius: 20 });
  }
  // Raster of distance-to-river (16 m cells, capped at 400 m) so later queries are O(1).
  const RQ = 16;
  const qnx = Math.floor(W / RQ) + 1;
  const qnz = Math.floor(D / RQ) + 1;
  const riverDist = new Float32Array(qnx * qnz).fill(400);
  for (const r of rivers) {
    for (let s = 0; s < r.points.length - 1; s++) {
      const p0 = r.points[s];
      const p1 = r.points[s + 1];
      const steps = Math.max(1, Math.ceil(dist(p0, p1) / 8));
      for (let k = 0; k <= steps; k++) {
        const px = p0.x + ((p1.x - p0.x) * k) / steps;
        const pz = p0.z + ((p1.z - p0.z) * k) / steps;
        const R = 400;
        const i0 = Math.max(0, Math.floor((px - R) / RQ));
        const i1 = Math.min(qnx - 1, Math.ceil((px + R) / RQ));
        const j0 = Math.max(0, Math.floor((pz - R) / RQ));
        const j1 = Math.min(qnz - 1, Math.ceil((pz + R) / RQ));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(i * RQ - px, j * RQ - pz);
          const idx = j * qnx + i;
          if (d < riverDist[idx]) riverDist[idx] = d;
        }
      }
    }
  }
  const nearRiver = (p: V2): number => riverDist[clamp(Math.round(p.z / RQ), 0, qnz - 1) * qnx + clamp(Math.round(p.x / RQ), 0, qnx - 1)];

  // --- towns ---
  const slopeAt = (x: number, z: number): number => {
    const e = 24;
    return (Math.atan(Math.hypot(hAt(x + e, z) - hAt(x - e, z), hAt(x, z + e) - hAt(x, z - e)) / (2 * e)) * 180) / Math.PI;
  };
  // Settlement tiers (user: "far more villages; some cities with high towers; towns with far more houses").
  type Kind = 'village' | 'town' | 'city';
  const towns: { x: number; z: number; r: number; buildings: number; big: boolean; kind: Kind; name: { zh: string; en: string } }[] = [];
  const wantTowns = Math.round((W * D) / 110000);
  const cands: { p: V2; s: number }[] = [];
  for (let z = 120; z < D - 120; z += 40) {
    for (let x = 120; x < W - 120; x += 40) {
      const p = { x: x + rng.range(-12, 12), z: z + rng.range(-12, 12) };
      if (nearCapital(p, 400)) continue;
      const sl = Math.max(slopeAt(p.x, p.z), slopeAt(p.x + 40, p.z), slopeAt(p.x - 40, p.z), slopeAt(p.x, p.z + 40), slopeAt(p.x, p.z - 40));
      if (sl > 8) continue;
      const dr = nearRiver(p);
      if (dr < 70) continue;
      const s = rng.next() + (dr < 220 ? 0.8 : 0) - sl * 0.05 - hAt(p.x, p.z) * 0.004;
      cands.push({ p, s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  for (const c of cands) {
    if (towns.length >= wantTowns) break;
    const roll = rng.next();
    const kind: Kind = roll < 0.1 ? 'city' : roll < 0.35 ? 'town' : 'village';
    const r = kind === 'city' ? 150 : kind === 'town' ? 95 : 48;
    if (towns.some((t) => dist(t, c.p) < t.r + r + 70)) continue;
    const buildings = kind === 'city' ? 220 : kind === 'town' ? 90 : 18 + Math.floor(rng.next() * 18);
    towns.push({ x: c.p.x, z: c.p.z, r, buildings, big: kind !== 'village', kind, name: kind === 'city' ? names.city() : names.town(kind === 'town') });
  }

  // --- objectives: contested towns between capitals + one observation height ---
  const wantObj = Math.min(towns.length, 2 * n + 1);
  const contest = (p: V2): number => {
    const ds = capitals.map((c) => dist(c, p)).sort((a, b) => a - b);
    return -Math.abs(ds[0] - ds[1]) / 100 - Math.max(0, ds[0] - 900) / 300;
  };
  // Objectives prefer towns and cities (villages only if needed).
  const objTowns = [...towns].sort((a, b) => contest(b) + (b.kind !== 'village' ? 0.8 : 0) - contest(a) - (a.kind !== 'village' ? 0.8 : 0)).slice(0, wantObj);
  const strategicSet = new Set(objTowns);
  // Every settlement is a capturable place; the most contested ones are strategic (majority bleed).
  const objectives: ObjectiveDef[] = towns.map((t, k) => ({
    id: `obj_${k}`, type: k % 2 === 0 ? 'industry' : 'manpower', pos: { x: t.x, z: t.z }, name: t.name,
    kind: t.kind, strategic: strategicSet.has(t), radius: Math.max(30, Math.min(70, t.r * 0.55)),
  }));
  const centralHill = [...hills].sort((a, b) => dist(a, { x: cx, z: cz }) - dist(b, { x: cx, z: cz }))[0];
  if (centralHill && !objectives.some((o) => dist(o.pos, centralHill) < 250)) {
    const nm = names.hill();
    objectives.push({ id: `obj_${objectives.length}`, type: 'observation', pos: { x: centralHill.x, z: centralHill.z }, name: nm, kind: 'point', strategic: true, radius: 30 });
    features.push({ kind: 'hill', name: nm, pos: { x: centralHill.x, z: centralHill.z }, radius: centralHill.r });
  }

  // --- roads: MST + extra links between capitals and towns, routed over terrain ---
  const cityNames = capitals.map(() => names.city());
  const nodes: V2[] = [...capitals, ...towns.map((t) => ({ x: t.x, z: t.z }))];
  const edges = new Set<string>();
  const inTree = new Set<number>([0]);
  while (inTree.size < nodes.length) {
    let best: [number, number, number] = [-1, -1, Infinity];
    for (const a of inTree) for (let b = 0; b < nodes.length; b++) {
      if (inTree.has(b)) continue;
      const d = dist(nodes[a], nodes[b]);
      if (d < best[2]) best = [a, b, d];
    }
    inTree.add(best[1]);
    edges.add(`${Math.min(best[0], best[1])}-${Math.max(best[0], best[1])}`);
  }
  nodes.forEach((p, a) => {
    const near = nodes.map((q, b) => ({ b, d: dist(p, q) })).filter((x) => x.b !== a).sort((x, y) => x.d - y.d).slice(0, 2);
    for (const x of near) if (x.d < 900) edges.add(`${Math.min(a, x.b)}-${Math.max(a, x.b)}`);
  });
  const RD = 16;
  const dnx = Math.floor(W / RD) + 1;
  const dnz = Math.floor(D / RD) + 1;
  const roads: V2[][] = [];
  for (const e of edges) {
    const [a, b] = e.split('-').map(Number);
    const path = gridPath(dnx, dnz, RD, (i, j) => {
      const x = i * RD;
      const z = j * RD;
      const sl = slopeAt(x, z);
      if (sl > 22) return Infinity;
      const water = nearRiver({ x, z }) < 16 ? 30 : 0;
      return 1 + sl * sl * 0.03 + water;
    }, nodes[a], nodes[b]);
    if (path) roads.push(simplify(path, 10));
  }

  const roadMask = new Uint8Array(qnx * qnz);
  for (const r of roads) for (let s = 0; s < r.length - 1; s++) {
    const steps = Math.max(1, Math.ceil(dist(r[s], r[s + 1]) / 8));
    for (let k = 0; k <= steps; k++) {
      const px = r[s].x + ((r[s + 1].x - r[s].x) * k) / steps;
      const pz = r[s].z + ((r[s + 1].z - r[s].z) * k) / steps;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = clamp(Math.round(px / RQ) + di, 0, qnx - 1);
        const j = clamp(Math.round(pz / RQ) + dj, 0, qnz - 1);
        roadMask[j * qnx + i] = 1;
      }
    }
  }

  // --- forests ---
  const forests: { x: number; z: number; r: number }[] = [];
  const fnoise = new ValueNoise(opt.seed + 404);
  for (let z = 40; z < D - 40; z += 34) {
    for (let x = 40; x < W - 40; x += 34) {
      const v = fnoise.fbm(x / 300, z / 300, 3);
      if (v < 0.58) continue;
      const p = { x: x + rng.range(-10, 10), z: z + rng.range(-10, 10) };
      if (nearCapital(p, 260) || nearRiver(p) < 30 || slopeAt(p.x, p.z) > 26) continue;
      if (towns.some((t) => dist(t, p) < t.r + 25)) continue;
      if (roadMask[clamp(Math.round(p.z / RQ), 0, qnz - 1) * qnx + clamp(Math.round(p.x / RQ), 0, qnx - 1)]) continue;
      forests.push({ x: p.x, z: p.z, r: 24 });
    }
  }
  // Name a few of the densest forest areas.
  for (let k = 0; k < 4 && forests.length > 0; k++) {
    const f = forests[Math.floor(rng.next() * forests.length)];
    const count = forests.filter((g) => dist(g, f) < 150).length;
    if (count > 10 && !features.some((x) => x.kind === 'forest' && dist(x.pos, f) < 400)) features.push({ kind: 'forest', name: names.forest(), pos: f, radius: 150 });
  }
  const mud = rivers.flatMap((r) => [r.points[Math.floor(r.points.length * 0.3)], r.points[Math.floor(r.points.length * 0.7)]])
    .filter((p) => !nearCapital(p, 300)).map((p) => ({ x: p.x + 40, z: p.z + 30, r: 26 }));

  // --- features: mountains, passes, towns, capitals ---
  for (const r of ranges) {
    let peak = r.spine[0];
    let ph = -1;
    for (const p of r.spine) if (hAt(p.x, p.z) > ph) { ph = hAt(p.x, p.z); peak = p; }
    features.push({ kind: 'mountain', name: names.mountain(), pos: peak, radius: r.w });
    for (const ps of r.passes) features.push({ kind: 'pass', name: names.pass(), pos: ps, radius: 60 });
  }
  for (const h of hills) if (h.h > 30 && !features.some((f) => f.kind === 'hill' && dist(f.pos, h) < 200)) features.push({ kind: 'hill', name: names.hill(), pos: { x: h.x, z: h.z }, radius: h.r });
  for (const t of towns) features.push({ kind: t.kind === 'village' ? 'town' : t.kind === 'town' ? 'town' : 'city', name: t.name, pos: { x: t.x, z: t.z }, radius: t.r });

  // --- capitals as cities ---
  const cities: CityDef[] = capitals.map((c, k) => {
    const toward = Math.atan2(cz - c.z, cx - c.x);
    const fx = Math.cos(toward);
    const fz = Math.sin(toward);
    const at = (d: number, side = 0): V2 => ({ x: c.x + fx * d - fz * side, z: c.z + fz * d + fx * side });
    // Air entry: the map edge behind the capital.
    const back = { x: clamp(c.x - fx * 2000, 0, W), z: clamp(c.z - fz * 2000, 0, D) };
    features.push({ kind: 'city', name: cityNames[k], pos: c, radius: 150 });
    return {
      name: cityNames[k], hq: c, exit: at(70), truck: at(190),
      vanguard: [at(330, -70), at(330, 0), at(330, 70)], recon: at(300, -120),
      strongpoints: [{ pos: at(110, -60), facingDeg: (toward * 180) / Math.PI }, { pos: at(110, 60), facingDeg: (toward * 180) / Math.PI }],
      forwardDeg: (toward * 180) / Math.PI, airEntry: back,
    };
  });
  const capitalTowns = capitals.map((c) => ({ x: c.x, z: c.z, r: 190, buildings: 320, kind: 'capital' as const }));

  return {
    id: `gen_${opt.seed}_${n}_${opt.size}`,
    name: { zh: `生成战场 #${opt.seed}`, en: `Generated front #${opt.seed}` },
    width: W, depth: D, seed: opt.seed, baseHeight: 0, noiseAmp: 0,
    hills: [], ridges: [], roads, forests,
    towns: [...capitalTowns, ...towns.map((t) => ({ x: t.x, z: t.z, r: t.r, buildings: t.buildings, kind: t.kind }))],
    mud, rivers, cities, objectives, features, heightfield: H,
  };
}
