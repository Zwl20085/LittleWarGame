import { isTank } from './armour';
import { aboard } from './rail';
import { hostileMask } from './spatial';
import type { Unit } from './types';
import { isMotorized } from './upgradestats';
import { dist } from './vec';
import type { World } from './world';

/**
 * 4.0 Tank Desant (坦克搭载步兵):
 * Tanks (`light_tank`, `medium_tank`, `heavy_tank`) advancing on long marches, spearheads, or
 * manoeuvre thrusts can carry one friendly foot infantry squad (`infantry`, `engineer`, `recon`)
 * on their hull deck. Riders move at the tank's full speed and automatically dismount around the
 * tank when approaching known enemies, taking fire, or arriving at the objective.
 */
export const DESANT = {
  boardRadiusM: 48,
  spearBoardRadiusM: 95,
  minTripM: 90,
  mountSafeRadiusM: 135,
  dismountEnemyRadiusM: 120,
  dismountSpearEnemyRadiusM: 95,
  dismountArriveM: 28,
} as const;

const SC_BOARD: Unit[] = [];

export function canBoardTank(u: Unit): boolean {
  return (
    u.hp > 0 &&
    u.ridingTankId == null &&
    !u.mounted &&
    !isMotorized(u) &&
    !aboard(u) &&
    u.fortId === null &&
    !u.routing &&
    !u.manual &&
    !u.rearming &&
    (u.def.id === 'infantry' || u.def.id === 'engineer' || u.def.id === 'recon')
  );
}

export function pairTankDesant(world: World, tank: Unit, squad: Unit): void {
  if (tank.riderId != null || squad.ridingTankId != null) return;
  tank.riderId = squad.id;
  squad.ridingTankId = tank.id;
  squad.pos.x = tank.pos.x;
  squad.pos.z = tank.pos.z;
  squad.prev.x = tank.prev.x;
  squad.prev.z = tank.prev.z;
  squad.y = tank.y;
  squad.heading = tank.heading;
  squad.turret = tank.heading;
  squad.moving = tank.moving;
  squad.speedNow = tank.speedNow;
  squad.movedX = squad.pos.x;
  squad.movedZ = squad.pos.z;
  squad.movedAt = world.time;
  squad.progressAt = world.time;
  if (tank.spearhead && !squad.spearhead) squad.spearhead = tank.spearhead;
}

export function dismountTankDesant(world: World, squad: Unit, tank?: Unit | null): void {
  const t = tank ?? (squad.ridingTankId != null ? world.units.get(squad.ridingTankId) ?? null : null);
  if (t && t.riderId === squad.id) t.riderId = null;
  squad.ridingTankId = null;
  if (t && t.hp > 0 && squad.hp > 0) {
    const a = t.heading + Math.PI + ((squad.id & 1) !== 0 ? 0.6 : -0.6);
    const p = world.terrain.freeNear({ x: t.pos.x + Math.cos(a) * 4.5, z: t.pos.z + Math.sin(a) * 4.5 }, 12);
    squad.pos.x = p.x;
    squad.pos.z = p.z;
    squad.prev.x = p.x;
    squad.prev.z = p.z;
    squad.y = world.terrain.heightAt(p.x, p.z);
  }
  squad.movedX = squad.pos.x;
  squad.movedZ = squad.pos.z;
  squad.movedAt = world.time;
  squad.progressAt = world.time;
  squad.repathAt = 0;
  squad.thinkAt = world.time;
}

