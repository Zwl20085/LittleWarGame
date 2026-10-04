import { COMBAT } from './config';
import { groundSpeedMul, type NavGrid } from './nav';
import { hostileMask } from './spatial';
import type { Unit } from './types';
import { clamp, DEG, dist, headingTo, turnToward, type V2, angleDiff } from './vec';
import type { World } from './world';
import { updateWorksCover } from './works';
import { isStructure, updateStructureGarrison } from './structures';

/** Set a movement destination; path is (re)computed lazily and rate-limited. */
export function moveTo(world: World, u: Unit, dest: V2, force = false): void {
  if (u.fixed) return;
  if (!force && u.dest && dist(u.dest, dest) < 6 && (u.path.length > 0 || dist(u.pos, dest) < 6)) return;
  // A consumed horizon-limited path must continue at once; everything else is rate-limited.
  // A long route is kept longer when the goal only drifts (group slots shift a little every
  // think): the horizon stretch gets re-planned anyway before the drift matters.
  const continuing = u.pathPartial && u.path.length === 0;
  const holdUntil = u.path.length > 0 && dist(u.pos, dest) > FAR_ROUTE_M ? u.repathAt + FAR_ROUTE_HOLD_S : u.repathAt;
  if (!force && !continuing && world.time < holdUntil && u.dest && dist(u.dest, dest) < 25) return;
  // Never aim inside a building: snap to the nearest open ground.
  dest = world.terrain.freeNear(dest, 40);
  u.dest = { ...dest };
  u.repathAt = world.time + 2 + world.rngAi.next();
  // Long trips share a cached flow field; short hops use a small A*.
  const nav = world.navFor(u);
  // Long routes: vehicles share the most conservative vehicle grid (a route legal for a heavy
  // tank is legal for every vehicle) so all vehicle classes reuse the same cached flow fields.
  const longNav = u.def.kind === 'vehicle' ? world.nav(true, 15) : nav;
  let res = dist(u.pos, dest) > 120 ? longNav.pathByField(u.pos, dest, PATH_HORIZON_CELLS) : nav.findPath(u.pos, dest, 4000);
  // The shared conservative grid can call a slope-side start or goal unreachable that this
  // unit's own class can climb (a light tank on an 18° bank): fall back to its own grid.
  if (longNav !== nav && (!res.ok || res.bestEffort) && dist(u.pos, dest) > 120) {
    const own = nav.pathByField(u.pos, dest, PATH_HORIZON_CELLS);
    if (own.ok && (!own.bestEffort || !res.ok)) res = own;
  }
  // Short direct routes: retry with corner squeezes allowed before giving up.
  if (!res.ok && dist(u.pos, dest) <= 120) res = nav.findPath(u.pos, dest, 4000, true);
  // Short hops inside towns: the 8 m graph may put start and goal in different street pockets
  // although the 2 m raster connects them; walk the raster directly.
  if (!res.ok && dist(u.pos, dest) <= SHORT_HOP_M) {
    const pts = world.terrain.detour(u.pos, dest, 40, nav.walkFn);
    if (pts && pts.length > 0) res = { ok: true, points: pts, partial: dist(pts[pts.length - 1], dest) > 3 };
  }
  u.legCheckIdx = -1;
  // A best-effort path that ends where we already stand means the goal is cut off: report it
  // as unreachable (rate-limited) rather than re-searching every think.
  const stalled = res.ok && res.partial && res.points.length > 0 && dist(res.points[res.points.length - 1], u.pos) < 8 && dist(u.pos, dest) > 12;
  if (res.ok && !stalled) {
    u.path = res.points;
    u.pathIdx = 0;
    u.pathFailed = false;
    u.pathPartial = res.partial;
  } else {
    u.path = [];
    u.pathFailed = true;
    u.pathPartial = false;
    u.status = 'status.unreachable';
  }
}

/** Long routes are built in stretches of this many nav cells (8 m each): bounded cost per call. */
const PATH_HORIZON_CELLS = 40;
/** Beyond this distance a drifting goal (< 25 m) keeps the current path for extra seconds. */
const FAR_ROUTE_M = 200;
const FAR_ROUTE_HOLD_S = 6;

export function stop(u: Unit): void {
  u.path = [];
  u.pathIdx = 0;
  u.dest = null;
  u.pathPartial = false;
  u.pathFailed = false;
}

