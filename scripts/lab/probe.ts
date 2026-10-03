// Balance-lab probe: reads (never writes) the world once per game second and keeps the
// numbers the lab summarises. Everything here is observation only, so a lab run is the same
// deterministic match the game would play.
import type { UnitDef } from '../../src/data/types';
import type { Faction, Unit } from '../../src/sim/types';
import type { World } from '../../src/sim/world';

/** Sim functions the probe needs (loaded dynamically so the lab can target a source snapshot). */
export interface ProbeApi {
  populationCap(world: World, f: Faction): number;
  slotsFor(world: World, f: Faction, facility: string): number;
  normalizedWeights(world: World, f: Faction): Map<string, number>;
  canStart(world: World, f: Faction, def: UnitDef, manual: boolean, reserve?: { p: number; m: number }): string | null;
}

/** Why the automatic scheduler is not building more right now (one label per faction-second). */
export type Bind = 'pop' | 'slots' | 'resources' | 'free' | 'caps';
export const BINDS: readonly Bind[] = ['pop', 'slots', 'resources', 'free', 'caps'];

export type BindRow = Record<Bind, number> & { resM: number };

export interface FactionPoint {
  t: number;
  alive: boolean;
  pop: number; popCap: number;
  p: number; m: number; capP: number; capM: number;
  incP: number; incM: number;
  /** Cumulative P+M spent (trySpend), units lost, units produced, HP damage dealt. */
  spent: number; lost: number; produced: number; dmg: number;
  units: number; combat: number; value: number;
  held: number; village: number; town: number; city: number;
  /** Combat units with opRole occupy/garrison (territory directives). */
  occupyFrac: number;
  /** Size-weighted mean distance of each group (sector) centroid to the nearest capturable settlement. */
  groupDist: number;
  retreatFrac: number; firingFrac: number; hpFrac: number;
  slotsBusy: number;
  roles: Record<string, number>;
}

export interface CaptureEvent { t: number; id: string; kind: string; from: number; to: number }

export interface ProbeData {
  points: FactionPoint[][]; // [sample][faction]
  /** [faction][minute] → seconds per Bind label (+ `resM`: resource-short seconds where munitions, not manpower, were missing). */
  bind: BindRow[][];
  captures: CaptureEvent[];
  initialHeld: number[];
  settlements: number;
}

const COMBAT_EXCLUDE = new Set(['supply_truck']);
const isCombat = (u: Unit): boolean => u.hp > 0 && !u.fixed && !COMBAT_EXCLUDE.has(u.def.id);
const isSettlement = (kind: string): boolean => kind === 'village' || kind === 'town' || kind === 'city';

export function createProbe(world: World): ProbeData {
  const n = world.factions.length;
  return {
    points: [],
    bind: Array.from({ length: n }, () => []),
    captures: [],
    initialHeld: world.factions.map((f) => world.objectives.filter((o) => o.owner === f.id && isSettlement(o.kind)).length),
    settlements: world.objectives.filter((o) => isSettlement(o.kind)).length,
  };
}

function classify(world: World, f: Faction, api: ProbeApi): { bind: Bind; resM: boolean } {
  let resM = false;
  const bind = classifyInner(world, f, api, () => { resM = true; });
  return { bind, resM };
}

function classifyInner(world: World, f: Faction, api: ProbeApi, onMissingM: () => void): Bind {
  const weights = api.normalizedWeights(world, f);
  if (weights.size === 0) return 'caps';
  const defs = [...weights.keys()].map((id) => world.data.units.get(id)!);
  const pop = f.popPresent + f.popReserved;
  if (pop + Math.min(...defs.map((d) => d.population)) > api.populationCap(world, f)) return 'pop';
  let anyFree = false;
  let anyRes = false;
  for (const fac of new Set(defs.map((d) => d.facility))) {
    const busy = f.orders.filter((o) => o.facility === fac).length;
    if (busy >= api.slotsFor(world, f, fac)) continue;
    anyFree = true;
    for (const d of defs) {
      if (d.facility !== fac) continue;
      // Same reserve the scheduler applies while an expensive order is protected (production.ts).
      const prot = f.protectedOrder ? world.data.units.get(f.protectedOrder.unitId) : undefined;
      const reserve = prot && prot.id !== d.id ? { p: prot.costP, m: prot.costM } : { p: 0, m: 0 };
      const block = api.canStart(world, f, d, false, reserve);
      if (block === null) return 'free';
      if (block === 'INSUFFICIENT_P' || block === 'INSUFFICIENT_M' || block === 'PROTECTED') anyRes = true;
      if (block === 'INSUFFICIENT_M' || (block === 'PROTECTED' && f.m - reserve.m < d.costM)) onMissingM();
    }
  }
  if (!anyFree) return 'slots';
  return anyRes ? 'resources' : 'pop';
}

