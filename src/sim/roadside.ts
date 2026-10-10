import type { MapDef } from './mapdef';
import { Rng } from './rng';
import { Ground, type Building, type BuildingKind, type Tree } from './terrain';
import type { V2 } from './vec';

/**
 * 2.2 roadside buildings (V22_SPEC §12, user: "several single buildings distributed along the
 * roads so that infantry can find cover when shelled"). Farmsteads, barns, roadside inns, chapels
 * and sheds — and a few small farm clusters — stand along the road network between settlements.
 * They are ordinary map buildings (same list, raster, collision, shell / LOS blocking, garrison
 * cover and collapse as town houses) and are laid out once per terrain from the map seed, after
 * the ground is painted and the rivers carved, so the placement rules can read roads, water and
 * fords directly.
 */
export const ROADSIDE = {
  /** Candidate step along every road (jittered); most candidates are rejected by the rules below. */
  stepM: [30, 50] as const,
  /** Painted road half-width (terrain.paintGround) — footprints start beyond it. */
  roadHalfM: 8,
  /** Gap between the road edge and the near wall (uniform in range). */
  setbackM: [5, 11] as const,
  /** Every footprint keeps this clear of road / water / town ground (raster margin). */
  marginM: 3,
  /** Distance between two roadside sites (any roads), drawn per site so the spacing looks natural. */
  siteGapM: [150, 230] as const,
  /** A site only goes where no building (settlement or roadside) stands within this: fill the gaps. */
  coverGapM: 65,
  /** Keep clear of settlements: beyond the town radius plus this. */
  townClearM: 25,
  /** Keep clear of bridges, fords, mountain passes, objective / city points. */
  bridgeClearM: 80,
  fordClearM: 70,
  passClearM: 60,
  pointClearM: 50,
  /** Beyond an objective's capture radius (settlement objectives are already covered by townClearM). */
  objectiveClearM: 15,
  /** No water within this of the site centre (river banks stay open). */
  waterClearM: 18,
  /** Two roads within this of the site = a junction or crossing: keep it open. */
  junctionM: 55,
  /** Steepest ground (degrees) under a footprint. */
  maxSlopeDeg: 12,
  /** Woodland sites: forest cleared to open ground this far beyond the footprint radius. */
  clearingM: 8,
  /** Distance from the map edge. */
  edgeM: 60,
} as const;

/** A/B switch for headless comparisons (scripts set it before a match; the game leaves it on). */
export const ROADSIDE_AB = { enabled: true };

type RuralKind = 'farmhouse' | 'barn' | 'inn' | 'chapel' | 'shed' | 'farm';

/** Cumulative weights of the site types (a 'farm' is a 2–3 building cluster). */
const SITE_WEIGHTS: ReadonlyArray<readonly [RuralKind, number]> = [
  ['farmhouse', 0.3], ['barn', 0.16], ['inn', 0.1], ['chapel', 0.08], ['shed', 0.12], ['farm', 0.24],
];

interface Shape {
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly kind: BuildingKind;
}

/** Footprint (w along the road, d across it), height and sim/visual archetype of one building. */
function shapeOf(k: Exclude<RuralKind, 'farm'>, rng: Rng): Shape {
  switch (k) {
    case 'barn': return { w: rng.range(12, 16), d: rng.range(8, 10), h: rng.range(6.5, 8.5), kind: 'barn' };
    case 'inn': return { w: rng.range(12, 15), d: rng.range(8, 9.5), h: rng.range(7.5, 9), kind: 'house' };
    case 'chapel': return { w: rng.range(12, 14), d: rng.range(6.5, 7.5), h: rng.range(7, 8), kind: 'church' };
    case 'shed': return { w: rng.range(6.5, 8.5), d: rng.range(5, 6), h: rng.range(4.4, 5.2), kind: 'barn' };
    default: return { w: rng.range(8, 11), d: rng.range(6, 8), h: rng.range(5, 7), kind: 'house' };
  }
}

function pickKind(rng: Rng): RuralKind {
  let r = rng.next() * SITE_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of SITE_WEIGHTS) {
    r -= w;
    if (r < 0) return k;
  }
  return 'farmhouse';
}

/** The terrain queries the layout needs (Terrain implements them; tests may stub them). */
export interface RoadsideGround {
  readonly def: MapDef;
  readonly bridges: ReadonlyArray<{ readonly x: number; readonly z: number }>;
  readonly buildings: ReadonlyArray<Building>;
  readonly width: number;
  readonly depth: number;
  groundAt(x: number, z: number): Ground;
  slopeAt(x: number, z: number): number;
}

/** What placeRoadside writes: the building list, ground grid (woodland clearings) and trees. */
export interface RoadsideTerrain extends RoadsideGround {
  readonly buildings: Building[];
  readonly trees: Tree[];
  readonly ground: Uint8Array;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
}