/** Need to pack a crew weapon before moving (MG 2 s, AT 4 s …). Returns true while busy. */
function handleSetupBeforeMove(world: World, u: Unit, wantsMove: boolean): boolean {
  if (u.def.setupSeconds <= 0) return false;
  if (u.setup === 'setting' || u.setup === 'packing') {
    u.setupTimer -= world.dt;
    if (u.setupTimer <= 0) u.setup = u.setup === 'setting' ? 'set' : 'packed';
    return true;
  }
  if (wantsMove && u.setup === 'set') {
    u.setup = 'packing';
    u.setupTimer = u.def.packSeconds;
    return true;
  }
  if (!wantsMove && u.setup === 'packed' && !u.routing) {
    u.setup = 'setting';
    u.setupTimer = u.def.setupSeconds;
    return true;
  }
  return false;
}

/**
 * Motorized infantry (user request): rides its trucks on long, safe trips — vehicle-like
 * speed, cannot fight, extra damage while mounted — and dismounts (a few seconds) near the
 * enemy, when fired upon or at the end of the trip.
 */
export const MOTOR = {
  speed: 5.2,
  mountSeconds: 5,
  minTripM: 180,
  safeRadiusM: 450,
  mountedDamageMul: 1.15,
  /** 2.0 attack-side round: a motorized spearhead stays mounted until known enemies are this close (450 m otherwise). */
  spearSafeRadiusM: 220,
} as const;

/** Mount/dismount state machine; true while the squad is getting on or off its trucks. */
function handleMount(world: World, u: Unit, wantsMove: boolean): boolean {
  if (u.def.id !== 'motor_inf') return false;
  if (world.time < u.mountUntil) return true;
  // Re-evaluated every ~0.5 s per unit (spatial query), not every tick.
  if ((world.tick + u.id) % 10 !== 0 && !(u.mounted && world.time - u.lastDamagedAt < 1)) return false;
  const trip = u.dest ? dist(u.pos, u.dest) : 0;
  let want = wantsMove && trip > MOTOR.minTripM && world.time - u.lastDamagedAt > 8 && !u.routing;
  if (want) {
    // Any known enemy within the safety radius keeps the squad on foot (early-exit search).
    const f = u.owner;
    if (world.spatial.findOwner(u.pos.x, u.pos.z, u.spearhead ? MOTOR.spearSafeRadiusM : MOTOR.safeRadiusM, hostileMask(world, f), (o) => o.hp > 0 && world.isHostile(f, o.owner) && world.knows(f, o))) want = false;
  }
  if (want === u.mounted) return false;
  u.mounted = want;
  u.mountUntil = world.time + MOTOR.mountSeconds;
  return true;
}

export function speedOf(world: World, u: Unit, heading: number): number {
  if (u.mounted) {
    const g = world.terrain.groundAt(u.pos.x, u.pos.z);
    return MOTOR.speed * groundSpeedMul(g, true) * (world.data.rules.proposed_defaults.tempo_move_multiplier ?? 1);
  }
  const veh = u.def.kind === 'vehicle';
  // Ground type and grade change slowly along a path: sample them every few ticks (perf).
  if (world.tick - u.terrainMulAt >= TERRAIN_SAMPLE_TICKS) {
    const g = world.terrain.groundAt(u.pos.x, u.pos.z);
    const grade = world.terrain.gradeAlong(u.pos.x, u.pos.z, heading);
    u.terrainMul = groundSpeedMul(g, veh) * (grade > 0 ? clamp(1 - 0.02 * grade, 0.45, 1) : 1);
    u.terrainMulAt = world.tick;
  }
  let s = u.def.speed * u.terrainMul * (world.data.rules.proposed_defaults.tempo_move_multiplier ?? 1);
  // Strongest slowdown of each source only (§7).
  let status = 1;
  if (u.moraleState === 'pinned') status = 0.25;
  else if (u.moraleState === 'suppressed') status = 0.7;
  if (u.routing) status = Math.max(status, 0.9);
  s *= status;
  if (veh && u.hp < u.def.maxHp * 0.25) s *= COMBAT.lowHpVehicleSpeedMul;
  if (veh && u.ammo <= 0) s *= world.data.rules.supply.empty_vehicle_speed_multiplier;
  return s;
}