/** Call once per game second (after `step`). */
export function probeSecond(world: World, data: ProbeData, api: ProbeApi, prevOwners: Map<string, number>): void {
  const minute = Math.floor(world.time / 60);
  for (const f of world.factions) {
    if (!f.alive) continue;
    const row = (data.bind[f.id][minute] ??= { pop: 0, slots: 0, resources: 0, free: 0, caps: 0, resM: 0 });
    const c = classify(world, f, api);
    row[c.bind]++;
    if (c.bind === 'resources' && c.resM) row.resM++;
  }
  for (const o of world.objectives) {
    const prev = prevOwners.get(o.id);
    if (prev !== undefined && prev !== o.owner && o.owner >= 0) data.captures.push({ t: world.time, id: o.id, kind: o.kind, from: prev, to: o.owner });
    prevOwners.set(o.id, o.owner);
  }
}

function groupDistance(world: World, f: Faction, units: Unit[]): number {
  const targets = world.objectives.filter((o) => isSettlement(o.kind) && o.owner !== f.id && (o.owner < 0 || world.isHostile(f.id, o.owner)));
  if (targets.length === 0 || units.length === 0) return 0;
  const groups = new Map<number, { x: number; z: number; n: number }>();
  for (const u of units) {
    const g = groups.get(u.sectorId) ?? { x: 0, z: 0, n: 0 };
    g.x += u.pos.x;
    g.z += u.pos.z;
    g.n++;
    groups.set(u.sectorId, g);
  }
  let sum = 0;
  let n = 0;
  for (const g of groups.values()) {
    const cx = g.x / g.n;
    const cz = g.z / g.n;
    const d = Math.min(...targets.map((o) => Math.hypot(o.pos.x - cx, o.pos.z - cz)));
    sum += d * g.n;
    n += g.n;
  }
  return n > 0 ? sum / n : 0;
}

/** Snapshot every STATS-like interval (the lab uses 30 s). */
export function probeSample(world: World, data: ProbeData, api: ProbeApi, lastBusy: number[]): void {
  const e = world.data.rules.economy;
  const byOwner: Unit[][] = world.factions.map(() => []);
  const all: Unit[][] = world.factions.map(() => []);
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed) continue;
    all[u.owner]?.push(u);
    if (isCombat(u)) byOwner[u.owner]?.push(u);
  }
  data.points.push(world.factions.map((f) => {
    const combat = byOwner[f.id];
    const roles: Record<string, number> = {};
    let occ = 0, retreat = 0, firing = 0, hp = 0;
    for (const u of combat) {
      roles[u.opRole] = (roles[u.opRole] ?? 0) + 1;
      if (u.opRole === 'occupy' || u.opRole === 'garrison') occ++;
      if (u.behavior === 'retreat' || u.behavior === 'recover' || u.behavior === 'routing') retreat++;
      if (world.time - u.lastFiredAt < 5) firing++;
      hp += u.hp / u.def.maxHp;
    }
    const held = world.objectives.filter((o) => o.owner === f.id && isSettlement(o.kind));
    const dmg = Object.values(world.stats.byType[f.id] ?? {}).reduce((s, r) => s + r.dmgDealt, 0);
    const nC = Math.max(1, combat.length);
    return {
      t: world.time, alive: f.alive,
      pop: f.popPresent + f.popReserved, popCap: api.populationCap(world, f),
      p: f.p, m: f.m, capP: e.cap_p, capM: e.cap_m, incP: f.incomeP, incM: f.incomeM,
      spent: f.spentTotalP + f.spentTotalM, lost: f.lostUnits, produced: f.producedUnits, dmg,
      units: all[f.id].length, combat: combat.length, value: all[f.id].reduce((s, u) => s + u.def.costP + u.def.costM, 0),
      held: held.length, village: held.filter((o) => o.kind === 'village').length,
      town: held.filter((o) => o.kind === 'town').length, city: held.filter((o) => o.kind === 'city').length,
      occupyFrac: occ / nC, groupDist: groupDistance(world, f, combat),
      retreatFrac: retreat / nC, firingFrac: firing / nC, hpFrac: hp / nC,
      slotsBusy: lastBusy[f.id] ?? 0, roles,
    };
  }));
}

/** Production-slot occupancy right now (orders / slots over all facilities). */
export function slotOccupancy(world: World, f: Faction, api: ProbeApi): number {
  let busy = 0;
  let slots = 0;
  for (const fac of ['barracks', 'vehicle', 'support']) {
    slots += api.slotsFor(world, f, fac);
    busy += f.orders.filter((o) => o.facility === fac).length;
  }
  return slots > 0 ? busy / slots : 0;
}