/** Pair spearhead tanks with spearhead foot squads immediately when launching a breakthrough. */
export function pairSpearheadDesant(world: World, group: readonly Unit[]): void {
  const tanks = group.filter((u) => isTank(u) && u.riderId == null && u.hp > u.def.maxHp * 0.35);
  const foot = group.filter(canBoardTank);
  if (tanks.length === 0 || foot.length === 0) return;
  for (const t of tanks) {
    if (
      world.spatial.findOwner(
        t.pos.x,
        t.pos.z,
        DESANT.mountSafeRadiusM,
        hostileMask(world, t.owner),
        (o) => o.hp > 0 && world.isHostile(t.owner, o.owner) && world.knows(t.owner, o),
      )
    ) {
      continue;
    }
    let best: Unit | null = null;
    let bd: number = DESANT.spearBoardRadiusM;
    for (const u of foot) {
      if (u.ridingTankId != null) continue;
      const d = dist(t.pos, u.pos);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    if (best) pairTankDesant(world, t, best);
  }
}

/** Per-tick Tank Desant update: syncs riders to their carrier tank and boards nearby infantry on long advances. */
export function tankDesantTick(world: World): void {
  const units = world.aliveUnits;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.ridingTankId == null) continue;
    if (u.hp <= 0) {
      dismountTankDesant(world, u);
      continue;
    }
    const t = world.unitAlive(u.ridingTankId);
    if (!t || t.routing || u.routing || u.manual !== null || u.status === 'status.fallingBack' || aboard(t) || aboard(u)) {
      dismountTankDesant(world, u, t);
      continue;
    }
    if (t.dest && u.dest && dist(t.dest, u.dest) > 260 && !t.spearhead) {
      dismountTankDesant(world, u, t);
      continue;
    }
    if (world.time - t.lastDamagedAt < 1.5 || world.time - u.lastDamagedAt < 1.5) {
      dismountTankDesant(world, u, t);
      continue;
    }
    if (!t.moving && (!t.dest || dist(t.pos, t.dest) < DESANT.dismountArriveM)) {
      dismountTankDesant(world, u, t);
      continue;
    }
    if (t.targetId !== null) {
      const tgt = world.unitAlive(t.targetId);
      if (tgt && dist(t.pos, tgt.pos) < 155) {
        dismountTankDesant(world, u, t);
        continue;
      }
    }
    if ((world.tick + t.id) % 8 === 0) {
      const enemyR = t.spearhead ? DESANT.dismountSpearEnemyRadiusM : DESANT.dismountEnemyRadiusM;
      if (
        world.spatial.findOwner(
          t.pos.x,
          t.pos.z,
          enemyR,
          hostileMask(world, t.owner),
          (o) => o.hp > 0 && world.isHostile(t.owner, o.owner) && world.knows(t.owner, o),
        )
      ) {
        dismountTankDesant(world, u, t);
        continue;
      }
    }
    u.prev.x = t.prev.x;
    u.prev.z = t.prev.z;
    u.pos.x = t.pos.x;
    u.pos.z = t.pos.z;
    u.y = t.y;
    u.heading = t.heading;
    u.turret = t.heading;
    u.moving = t.moving;
    u.speedNow = t.speedNow;
    u.movedX = u.pos.x;
    u.movedZ = u.pos.z;
    u.movedAt = world.time;
    u.progressAt = world.time;
  }

  // Board check every 0.5 s (10 ticks)
  if (world.tick % 10 !== 0) return;
  for (let i = 0; i < units.length; i++) {
    const t = units[i];
    if (!isTank(t) || t.hp <= t.def.maxHp * 0.35) continue;
    if (t.riderId != null && !world.unitAlive(t.riderId)) t.riderId = null;
    if (t.riderId != null || t.routing || t.behavior !== 'advance' || aboard(t)) continue;
    const trip = t.dest ? dist(t.pos, t.dest) : 0;
    if (trip < DESANT.minTripM && !t.spearhead && t.opRole !== 'maneuver') continue;
    if (world.time - t.lastDamagedAt < 3.5) continue;
    if (
      world.spatial.findOwner(
        t.pos.x,
        t.pos.z,
        DESANT.mountSafeRadiusM,
        hostileMask(world, t.owner),
        (o) => o.hp > 0 && world.isHostile(t.owner, o.owner) && world.knows(t.owner, o),
      )
    ) {
      continue;
    }
    const near = world.spatial.query(t.pos.x, t.pos.z, DESANT.boardRadiusM, SC_BOARD);
    let best: Unit | null = null;
    let bd: number = DESANT.boardRadiusM;
    for (let j = 0; j < near.length; j++) {
      const u = near[j];
      if (u.owner !== t.owner || !canBoardTank(u) || u.status === 'status.fallingBack') continue;
      if (u.frontId !== t.frontId && !(t.spearhead !== null && u.spearhead === t.spearhead)) continue;
      if (u.behavior !== 'advance' && u.behavior !== 'rally') continue;
      if (world.time - u.lastDamagedAt < 3.5) continue;
      if (t.dest && u.dest && dist(t.dest, u.dest) > 260 && !t.spearhead) continue;
      const d = dist(t.pos, u.pos);
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    if (best) pairTankDesant(world, t, best);
  }
}
