import type { Faction, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import { enemyDistance } from './frontai';
import { EAGER, eagerOn, stormOn } from './strategyai';
import { navPost } from './crewai';
import type { World } from './world';

/** Query scratch for crowding() (called per blast victim). */
const SC_CROWD: Unit[] = [];

/**
 * Operational layer (user request 2026-10-02): spread the war across the whole front,
 * fight over supply lines, and make massed troops and static artillery risky.
 *
 * - Front segments: each army group owns a stretch of the faction's front, so units
 *   are distributed along the full line instead of piling on one point.
 * - Raids: small detachments infiltrate through weak front fronts toward enemy convoy routes.
 * - Rear guard: a share of the army secures our own convoy routes and reacts to raiders.
 * - Counter-battery: firing guns reveal an approximate position to the enemy for a while.
 */

export const OPS = {
  raidShare: 0.07,
  rearGuardShare: 0.1,
  raidEverySeconds: 150,
  raidMaxSeconds: 240,
  minSpacing: 25,
  shelledSpacing: 40,
  shelledMemorySeconds: 20,
  batteryRevealSeconds: 20,
  batteryRevealError: 60,
  crowdRadius: 30,
  crowdThreshold: 5,
} as const;

export type OpRole = 'line' | 'raid' | 'rearguard';

/** Sort front cells into contiguous order by angle around the capital, then split per group. */
export function frontSegments(world: World, f: Faction, cells: V2[]): V2[][] {
  const groups = f.fronts.length;
  if (cells.length === 0 || groups === 0) return f.fronts.map(() => []);
  const hq = world.hqPos(f.id);
  const fwd = Math.atan2(cells.reduce((a, c) => a + c.z - hq.z, 0), cells.reduce((a, c) => a + c.x - hq.x, 0));
  const withAng = cells.map((c) => {
    let a = headingTo(hq, c) - fwd;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return { c, a };
  }).sort((p, q) => p.a - q.a);
  // Equal shares by count, in left → right order (matching front keys left/center/right).
  const out: V2[][] = f.fronts.map(() => []);
  withAng.forEach((p, i) => out[Math.min(groups - 1, Math.floor((i / withAng.length) * groups))].push(p.c));
  return out;
}

/** Evenly spaced points along a segment of front cells (already angle-ordered). */
export function spreadAlong(segment: V2[], count: number): V2[] {
  if (segment.length === 0 || count <= 0) return [];
  const out: V2[] = [];
  for (let k = 0; k < count; k++) out.push(segment[Math.min(segment.length - 1, Math.floor(((k + 0.5) / count) * segment.length))]);
  return out;
}

/** Weakest point of the enemy front near our segment: fewest known enemy units within 200 m. */
export function weakestPoint(world: World, f: number, segment: V2[]): V2 | null {
  let best: V2 | null = null;
  let bestN = Infinity;
  for (let k = 0; k < segment.length; k += Math.max(1, Math.floor(segment.length / 12))) {
    const p = segment[k];
    let n = 0;
    for (const u of world.spatial.query(p.x, p.z, 200)) if (u.hp > 0 && world.isHostile(f, u.owner) && world.knows(f, u)) n += u.def.costP + u.def.costM;
    if (n < bestN) {
      bestN = n;
      best = p;
    }
  }
  return best;
}

/** Known enemy convoy positions (trucks driving or unloading) — targets for raids. */
export function enemyConvoyTargets(world: World, f: number, near: V2, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const u of world.spatial.query(near.x, near.z, radius)) {
    if (u.hp > 0 && u.def.id === 'supply_truck' && world.isHostile(f, u.owner) && world.knows(f, u)) out.push(u);
  }
  return out;
}

/** Points along our own convoy routes (depot → active supply points) for the rear guard. */
export function ownConvoyRoute(world: World, f: Faction): V2[] {
  const depot = world.cityOf(f.id).exit;
  const pts: V2[] = [];
  for (const t of world.units.values()) {
    if (t.owner !== f.id || t.def.id !== 'supply_truck' || t.hp <= 0 || !t.truckDest) continue;
    const d = t.truckDest;
    for (const k of [0.35, 0.6, 0.85]) pts.push({ x: depot.x + (d.x - depot.x) * k, z: depot.z + (d.z - depot.z) * k });
  }
  return pts;
}

/** Sound-ranging: a gun that fires is located roughly by its enemies for a while. */
export interface BatteryReveal {
  readonly pos: V2;
  readonly until: number;
  readonly by: number; // faction that fired
}

export function revealBattery(world: World, u: Unit, reveals: BatteryReveal[]): void {
  const e = OPS.batteryRevealError;
  const jitter = { x: u.pos.x + world.rngAi.range(-e, e), z: u.pos.z + world.rngAi.range(-e, e) };
  const existing = reveals.findIndex((r) => r.by === u.owner && dist(r.pos, jitter) < 80);
  const entry = { pos: jitter, until: world.time + OPS.batteryRevealSeconds, by: u.owner };
  if (existing >= 0) reveals[existing] = entry;
  else reveals.push(entry);
}

