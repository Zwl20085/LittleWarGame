import { selectTarget } from './combat';
import { enemyDistance } from './frontai';
import { moveTo, stop } from './movement';
import { hostileMask } from './spatial';
import type { Faction, Objective, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * High command (user request): one theatre-wide commander per faction that looks at every
 * settlement and issues directives — DEFEND threatened holdings, OCCUPY open ground, ATTACK
 * valuable enemy towns. Directives are executed by assigning units roles ('garrison',
 * 'occupy'); attack priorities bias the army groups' target choice. Runs every few seconds
 * with O(settlements × spatial query + directives × candidates) work, so it is cheap.
 */
export const HQ = {
  everySeconds: 5,
  threatRadius: 340,
  /** Max share of the army's value tied down in garrisons. */
  garrisonShare: 0.3,
  /** Garrison wants this many × the known threat's value (and at least `minGarrison`). */
  overmatch: 1.3,
  minGarrison: 2,
  assignRadius: 1600,
  releaseCalmSeconds: 45,
  occupyMaxDetachments: 3,
  occupySize: 3,
  occupyRange: 1400,
  /** Enemy-held ground must be at least this far away for an unescorted occupation. */
  occupySafeDist: 220,
  directivesShown: 6,
} as const;

export type DirectiveKind = 'defend' | 'occupy' | 'attack';

export interface Directive {
  readonly kind: DirectiveKind;
  readonly obj: string;
  readonly pos: V2;
  readonly priority: number;
  /** Units currently assigned (garrison / occupation detachment). */
  assigned: number;
}

export interface HighCommand {
  directives: Directive[];
  /** Attack bias per objective id for army-group targeting (0 … 1). */
  attackBias: Record<string, number>;
  /** Last time each held settlement had enemies near (garrison release). */
  threatAt: Record<string, number>;
  nextAt: number;
}

export function createHighCommand(): HighCommand {
  return { directives: [], attackBias: {}, threatAt: {}, nextAt: 0 };
}

const GARRISON_TYPES = new Set(['infantry', 'mg', 'at_gun', 'engineer', 'light_tank', 'medium_tank', 'heavy_tank', 'aa']);
const OCCUPY_TYPES = new Set(['infantry', 'engineer', 'recon']);

const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

/** Economic + strategic worth of a settlement (income per minute, strategic towns weigh more). */
export function placeValue(world: World, o: Objective): number {
  const t = world.data.rules.territory;
  const inc = (t?.income_p_per_min[o.kind] ?? 10) + (t?.income_m_per_min[o.kind] ?? 6);
  return inc * (o.strategic ? 1.3 : 1);
}

function strengthNear(world: World, f: number, at: V2, r: number): { mine: number; theirs: number } {
  let mine = 0;
  let theirs = 0;
  for (const u of world.spatial.query(at.x, at.z, r)) {
    if (u.hp <= 0 || u.fixed) continue;
    if (u.owner === f) mine += valueOf(u);
    else if (world.isHostile(f, u.owner) && world.knows(f, u)) theirs += valueOf(u);
  }
  return { mine, theirs };
}

/** Theatre planning pass (every HQ.everySeconds). */
export function thinkHighCommand(world: World, f: Faction): void {
  if (!f.alive || world.time < f.command.nextAt) return;
  f.command.nextAt = world.time + HQ.everySeconds;
  const hc = f.command;
  const dirs: Directive[] = [];
  const bias: Record<string, number> = {};
  const hq = world.hqPos(f.id);
  for (const o of world.objectives) {
    const v = placeValue(world, o);
    const s = strengthNear(world, f.id, o.pos, HQ.threatRadius);
    if (o.owner === f.id) {
      if (s.theirs > 0) {
        hc.threatAt[o.id] = world.time;
        dirs.push({ kind: 'defend', obj: o.id, pos: o.pos, priority: v * (1 + s.theirs / (s.mine + 50)), assigned: 0 });
      }
      continue;
    }
    const dHome = dist(o.pos, hq);
    const reach = 1 / (1 + dHome / 1500);
    if (o.owner < 0 && s.theirs === 0 && enemyDistance(world, f.id, o.pos) > HQ.occupySafeDist) {
      dirs.push({ kind: 'occupy', obj: o.id, pos: o.pos, priority: v * reach, assigned: 0 });
    } else if (o.owner < 0 || world.isHostile(f.id, o.owner)) {
      const odds = (s.mine + 1) / (s.theirs + 1);
      const p = v * reach * Math.min(2, odds);
      dirs.push({ kind: 'attack', obj: o.id, pos: o.pos, priority: p, assigned: 0 });
      bias[o.id] = p;
    }
  }
  // Normalise attack bias to 0..1 for the group planners.
  const maxB = Math.max(1, ...Object.values(bias));
  for (const k of Object.keys(bias)) bias[k] /= maxB;
  hc.attackBias = bias;
  dirs.sort((a, b) => b.priority - a.priority);
  hc.directives = dirs;
  assignGarrisons(world, f, dirs.filter((d) => d.kind === 'defend').slice(0, 8));
  assignOccupations(world, f, dirs.filter((d) => d.kind === 'occupy'));
  // The UI shows the top few (all three kinds represented when present).
  hc.directives = pickShown(dirs);
}

function pickShown(dirs: Directive[]): Directive[] {
  const out: Directive[] = [];
  for (const kind of ['defend', 'attack', 'occupy'] as const) out.push(...dirs.filter((d) => d.kind === kind).slice(0, 2));
  return out.slice(0, HQ.directivesShown);
}

function freeLine(u: Unit): boolean {
  return u.opRole === 'line' && !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance';
}

/** Defend directives: send the nearest line troops until the garrison outweighs the threat. */
function assignGarrisons(world: World, f: Faction, defend: Directive[]): void {
  const mine: Unit[] = [];
  let army = 0;
  let tied = 0;
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
    mine.push(u);
    army += valueOf(u);
    if (u.opRole === 'garrison') tied += valueOf(u);
  }
  // Release garrisons whose town has been quiet for a while (or was lost).
  for (const u of mine) {
    if (u.opRole !== 'garrison' || !u.opObjective) continue;
    const o = world.objectives.find((x) => x.id === u.opObjective);
    const quiet = world.time - (f.command.threatAt[u.opObjective] ?? -1e9) > HQ.releaseCalmSeconds;
    if (!o || o.owner !== f.id || quiet) {
      u.opRole = 'line';
      u.opObjective = null;
      u.opTarget = null;
      tied -= valueOf(u);
    }
  }
  const budget = army * HQ.garrisonShare;
  for (const d of defend) {
    const s = strengthNear(world, f.id, d.pos, HQ.threatRadius);
    let have = 0;
    let count = 0;
    for (const u of mine) if (u.opRole === 'garrison' && u.opObjective === d.obj) { have += valueOf(u); count++; }
    const want = s.theirs * HQ.overmatch;
    const before = count;
    if ((have >= want && count >= HQ.minGarrison) || tied >= budget) {
      d.assigned = count;
      continue;
    }
    const pool = mine.filter((u) => freeLine(u) && GARRISON_TYPES.has(u.def.id) && dist(u.pos, d.pos) < HQ.assignRadius)
      .sort((a, b) => dist(a.pos, d.pos) - dist(b.pos, d.pos));
    for (const u of pool) {
      if ((have >= want && count >= HQ.minGarrison) || tied >= budget) break;
      u.opRole = 'garrison';
      u.opObjective = d.obj;
      u.opTarget = null;
      have += valueOf(u);
      tied += valueOf(u);
      count++;
    }
    if (before === 0 && count > 0) world.note(f.id, 'log.hqDefend', { point: d.obj, n: count }, 'info');
    d.assigned = count;
  }
}