/** Advance along path with hull-turn limits and light separation. */
export function updateMovement(world: World, u: Unit): void {
  // In place: avoids one allocation per unit per tick (prev is only copied out by snapshots).
  u.prev.x = u.pos.x;
  u.prev.z = u.pos.z;
  u.moving = false;
  u.speedNow = 0;
  if (u.fixed || u.hp <= 0) return;
  // A consumed horizon stretch continues at once (same tick): no pause, no crew weapon
  // deploying and no motorised squad dismounting between stretches of one long route.
  if (u.path.length === 0 && u.pathPartial && u.dest) moveTo(world, u, u.dest, true);
  const wantsMove = u.path.length > 0 && u.pathIdx < u.path.length;
  if (handleSetupBeforeMove(world, u, wantsMove)) return;
  if (handleMount(world, u, wantsMove)) return;
  if (!wantsMove) {
    if ((world.tick + u.id) % 3 === 0) separate(world, u, 1.8);
    return;
  }
  const wp = u.path[u.pathIdx];
  const d = dist(u.pos, wp);
  const last = u.pathIdx === u.path.length - 1;
  // Early arrival only when the next leg is clear of walls (detour corners must be rounded).
  // The wall test is evaluated once per waypoint approach, not every tick (perf).
  let near = d < (last ? 2.5 : 5);
  if (near && !last && d >= 0.6) {
    if (u.legCheckIdx !== u.pathIdx) {
      u.legCheckIdx = u.pathIdx;
      u.legClear = world.terrain.wallFree(u.pos, u.path[u.pathIdx + 1]);
    }
    near = u.legClear;
  }
  if (near) {
    u.pathIdx++;
    u.detours = 0;
    if (u.pathIdx >= u.path.length) {
      u.path = [];
      u.pathIdx = 0;
    }
    return;
  }
  // Stuck watchdog: no progress for a while → fresh plan; still none → drop the order (the AI
  // picks another goal) instead of standing there for the rest of the war.
  // Progress = the waypoint advanced, or the distance to it shrank by 2 m (separation jostling
  // moves a unit about without getting it anywhere).
  if (u.pathIdx !== u.progressIdx || d < u.progressD - 2) {
    u.progressIdx = u.pathIdx;
    u.progressD = d;
    u.progressAt = world.time;
  } else if (world.time - u.progressAt > STUCK_DROP_S) {
    stop(u);
    u.pathFailed = true;
    u.progressAt = world.time;
    return;
  } else if (world.time - u.progressAt > STUCK_REPLAN_S && u.dest && world.time >= u.repathAt) {
    moveTo(world, u, u.dest, true);
    u.repathAt = world.time + STUCK_REPLAN_S;
  }
  // Off its own ground (a cell above the slope limit): head for the nearest passable cell first.
  const ter0 = world.terrain;
  const nav0 = world.navFor(u);
  const esc = !nav0.walkableXZ(u.pos.x, u.pos.z) && ter0.buildingH(u.pos.x, u.pos.z) === 0 ? nav0.nearestPassable(u.pos, 24) : null;
  const want = headingTo(u.pos, esc ?? wp);
  const veh = u.def.kind === 'vehicle';
  const turnRate = (veh ? u.def.hullTurnDegps : 360) * DEG * world.dt;
  u.heading = turnToward(u.heading, want, turnRate);
  // Vehicles must roughly face the waypoint before driving (no instant pivot exposing armour).
  const misalign = Math.abs(angleDiff(u.heading, want));
  const s = speedOf(world, u, u.heading) * (veh ? clamp(1 - misalign / (70 * DEG), 0, 1) : 1);
  const step = Math.min(s * world.dt, d);
  const nx = u.pos.x + Math.cos(u.heading) * step;
  const nz = u.pos.z + Math.sin(u.heading) * step;
  const nav = world.navFor(u);
  const ter = world.terrain;
  let moved = false;
  // Escape hatch: a unit already inside a wall/blocked cell may always move out (only checked
  // when the step ahead is blocked, which is rare).
  const stepFree = nav.walkableXZ(nx, nz) && ter.buildingH(nx, nz) === 0;
  if (stepFree || esc !== null || escapeStep(world, u, nav, nx, nz)) {
    u.pos.x = clamp(nx, 1, world.terrain.width - 1);
    u.pos.z = clamp(nz, 1, world.terrain.depth - 1);
    moved = true;
  } else if (ter.buildingH(nx, nz) > 0 && ter.buildingH(wp.x, wp.z) > 0 && d < 12) {
    // The waypoint itself lies in a house: close enough, take the next one.
    u.pathIdx = Math.min(u.pathIdx + 1, u.path.length);
    if (u.pathIdx >= u.path.length) u.path = [];
  } else if (world.time >= u.detourAt && !ter.wallFree(u.pos, wp, nav.walkFn)) {
    // A house, cliff or bank is in the way: plan a short detour on the fine 2 m raster.
    u.detourAt = world.time + 1.5;
    // Most blockers are single houses: search a small window first, widen only when that finds
    // nothing that gets closer to the waypoint.
    const progressOf = (p: V2[] | null): boolean => { const tail = p?.[p.length - 1]; return !!tail && dist(tail, u.pos) > 3 && dist(tail, wp) < d - 2; };
    let pts = ter.detour(u.pos, wp, DETOUR_NEAR_M, nav.walkFn);
    if (!progressOf(pts)) pts = ter.detour(u.pos, wp, DETOUR_FAR_M, nav.walkFn);
    const progress = progressOf(pts);
    u.detours++;
    if (pts && progress) u.path.splice(u.pathIdx, 0, ...pts);
    else if (d < WAYPOINT_SKIP_M || ter.buildingH(wp.x, wp.z) > 0) {
      // A close waypoint hugging a wall corner (or inside a house) can never be approached
      // directly, and the detour search keeps a cell of clearance from walls, so it never counts
      // as progress either: take the next waypoint instead of re-planning forever.
      u.detours = 0;
      u.pathIdx = Math.min(u.pathIdx + 1, u.path.length);
      if (u.pathIdx >= u.path.length) u.path = [];
    } else if (u.detours > 3) {
      // Repeated detours on one leg: the coarse path is wrong here. Give up on this waypoint
      // (a fresh plan from the same spot would start with the same leg) and re-plan from the next.
      u.detours = 0;
      if (!last) u.pathIdx++;
      else if (u.dest) moveTo(world, u, u.dest, true);
    } else u.slideSide = -u.slideSide;
  } else {
    // Wall-slide around the obstacle, measured from the direction we want to go (the hull
    // may still be turning); keep to the same side until a dead end.
    for (const a of SLIDE_ANGLES) {
      const h = want + a * u.slideSide;
      const sx = u.pos.x + Math.cos(h) * step;
      const sz = u.pos.z + Math.sin(h) * step;
      if (nav.walkableXZ(sx, sz) && ter.buildingH(sx, sz) === 0) {
        u.pos.x = clamp(sx, 1, world.terrain.width - 1);
        u.pos.z = clamp(sz, 1, world.terrain.depth - 1);
        moved = true;
        break;
      }
    }
    // Boxed in: try the other side next tick and ask for a fresh path.
    if (!moved) {
      u.slideSide = -u.slideSide;
      u.repathAt = 0;
    }
  }
  u.moving = moved && step > 0.001;
  u.speedNow = step / world.dt;
  if (!veh && u.def.kind === 'infantry') u.turret = u.heading;
  if (veh && u.targetId === null) u.turret = turnToward(u.turret, u.heading, u.def.turretTurnDegps * DEG * world.dt);
  if ((world.tick + u.id) % 3 === 0) separate(world, u, 3);
}

