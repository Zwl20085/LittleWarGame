import { econRules } from './econ';
import { boundOrder } from './frontref';
import { selectTarget } from './combat';
import { moveTo, stop } from './movement';
import { isCommander } from './formulas';
import type { Faction, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 economic war, AI side (V22_SPEC §5): small raiding / infiltration parties (2–4 squads of
 * recon, infantry, motor infantry and engineers, a light tank against a defended target) slip
 * behind the lines to demolish enemy economic buildings (econ.econSecond demolishes for units with
 * the `raid` role). Targets are chosen by value and weak defence near our front; one party per
 * faction at a time, called home when half of it is lost or its time is up — a real but bounded
 * cost. The defence side (garrisons for towns with buildings) is command.ts `assignGarrisons`
 * with `econWorth` priority; the investment side is econai.ts.
 */
export const ECON_WAR = {
  /** First raid not before this, then one launch attempt every everyS while no party is out. */
  firstS: 300,
  everyS: 120,
  /** Party size bounds (squads). */
  partyMin: 2,
  partyMax: 4,
  /** A target lies within rangeM of our front line … */
  rangeM: 1500,
  /** … and its known defence within defR is at most maxDefence × the party's value. */
  defR: 300,
  maxDefence: 1.2,
  /** The way in: known enemy within corridorR of every corridorStepM along it, at most maxCorridor × the party. */
  corridorR: 100,
  corridorStepM: 150,
  maxCorridor: 3,
  /** Known defence above this adds a light tank (if one is free near the gap). */
  tankDefence: 120,
  /** Pool: free line squads within poolR of the front cell nearest the target. */
  poolR: 900,
  /** The party moves together: a member more than packM ahead of the rearmost one waits. */
  packM: 70,
  /** … but not for one more than laggardM behind. */
  laggardM: 200,
  /** Party time budget (s); abort when fewer than abortShare of it are left. */
  maxS: 420,
  abortShare: 0.5,
  /** A raider looks for the next building within nextR once its target is down. */
  nextR: 450,
  /** Army fullness below this: no raids (every squad is needed at the front). */
  minFullness: 0.45,
} as const;

/** Lab counters: why a launch attempt did not happen (read by scripts/lab). */
export const ECON_WAR_STATS: Record<string, number> = {};
const why = (k: string): void => { ECON_WAR_STATS[k] = (ECON_WAR_STATS[k] ?? 0) + 1; };

/** A/B switch for the lab (`ECON_WAR_AB.raids = false` = wave-1: no economic raids). */
export const ECON_WAR_AB = { raids: true };

const RAIDER_IDS = new Set(['recon', 'infantry', 'motor_inf', 'engineer']);
const KIND_VALUE: Record<string, number> = { factory: 1, recruit: 0.9, depot: 0.75, ezone1: 0.6, ezone2: 0.95, ezone3: 1.3 };

/** What a raid can target: a 2.2 economic building or (3.0) an economic zone (econZones.ts). */
export interface Raidable {
  readonly id: number;
  readonly kind: string;
  readonly pos: V2;
  readonly owner: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly progress: number;
  readonly ruined: boolean;
  readonly placeId?: string;
}

const raidables = (world: World): Raidable[] => (world.econZones.length ? [...world.econ, ...world.econZones] : world.econ);

interface Party { readonly target: number; readonly ids: number[]; readonly until: number }
const parties = new WeakMap<Faction, Party>();
const nextAt = new WeakMap<Faction, number>();

export const econTag = (b: Raidable): string => `econ:${b.id}`;
const tagId = (tag: string | null): number => (tag && tag.startsWith('econ:') ? Number(tag.slice(5)) : -1);

const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

/** Known hostile (to `f`) combat value within r of p. */
function knownDefence(world: World, f: number, p: V2, r: number): number {
  let v = 0;
  for (const u of world.spatial.query(p.x, p.z, r)) {
    if (u.hp > 0 && u.primary && !isCommander(u.def) && u.def.id !== 'supply_truck' && world.isHostile(f, u.owner) && world.knows(f, u)) v += valueOf(u);
  }
  return v;
}

/** Known hostile value within corridorR of points every corridorStepM along a → b. */
function corridorDefence(world: World, f: number, a: V2, b: V2): number {
  const n = Math.max(1, Math.ceil(dist(a, b) / ECON_WAR.corridorStepM));
  let v = 0;
  for (let k = 0; k < n; k++) {
    const t = k / n;
    v += knownDefence(world, f, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, ECON_WAR.corridorR);
  }
  return v;
}

/** Nearest of our front-line cells to p, and its distance. */
function nearestCell(world: World, f: number, p: V2): { cell: V2 | null; d: number } {
  let cell: V2 | null = null;
  let d = Infinity;
  for (const c of world.frontInfo[f]?.cells ?? []) {
    const e = dist(c, p);
    if (e < d) { d = e; cell = c; }
  }
  return { cell, d };
}

/** Worth of a building to a raider: its kind, its state (a site is worth half) and its HP. */
export function raidValue(b: Raidable): number {
  return (KIND_VALUE[b.kind] ?? 0.7) * (b.progress >= 1 ? 1 : 0.5) * (0.4 + 0.6 * (b.hp / Math.max(1, b.maxHp)));
}

export interface RaidPick { readonly b: Raidable; readonly defence: number; readonly score: number; readonly cell: V2 }

/**
 * Best enemy economic building to raid: value ÷ (defence and distance from our front), only within
 * rangeM of our front and defended by at most maxDefence × `partyValue` (pure scoring; exported for tests).
 */
export function pickRaidTarget(world: World, f: Faction, partyValue: number): RaidPick | null {
  let best: RaidPick | null = null;
  for (const b of raidables(world)) {
    if (b.ruined || b.owner < 0 || !world.isHostile(f.id, b.owner) || !world.factions[b.owner]?.alive) continue;
    const { cell, d } = nearestCell(world, f.id, b.pos);
    if (!cell || d > ECON_WAR.rangeM) continue;
    const defence = knownDefence(world, f.id, b.pos, ECON_WAR.defR);
    if (defence > partyValue * ECON_WAR.maxDefence) continue;
    // Infiltration: the way in must be thin too (known enemy along the cell → building corridor).
    const corridor = corridorDefence(world, f.id, cell, b.pos);
    if (corridor > partyValue * ECON_WAR.maxCorridor) continue;
    const score = raidValue(b) / ((1 + (defence + corridor) / 300) * (1 + d / 700));
    if (!best || score > best.score) best = { b, defence, score, cell };
  }
  return best;
}

function freeSquad(u: Unit, bound: ReadonlySet<number>): boolean {
  return u.hp > u.def.maxHp * 0.7 && u.opRole === 'line' && !u.spearhead && !u.manual && !u.routing && !u.rearming
    && u.behavior === 'advance' && !bound.has(u.frontId) && u.ammo > 0.25;
}

/** Live members of the faction's party (drops the party once it is home or broken). */
function liveParty(world: World, f: Faction): Party | null {
  const p = parties.get(f);
  if (!p) return null;
  const alive = p.ids.filter((id) => { const u = world.unitAlive(id); return !!u && u.opRole === 'raid' && !u.spearhead && tagId(u.opObjective) >= 0; });
  if (alive.length === 0) {
    parties.delete(f);
    return null;
  }
  // Bounded cost: half the party lost (or its time up) → everyone comes home.
  if (alive.length < Math.ceil(p.ids.length * ECON_WAR.abortShare) || world.time > p.until) {
    for (const id of alive) endRaid(world.unitAlive(id)!);
    parties.delete(f);
    return null;
  }
  return p;
}

function endRaid(u: Unit): void {
  u.opRole = 'line';
  u.opObjective = null;
  u.opTarget = null;
}

/**
 * Supreme-HQ pass (every front think, cheap): launch one economic raid party when none is out.
 * AI factions only (the player raids by hand); not for a finisher, a faction on the defensive,
 * or a thin army.
 */
export function planEconRaids(world: World, f: Faction): void {
  if (!ECON_WAR_AB.raids || f.isPlayer || !f.alive || !econRules(world) || (world.econ.length === 0 && world.econZones.length === 0)) return;
  if (liveParty(world, f)) return;
  if (world.time < Math.max(ECON_WAR.firstS, nextAt.get(f) ?? 0)) return;
  nextAt.set(f, world.time + ECON_WAR.everyS);
  const k = f.directive.kind;
  if (f.command.finisher || k === 'defend' || k === 'contract' || k === 'fortify') return why('directive');
  if (f.command.fullness < ECON_WAR.minFullness) return why('thin');
  // The real alert (an attack actually coming), not the readiness alarm that is on most of the time.
  if (f.command.homeThreat.alert) return why('alert');
  const bound = new Set(f.fronts.filter(boundOrder).map((s) => s.id));
  // Value of a typical party: three rifle squads.
  const rifle = world.data.units.get('infantry');
  const typical = rifle ? 3 * (rifle.costP + rifle.costM) : 300;
  const pick = pickRaidTarget(world, f, typical);
  if (!pick) return why('noTarget');
  const pool: Unit[] = [];
  const tanks: Unit[] = [];
  for (const u of world.aliveUnits) {
    if (u.owner !== f.id || !freeSquad(u, bound) || dist(u.pos, pick.cell) > ECON_WAR.poolR) continue;
    if (RAIDER_IDS.has(u.def.id)) pool.push(u);
    else if (u.def.id === 'light_tank') tanks.push(u);
  }
  // Engineers demolish fastest, recon slips through: one of each first, then the nearest rifles.
  pool.sort((a, b) => rank(a) - rank(b) || dist(a.pos, pick.b.pos) - dist(b.pos, pick.b.pos) || a.id - b.id);
  const size = Math.min(ECON_WAR.partyMax, ECON_WAR.partyMin + (pick.defence > 0 ? 1 : 0) + (pick.b.progress >= 1 && pick.b.kind !== 'depot' ? 1 : 0));
  const party: Unit[] = [];
  let eng = 0;
  let rec = 0;
  for (const u of pool) {
    if (party.length >= size) break;
    if (u.def.id === 'engineer' && eng++ >= 1) continue;
    if (u.def.id === 'recon' && rec++ >= 1) continue;
    party.push(u);
  }
  if (pick.defence > ECON_WAR.tankDefence && tanks.length > 0 && party.length < ECON_WAR.partyMax) {
    tanks.sort((a, b) => dist(a.pos, pick.b.pos) - dist(b.pos, pick.b.pos) || a.id - b.id);
    party.push(tanks[0]);
  }
  if (party.length < ECON_WAR.partyMin) return why('noParty');
  why('launched');
  const until = world.time + ECON_WAR.maxS;
  for (const u of party) {
    u.opRole = 'raid';
    u.opObjective = econTag(pick.b);
    u.opTarget = { ...pick.b.pos };
    u.opUntil = until;
  }
  parties.set(f, { target: pick.b.id, ids: party.map((u) => u.id), until });
  world.note(f.id, 'log.econRaid', { n: party.length, bld: pick.b.kind, point: pick.b.placeId ?? '' }, 'info');
}

const rank = (u: Unit): number => (u.def.id === 'engineer' ? 0 : u.def.id === 'recon' ? 1 : 2);

const packCache = new WeakMap<World, { tick: number; far: Map<string, number> }>();

/** Distance to `goal` of the party's rearmost member (members share the raid objective; cached per tick). */
function rearmost(world: World, u: Unit, goal: V2, mine: number): number {
  let c = packCache.get(world);
  if (!c || c.tick !== world.tick) {
    c = { tick: world.tick, far: new Map() };
    packCache.set(world, c);
  }
  const key = `${u.owner}:${u.opObjective}:${Math.floor(mine / ECON_WAR.laggardM)}`;
  let far = c.far.get(key);
  if (far === undefined) {
    far = 0;
    const p = parties.get(world.factions[u.owner]);
    for (const id of p?.ids ?? []) {
      const m = world.unitAlive(id);
      const dm = m && m.opRole === 'raid' && m.opObjective === u.opObjective && !m.spearhead ? dist(m.pos, goal) : -1;
      // A laggard far behind (stuck, fighting) is not waited for.
      if (dm >= 0 && dm < mine + ECON_WAR.laggardM) far = Math.max(far, dm);
    }
    c.far.set(key, far);
  }
  return far;
}

/** Next hostile building within nextR of `p` (the party moves on once its target is down). */
function nextBuilding(world: World, f: number, p: V2): Raidable | null {
  let best: Raidable | null = null;
  let bd: number = ECON_WAR.nextR;
  for (const b of raidables(world)) {
    if (b.ruined || b.owner < 0 || !world.isHostile(f, b.owner)) continue;
    const d = dist(b.pos, p);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

/**
 * Raider behaviour for an economic raid (behavior.thinkOpRaid hands over when the raid's objective
 * is a building): march to the building, stand next to it (demolition, econ.econSecond) while
 * shooting back, move on to the next building nearby, or come home.
 */
export function thinkEconRaid(world: World, u: Unit): boolean {
  if (u.routing || u.manual || world.time > u.opUntil || u.hp < u.def.maxHp * 0.4) {
    endRaid(u);
    return false;
  }
  const tag = tagId(u.opObjective);
  let b: Raidable | null = world.econ.find((x) => x.id === tag) ?? world.econZones.find((x) => x.id === tag) ?? null;
  if (!b || b.ruined || b.owner < 0 || !world.isHostile(u.owner, b.owner)) {
    b = nextBuilding(world, u.owner, u.pos);
    if (!b) {
      endRaid(u);
      return false;
    }
    u.opObjective = econTag(b);
    u.opTarget = { ...b.pos };
  }
  const r = econRules(world)?.demolish_radius_m ?? 28;
  selectTarget(world, u, b.pos);
  const d = dist(u.pos, b.pos);
  if (d <= r * 0.6) stop(u);
  else if (d < rearmost(world, u, b.pos, d) - ECON_WAR.packM && d > r * 2) stop(u); // wait for the party
  else moveTo(world, u, b.pos);
  u.status = 'status.raidEcon';
  return true;
}

/**
 * Worth of the economic buildings at a settlement (0 = none working or building): garrison priority
 * for the town (command.ts) and the fall-back / hold anchors (frontresponse.ts).
 */
export function econWorth(world: World, placeId: string, owner: number): number {
  let w = 0;
  for (const b of world.econ) if (b.placeId === placeId && b.owner === owner && !b.ruined) w += raidValue(b);
  return w;
}