/** Occupy directives: small infantry detachments take open settlements behind the lines. */
function assignOccupations(world: World, f: Faction, occupy: Directive[]): void {
  const active = new Map<string, number>();
  const pool: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed) continue;
    if (u.opRole === 'occupy' && u.opObjective) active.set(u.opObjective, (active.get(u.opObjective) ?? 0) + 1);
    else if (freeLine(u) && OCCUPY_TYPES.has(u.def.id)) pool.push(u);
  }
  let detachments = active.size;
  for (const d of occupy) d.assigned = active.get(d.obj) ?? 0;
  for (const d of occupy) {
    if (detachments >= HQ.occupyMaxDetachments) break;
    if (active.has(d.obj)) {
      d.assigned = active.get(d.obj) ?? 0;
      continue;
    }
    const near = pool.filter((u) => u.opRole === 'line' && dist(u.pos, d.pos) < HQ.occupyRange).sort((a, b) => dist(a.pos, d.pos) - dist(b.pos, d.pos)).slice(0, HQ.occupySize);
    if (near.filter((u) => u.def.kind === 'infantry').length === 0) continue;
    for (const u of near) {
      u.opRole = 'occupy';
      u.opObjective = d.obj;
      u.opTarget = null;
      u.opUntil = world.time + 240;
    }
    d.assigned = near.length;
    detachments++;
    world.note(f.id, 'log.hqOccupy', { point: d.obj, n: near.length }, 'info');
  }
}