/** Count friendly units crowded around p (for spacing doctrine and the crowding penalty). */
export function crowding(world: World, u: Unit): number {
  let n = 0;
  for (const o of world.spatial.query(u.pos.x, u.pos.z, OPS.crowdRadius, SC_CROWD)) if (o.owner === u.owner && o.hp > 0 && o.id !== u.id) n++;
  return n;
}

const isRaider = (u: Unit): boolean => u.def.id === 'light_tank' || u.def.id === 'recon' || u.def.id === 'infantry' || u.def.id === 'motor_inf';
// Round 4: MGs no longer guard routes (they were 39 % of all MGs, idle at the rear; crewai.ts puts them at the front).
/** Round 4: a rear-guard post on the unit's own nav grid (soak: guards 'unreachable' on steep / water route points). */
const guardSpot = (world: World, u: Unit, p: V2): V2 => (stormOn() ? navPost(world, u, p) : p);

const isGuard = (u: Unit): boolean => u.def.id === 'infantry' || u.def.id === 'motor_inf' || (u.def.id === 'mg' && !stormOn()) || u.def.id === 'light_tank';

/**
 * Faction-level operations (every front think, cheap): keep a rear guard on our convoy routes
 * and periodically launch a raid through the weakest stretch of the enemy front toward their rear.
 */
export function planOperations(world: World, f: Faction): void {
  const mine: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f.id && u.hp > 0 && !u.fixed && u.def.id !== 'supply_truck' && u.def.id !== 'commander') mine.push(u);
  if (mine.length < 20) return;
  const contact = (world.frontInfo[f.id]?.cells.length ?? 0) > 0;
  // Rear guard: posts along our own convoy routes, filled from units far from the front.
  const route = ownConvoyRoute(world, f);
  if (stormOn()) for (const u of mine) if (u.opRole === 'rearguard' && !isGuard(u)) u.opRole = 'line';
  const guards = mine.filter((u) => u.opRole === 'rearguard');
  // Round 2: guards fired 1–2 % of the time; keep a small guard until our convoys are actually hit.
  const raided = f.trucksUnderFire.some((h) => world.time - h.at < EAGER.rearGuardAlertS);
  const share = eagerOn() && !raided ? EAGER.rearGuardQuiet : OPS.rearGuardShare;
  // Round 5: a finisher sends its rear guard and raiders to the capital storm instead (storm.FINISH).
  const finisher = stormOn() && f.command.finisher;
  const wantGuards = contact && route.length && !finisher ? Math.round(mine.length * share) : 0;
  if (guards.length < wantGuards) {
    const pool = mine.filter((u) => u.opRole === 'line' && !u.spearhead && !u.manual && isGuard(u) && u.behavior === 'advance')
      .sort((a, b) => enemyDistance(world, f.id, b.pos) - enemyDistance(world, f.id, a.pos));
    for (const u of pool.slice(0, wantGuards - guards.length)) {
      u.opRole = 'rearguard';
      u.opTarget = guardSpot(world, u, route[(u.id * 7) % route.length]);
    }
  } else if (guards.length > wantGuards + 2) {
    for (const u of guards.slice(wantGuards)) u.opRole = 'line';
  }
  // Re-post guards to the current routes now and then; a guard that cannot reach its post takes the
  // next route point (round 6 soak: rear guards 'unreachable' for minutes on a slope / forest post).
  if (route.length) {
    for (const u of guards) {
      if (u.pathFailed) u.opTarget = guardSpot(world, u, route[(u.id * 7 + Math.floor(world.time / 10)) % route.length]);
      else if (!u.opTarget || (world.tick + u.id) % 600 === 0) u.opTarget = guardSpot(world, u, route[(u.id * 7) % route.length]);
    }
  }
  // Raids through the weakest front stretch toward the enemy rear.
  if (!contact || finisher || world.time < f.nextRaidAt) return;
  f.nextRaidAt = world.time + OPS.raidEverySeconds;
  const cells = world.frontInfo[f.id].cells;
  const gap = weakestPoint(world, f.id, cells);
  if (!gap) return;
  const hq = world.hqPos(f.id);
  const dir = headingTo(hq, gap);
  const target = { x: gap.x + Math.cos(dir) * 380, z: gap.z + Math.sin(dir) * 380 };
  if (!world.terrain.inBounds(target.x, target.z)) return;
  const size = Math.max(3, Math.round(mine.length * OPS.raidShare));
  const pool = mine.filter((u) => u.opRole === 'line' && !u.spearhead && !u.manual && isRaider(u) && u.behavior === 'advance' && u.hp > u.def.maxHp * 0.7)
    .sort((a, b) => dist(a.pos, gap) - dist(b.pos, gap)).slice(0, size);
  if (pool.length < 3) return;
  for (const u of pool) {
    u.opRole = 'raid';
    u.opTarget = target;
    u.opUntil = world.time + OPS.raidMaxSeconds;
  }
  world.note(f.id, 'log.raidLaunched', { n: pool.length }, 'info');
}