function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t);
}

/** Roads passing within r of p (stops counting at 2). */
function roadsNear(def: MapDef, p: V2, r: number): number {
  let n = 0;
  for (const road of def.roads) {
    for (let s = 0; s < road.length - 1; s++) {
      if (segDist(p, road[s], road[s + 1]) < r) {
        n++;
        break;
      }
    }
    if (n >= 2) return n;
  }
  return n;
}

/** Fixed points to keep clear of: bridges, fords, passes, objectives and city points. */
function keepOut(t: RoadsideGround): Array<{ p: V2; r: number }> {
  const out: Array<{ p: V2; r: number }> = [];
  for (const b of t.bridges) out.push({ p: b, r: ROADSIDE.bridgeClearM });
  for (const rv of t.def.rivers) for (const f of rv.fords) out.push({ p: f, r: ROADSIDE.fordClearM });
  for (const f of t.def.features ?? []) if (f.kind === 'pass' || f.kind === 'bridge' || f.kind === 'ford') out.push({ p: f.pos, r: f.radius + ROADSIDE.passClearM });
  for (const o of t.def.objectives) out.push({ p: o.pos, r: (o.radius ?? 30) + ROADSIDE.objectiveClearM });
  for (const c of t.def.cities) for (const p of [c.hq, c.exit, c.truck]) out.push({ p, r: ROADSIDE.pointClearM });
  for (const tw of t.def.towns) out.push({ p: tw, r: tw.r + ROADSIDE.townClearM });
  return out;
}

/** Whole footprint (plus margin) on open / mud / wood ground (a clearing), gentle, dry, away from roads and towns. */
function footprintOk(t: RoadsideGround, b: Building): boolean {
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  const hw = b.w / 2 + ROADSIDE.marginM;
  const hd = b.d / 2 + ROADSIDE.marginM;
  for (let lx = -hw; lx <= hw + 0.01; lx += Math.max(1, (2 * hw) / Math.ceil(hw))) {
    for (let lz = -hd; lz <= hd + 0.01; lz += Math.max(1, (2 * hd) / Math.ceil(hd))) {
      // Inverse of the raster convention lx = dx cos − dz sin, lz = dx sin + dz cos.
      const x = b.x + lx * cs + lz * sn;
      const z = b.z - lx * sn + lz * cs;
      if (x < ROADSIDE.edgeM || z < ROADSIDE.edgeM || x > t.width - ROADSIDE.edgeM || z > t.depth - ROADSIDE.edgeM) return false;
      const g = t.groundAt(x, z);
      if (g !== Ground.Open && g !== Ground.Mud && g !== Ground.Forest) return false;
      if (t.slopeAt(x, z) > ROADSIDE.maxSlopeDeg) return false;
    }
  }
  return true;
}

function dryAround(t: RoadsideGround, p: V2): boolean {
  const r = ROADSIDE.waterClearM;
  for (let a = 0; a < 8; a++) {
    const g = t.groundAt(p.x + Math.cos((a * Math.PI) / 4) * r, p.z + Math.sin((a * Math.PI) / 4) * r);
    if (g === Ground.Water || g === Ground.Ford) return false;
  }
  return true;
}

const radius = (b: Building): number => Math.hypot(b.w, b.d) / 2;

/**
 * One site at road point `p` (road direction u, outward normal n): the main building facing the
 * road, and for a farm a barn beside it and maybe a shed behind. Null if any footprint fails.
 */
function site(t: RoadsideGround, rng: Rng, p: V2, u: V2, n: V2, kind: RuralKind): Building[] | null {
  const rot = -Math.atan2(u.z, u.x); // long side (w) along the road, see Terrain.rasterizeBuildings
  const at = (along: number, across: number, s: Shape, turn = 0): Building => ({
    x: p.x + u.x * along + n.x * across,
    z: p.z + u.z * along + n.z * across,
    w: s.w, d: s.d, h: s.h, rot: rot + turn, kind: s.kind,
  });
  const setback = rng.range(ROADSIDE.setbackM[0], ROADSIDE.setbackM[1]);
  const main = shapeOf(kind === 'farm' ? 'farmhouse' : kind, rng);
  const front = ROADSIDE.roadHalfM + setback;
  const out = [at(0, front + main.d / 2, main)];
  if (kind === 'farm') {
    // Barn end-on to the road beside the house (a yard between them), maybe a shed behind.
    const barn = shapeOf('barn', rng);
    const side = rng.chance(0.5) ? 1 : -1;
    out.push(at(side * (main.w / 2 + 7 + barn.d / 2), front + 2 + barn.w / 2, barn, Math.PI / 2));
    if (rng.chance(0.55)) {
      const shed = shapeOf('shed', rng);
      out.push(at(-side * rng.range(0, main.w / 3), front + main.d + 8 + shed.d / 2, shed));
    }
  }
  for (const b of out) if (!footprintOk(t, b)) return null;
  return out;
}