/** Garrison post: a ring around the settlement centre, facing the threat; fight anything close. */
export function thinkGarrison(world: World, u: Unit): boolean {
  const o = world.objectives.find((x) => x.id === u.opObjective);
  if (!o) {
    u.opRole = 'line';
    return false;
  }
  if (!u.opTarget) {
    const foe = threatBearing(world, u.owner, o.pos);
    const spreadA = ((u.id * 2654435761) % 1000) / 1000 - 0.5; // ±0.5 rad around the threat bearing
    const r = Math.max(25, o.radius * 0.55);
    const a = foe + spreadA * 2.2;
    u.opTarget = world.terrain.freeNear({ x: o.pos.x + Math.cos(a) * r, z: o.pos.z + Math.sin(a) * r }, 30);
  }
  // Counter-attack enemies inside the town; otherwise man the post.
  let foeUnit: Unit | null = null;
  let bd = o.radius + 120;
  for (const e of world.spatial.queryOwners(o.pos.x, o.pos.z, bd, hostileMask(world, u.owner))) {
    if (e.hp <= 0 || !world.knows(u.owner, e)) continue;
    const d = dist(e.pos, o.pos);
    if (d < bd) {
      bd = d;
      foeUnit = e;
    }
  }
  if (foeUnit && bd < o.radius + 40) moveTo(world, u, foeUnit.pos);
  else if (dist(u.pos, u.opTarget) > 12) moveTo(world, u, u.opTarget);
  else stop(u);
  selectTarget(world, u, foeUnit ? foeUnit.pos : null);
  u.status = 'status.garrison';
  return true;
}

/** Occupation detachment: march in, take the place, then rejoin the army group. */
export function thinkOccupy(world: World, u: Unit): boolean {
  const o = world.objectives.find((x) => x.id === u.opObjective);
  const done = !o || o.owner === u.owner || world.time > u.opUntil || (o.owner >= 0 && !world.isHostile(u.owner, o.owner));
  if (done || !o) {
    u.opRole = 'line';
    u.opObjective = null;
    u.opTarget = null;
    return false;
  }
  if (!u.opTarget) u.opTarget = { ...world.terrain.freeNear(o.pos, 30) };
  if (dist(u.pos, u.opTarget) > 10) moveTo(world, u, u.opTarget);
  else stop(u);
  selectTarget(world, u, null);
  u.status = 'status.occupy';
  return true;
}

/** Bearing from `at` toward the nearest known enemy mass (falls back to away from our HQ). */
function threatBearing(world: World, f: number, at: V2): number {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const e of world.spatial.queryOwners(at.x, at.z, 600, hostileMask(world, f))) {
    if (e.hp <= 0 || !world.knows(f, e)) continue;
    sx += e.pos.x;
    sz += e.pos.z;
    n++;
  }
  if (n > 0) return headingTo(at, { x: sx / n, z: sz / n });
  return headingTo(world.hqPos(f), at);
}
