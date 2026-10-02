import { COMBAT } from './config';
import { groundSpeedMul } from './nav';
import type { Unit } from './types';
import { clamp, DEG, dist, headingTo, turnToward, type V2, angleDiff } from './vec';
import type { World } from './world';

/** Set a movement destination; path is (re)computed lazily and rate-limited. */
export function moveTo(world: World, u: Unit, dest: V2, force = false): void {
  if (u.fixed) return;
  if (!force && u.dest && dist(u.dest, dest) < 6 && (u.path.length > 0 || dist(u.pos, dest) < 6)) return;
  if (!force && world.time < u.repathAt && u.dest && dist(u.dest, dest) < 25) return;
  // Never aim inside a building: snap to the nearest open ground.
  dest = world.terrain.freeNear(dest, 40);
  u.dest = { ...dest };
  u.repathAt = world.time + 2 + world.rngAi.next();
  // Long trips share a cached flow field; short hops use a small A*.
  const nav = world.navFor(u);
  // Long routes: vehicles share the most conservative vehicle grid (a route legal for a heavy
  // tank is legal for every vehicle) so all vehicle classes reuse the same cached flow fields.
  const longNav = u.def.kind === 'vehicle' ? world.nav(true, 15) : nav;
  const res = dist(u.pos, dest) > 120 ? longNav.pathByField(u.pos, dest) : nav.findPath(u.pos, dest, 4000);
  if (res.ok) {
    u.path = res.points;
    u.pathIdx = 0;
    u.pathFailed = false;
  } else {
    u.path = [];
    u.pathFailed = true;
    u.status = 'status.unreachable';
  }
}

export function stop(u: Unit): void {
  u.path = [];
  u.pathIdx = 0;
  u.dest = null;
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

export function speedOf(world: World, u: Unit, heading: number): number {
  const veh = u.def.kind === 'vehicle';
  const g = world.terrain.groundAt(u.pos.x, u.pos.z);
  let s = u.def.speed * groundSpeedMul(g, veh) * (world.data.rules.proposed_defaults.tempo_move_multiplier ?? 1);
  const grade = world.terrain.gradeAlong(u.pos.x, u.pos.z, heading);
  if (grade > 0) s *= clamp(1 - 0.02 * grade, 0.45, 1);
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
  const wantsMove = u.path.length > 0 && u.pathIdx < u.path.length;
  if (handleSetupBeforeMove(world, u, wantsMove)) return;
  if (!wantsMove) {
    if ((world.tick + u.id) % 3 === 0) separate(world, u, 1.8);
    return;
  }
  const wp = u.path[u.pathIdx];
  const d = dist(u.pos, wp);
  const last = u.pathIdx === u.path.length - 1;
  // Early arrival only when the next leg is clear of walls (detour corners must be rounded).
  const near = d < (last ? 2.5 : 5) && (last || d < 0.6 || world.terrain.wallFree(u.pos, u.path[u.pathIdx + 1]));
  if (near) {
    u.pathIdx++;
    if (u.pathIdx >= u.path.length) {
      u.path = [];
      u.pathIdx = 0;
    }
    return;
  }
  const want = headingTo(u.pos, wp);
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
  // Escape hatch: a unit already inside a wall/blocked cell may always move out.
  const stuckIn = !nav.walkableXZ(u.pos.x, u.pos.z) || ter.buildingH(u.pos.x, u.pos.z) > 0;
  if ((nav.walkableXZ(nx, nz) && ter.buildingH(nx, nz) === 0) || stuckIn) {
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
    const pts = ter.detour(u.pos, wp, 40, nav.walkFn);
    const tail = pts?.[pts.length - 1];
    const reaches = !!tail && dist(tail, wp) < 6;
    if (pts && tail && dist(tail, u.pos) > 3 && (reaches || last)) u.path.splice(u.pathIdx, 0, ...pts);
    else if (!last) u.pathIdx++; // this waypoint is cut off locally: aim for the next one
    else u.slideSide = -u.slideSide;
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

const scratch: Unit[] = [];
const SLIDE_ANGLES = [0, 0.52, 1.05, 1.57];
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
  u.y = world.terrain.heightAt(u.pos.x, u.pos.z);
  updateGarrison(world, u);
  if (u.def.kind !== 'vehicle' && u.fortId === null && !u.fixed) u.cover = world.terrain.coverAt(u.pos.x, u.pos.z);
}

/** Infantry/crew standing in a finished friendly work occupy it (one squad); leaving frees it. */
function updateGarrison(world: World, u: Unit): void {
  if (u.def.kind === 'vehicle' || u.fixed) return;
  if (u.fortId !== null) {
    const f = world.forts.find((x) => x.id === u.fortId);
    if (!f || f.hp <= 0 || dist(f.pos, u.pos) > 7) {
      if (f && f.occupant === u.id) f.occupant = null;
      u.fortId = null;
    }
    return;
  }
  if (u.moving) return;
  for (const f of world.forts) {
    if (f.hp <= 0 || f.progress < 1 || f.occupant !== null || world.isHostile(u.owner, f.owner)) continue;
    if (dist(f.pos, u.pos) <= 5) {
      f.occupant = u.id;
      u.fortId = f.id;
      return;
    }
  }
}