/** 64 m bucket grid of building centres, for "nearest building" during layout. */
class CentreGrid {
  private readonly cells = new Map<number, V2[]>();
  add(p: V2): void {
    const k = Math.floor(p.x / 64) * 4096 + Math.floor(p.z / 64);
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  /** Any centre within r of p. */
  any(p: V2, r: number): boolean {
    const i0 = Math.floor((p.x - r) / 64);
    const i1 = Math.floor((p.x + r) / 64);
    const j0 = Math.floor((p.z - r) / 64);
    const j1 = Math.floor((p.z + r) / 64);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const q of this.cells.get(i * 4096 + j) ?? []) if (Math.hypot(q.x - p.x, q.z - p.z) < r) return true;
    }
    return false;
  }
}

/**
 * Roadside buildings for terrain `t` (deterministic in the map seed). Walks every road in short
 * jittered steps and puts a site where the road has no building nearby (`coverGapM`) and no other
 * roadside site within 150–230 m, on a random side, when the placement rules hold: off the road,
 * clear of junctions, bridges, fords, passes, water, slopes and settlements.
 */
export function layoutRoadside(t: RoadsideGround): Building[] {
  if (!ROADSIDE_AB.enabled) return [];
  const rng = new Rng((t.def.seed ^ 0x40ad5) >>> 0);
  const keep = keepOut(t);
  const placed: Building[] = [];
  const near = new CentreGrid();
  for (const b of t.buildings) near.add(b);
  const sites: Array<{ p: V2; gap: number }> = [];
  for (const road of t.def.roads) {
    let next = rng.range(ROADSIDE.stepM[0], ROADSIDE.stepM[1]);
    let acc = 0;
    for (let s = 0; s < road.length - 1; s++) {
      const a = road[s];
      const b = road[s + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1) continue;
      const u = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
      for (; next <= acc + L; next += rng.range(ROADSIDE.stepM[0], ROADSIDE.stepM[1])) {
        const p = { x: a.x + u.x * (next - acc), z: a.z + u.z * (next - acc) };
        if (keep.some((k) => Math.hypot(k.p.x - p.x, k.p.z - p.z) < k.r)) continue;
        if (sites.some((q) => Math.hypot(q.p.x - p.x, q.p.z - p.z) < q.gap)) continue;
        if (near.any(p, ROADSIDE.coverGapM)) continue;
        if (roadsNear(t.def, p, ROADSIDE.junctionM) > 1) continue;
        const kind = pickKind(rng);
        const first = rng.chance(0.5) ? 1 : -1;
        for (const side of [first, -first]) {
          const got = site(t, rng, p, u, { x: -u.z * side, z: u.x * side }, kind);
          if (!got || !dryAround(t, got[0])) continue;
          if (got.some((g) => placed.some((o) => Math.hypot(o.x - g.x, o.z - g.z) < radius(o) + radius(g) + 4))) continue;
          placed.push(...got);
          for (const g of got) near.add(g);
          sites.push({ p, gap: rng.range(ROADSIDE.siteGapM[0], ROADSIDE.siteGapM[1]) });
          break;
        }
      }
      acc += L;
    }
  }
  return placed;
}

/**
 * Terrain hook (Terrain.scatterProps, before the building raster): add the roadside buildings; a
 * farm in a wood stands in its own clearing (forest cells around it become open ground and lose
 * their trees, so no tree grows through a roof and the yard is open).
 */
export function placeRoadside(t: RoadsideTerrain): void {
  const placed = layoutRoadside(t);
  if (!placed.length) return;
  t.buildings.push(...placed);
  for (const b of placed) {
    const r = Math.hypot(b.w, b.d) / 2 + ROADSIDE.clearingM;
    const i0 = Math.max(0, Math.floor((b.x - r) / t.cell));
    const i1 = Math.min(t.nx - 1, Math.ceil((b.x + r) / t.cell));
    const j0 = Math.max(0, Math.floor((b.z - r) / t.cell));
    const j1 = Math.min(t.nz - 1, Math.ceil((b.z + r) / t.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * t.nx + i;
      if (t.ground[k] === Ground.Forest && Math.hypot(i * t.cell - b.x, j * t.cell - b.z) <= r) t.ground[k] = Ground.Open;
    }
  }
  const kept = t.trees.filter((tr) => t.groundAt(tr.x, tr.z) === Ground.Forest);
  t.trees.splice(0, t.trees.length, ...kept);
}

/** Roadside sites are the buildings outside every settlement (for stats / tests). */
export function isRoadside(def: MapDef, b: Building): boolean {
  return !def.towns.some((tw) => Math.hypot(b.x - tw.x, b.z - tw.z) < tw.r + 12);
}