/**
 * Escape hatch for a unit already inside a wall or a cell its class cannot walk: it may step
 * out of a wall freely, and off bad ground only toward the nearest passable cell (so it cannot
 * wander deeper into a mountain or across a ridge one blocked cell at a time).
 */
function escapeStep(world: World, u: Unit, nav: NavGrid, nx: number, nz: number): boolean {
  const ter = world.terrain;
  if (ter.buildingH(u.pos.x, u.pos.z) > 0) return true;
  if (nav.walkableXZ(u.pos.x, u.pos.z)) return false;
  const esc = nav.nearestPassable(u.pos, 24);
  if (!esc) return true;
  const dx = esc.x - u.pos.x;
  const dz = esc.z - u.pos.z;
  return (nx - u.pos.x) * dx + (nz - u.pos.z) * dz > 0;
}

const scratch: Unit[] = [];
const SLIDE_ANGLES = [0, 0.52, 1.05, 1.57];
/** Ticks between terrain speed samples per unit (0.25 s). */
const TERRAIN_SAMPLE_TICKS = 5;
/** Ticks between garrison (field-work occupancy) checks per unit. */
const GARRISON_CHECK_TICKS = 5;
/** Ticks between terrain-cover samples for a moving unit. */
const COVER_CHECK_TICKS = 4;
/** Stuck watchdog: seconds without 1 m of progress before a forced re-plan / dropping the order. */
const STUCK_REPLAN_S = 20;
const STUCK_DROP_S = 45;
/** A wall-blocked waypoint closer than this is skipped rather than detoured to. */
const WAYPOINT_SKIP_M = 12;
/** Routes up to this length fall back to the 2 m building raster when the coarse search fails. */
const SHORT_HOP_M = 60;
/** Building-detour search windows (m): small first, wide fallback. */
const DETOUR_NEAR_M = 22;
const DETOUR_FAR_M = 40;
/** Local avoidance so squads don't stack; never teleports more than a fraction of a metre. */
function separate(world: World, u: Unit, strength: number): void {
  const r = u.def.kind === 'vehicle' ? 7 : 9;
  const near = world.spatial.query(u.pos.x, u.pos.z, r, scratch);
  let px = 0;
  let pz = 0;
  for (const o of near) {
    if (o.id === u.id || o.hp <= 0) continue;
    const dx = u.pos.x - o.pos.x;
    const dz = u.pos.z - o.pos.z;
    const d = Math.hypot(dx, dz) || 0.01;
    const minD = (u.def.kind === 'vehicle' ? 4 : 6) + (o.def.kind === 'vehicle' ? 3 : 4);
    if (d < minD) {
      const push = ((minD - d) / minD) * 0.25 * strength;
      px += (dx / d) * push;
      pz += (dz / d) * push;
    }
  }
  if (px === 0 && pz === 0) return;
  if (u.moving) {
    // Never push a moving unit backwards against its heading: columns keep flowing through
    // bridges and fords instead of gridlocking (sideways nudges still separate them).
    const fx = Math.cos(u.heading);
    const fz = Math.sin(u.heading);
    const back = px * fx + pz * fz;
    if (back < 0) {
      px -= back * fx;
      pz -= back * fz;
    }
  }
  const nx = u.pos.x + clamp(px, -0.4, 0.4);
  const nz = u.pos.z + clamp(pz, -0.4, 0.4);
  if (world.navFor(u).walkableXZ(nx, nz) && world.terrain.buildingH(nx, nz) === 0) {
    u.pos.x = clamp(nx, 1, world.terrain.width - 1);
    u.pos.z = clamp(nz, 1, world.terrain.depth - 1);
  }
}

export function updateHeight(world: World, u: Unit): void {
  // Height and terrain cover only change when the unit moved this tick (prev is the tick-start
  // position; separation nudges happen after it is taken, so this comparison is exact).
  const moved = u.pos.x !== u.prev.x || u.pos.z !== u.prev.z || u.terrainMulAt < 0;
  if (moved) u.y = world.terrain.heightAt(u.pos.x, u.pos.z);
  if (world.forts.length > 0) {
    updateWorksCover(world, u);
    // Pillboxes / bunkers: enter / leave (structures.ts, staggered every 10th tick per unit).
    updateStructureGarrison(world, u);
    // Scanning every work for every squad each tick is O(units × works): stagger it.
    if ((world.tick + u.id) % GARRISON_CHECK_TICKS === 0) updateGarrison(world, u);
  }
  // Terrain/building cover samples nine raster cells: refresh it a few times a second (a squad
  // crosses a 2 m cell in ~0.7 s), not every tick; the fixed cadence also catches a unit that
  // just stopped or just left a field work.
  if (u.def.kind !== 'vehicle' && u.fortId === null && !u.fixed && (u.terrainMulAt < 0 || (world.tick + u.id) % COVER_CHECK_TICKS === 0)) {
    u.cover = world.terrain.coverAt(u.pos.x, u.pos.z);
  }
}

/** Infantry/crew standing in a finished friendly work occupy it (one squad); leaving frees it. */
function updateGarrison(world: World, u: Unit): void {
  if (u.def.kind === 'vehicle' || u.fixed) return;
  if (u.fortId !== null) {
    const f = world.fortById(u.fortId);
    if (f && isStructure(f.kind)) return; // pillbox / bunker occupancy: structures.ts
    if (!f || f.hp <= 0 || dist(f.pos, u.pos) > 7) {
      if (f && f.occupant === u.id) f.occupant = null;
      u.fortId = null;
    }
    return;
  }
  if (u.moving) return;
  for (const f of world.forts) {
    if (f.hp <= 0 || f.progress < 1 || f.occupant !== null || isStructure(f.kind) || world.isHostile(u.owner, f.owner)) continue;
    if (dist(f.pos, u.pos) <= 5) {
      f.occupant = u.id;
      u.fortId = f.id;
      return;
    }
  }
}
