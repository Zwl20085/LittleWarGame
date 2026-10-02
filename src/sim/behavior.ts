import { selectTarget, hasIndirectSolution } from './combat';
import { thinkGarrison, thinkOccupy } from './command';
import { FORT } from './config';
import { moveTo, stop } from './movement';
import { lerpV } from './sectors';
import { trySpend } from './economy';
import { availableM } from './production';
import { thinkConvoyTruck } from './convoy';
import { thinkBridgeBuilder } from './engineering';
import { enemyDistance, safeRear } from './frontai';
import { enemyConvoyTargets } from './operations';
import type { Sector, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/** Deterministic per-unit spread offset so a squad group doesn't stack on one point. */
function spread(u: Unit, radius: number): V2 {
  const a = ((u.vseed % 360) * Math.PI) / 180;
  const r = radius * (0.35 + ((u.vseed >>> 9) % 100) / 154);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

/** Point `back` metres from `front` toward home along the sector axis. */
function behind(world: World, u: Unit, front: V2, back: V2, metres: number): V2 {
  const d = dist(front, back);
  if (d < 1) return front;
  const t = Math.min(1, metres / d);
  const p = lerpV(front, back, t);
  const nav = world.navFor(u).nearestPassable(p, 40);
  return nav ?? p;
}

/** Look for a nearby covered cell (town/forest/free fort) within r metres. */
function findCover(world: World, u: Unit, around: V2, r: number, faceFrom: V2): V2 | null {
  for (const f of world.forts) {
    if (f.progress < 1 || f.hp <= 0 || f.kind !== 'field_cover') continue;
    if (f.occupant !== null && f.occupant !== u.id) continue;
    if (world.isHostile(u.owner, f.owner)) continue;
    if (dist(f.pos, around) < r) return f.pos;
  }
  if (world.terrain.coverAt(around.x, around.z) > 0) return around;
  let best: V2 | null = null;
  let bd = Infinity;
  const step = 10;
  for (let dx = -r; dx <= r; dx += step) {
    for (let dz = -r; dz <= r; dz += step) {
      const p = { x: around.x + dx, z: around.z + dz };
      if (!world.terrain.inBounds(p.x, p.z) || world.terrain.coverAt(p.x, p.z) === 0) continue;
      const d = dist(p, around) + dist(p, faceFrom) * 0.05;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
  }
  return best;
}

/** Next to a connected supply truck with an engineer (field repair point, §6.4). */
function nearRepairPoint(world: World, u: Unit): boolean {
  const s = world.data.rules.supply;
  for (const o of world.spatial.query(u.pos.x, u.pos.z, s.truck_recovery_radius_m)) {
    if (o.owner === u.owner && o.def.id === 'supply_truck' && o.hp > 0 && o.supplied) return true;
  }
  return false;
}

function needsRetreat(world: World, u: Unit): boolean {
  if (u.def.id === 'supply_truck') return u.hp <= u.def.maxHp * 0.3;
  if (u.hp <= u.def.maxHp * world.data.rules.morale.auto_retreat_hp_ratio) return true;
  if (!u.supplied && u.ammo < 0.05 && world.time - u.noTargetSince > 20) return true;
  return false;
}

function readyToReturn(world: World, u: Unit): boolean {
  const s = world.data.rules.supply;
  return u.hp >= u.def.maxHp * s.return_hp_ratio && u.morale >= s.return_morale && u.ammo >= s.return_ammo_ratio;
}

/** Unit executor (≈0.4 s): choose behaviour + destination, then pick targets. */
export function thinkUnit(world: World, u: Unit): void {
  if (u.hp <= 0) return;
  const f = world.factions[u.owner];
  const s = f.sectors[u.sectorId] ?? f.sectors[0];
  if (u.fixed) {
    selectTarget(world, u, null);
    return;
  }
  if (u.behavior === 'evacuate') {
    stop(u);
    return;
  }
  const hq = world.hqPos(u.owner);
  // Routing is not overridable by orders (§5).
  if (u.routing) {
    if (u.behavior !== 'routing') world.note(u.owner, 'log.unitRouting', { unit: u.def.id }, 'info');
    u.behavior = 'routing';
    u.status = 'status.routing';
    moveTo(world, u, behind(world, u, hq, hq, 0));
    u.targetId = null;
    return;
  }
  // Rout over: keep falling back to the recovery zone instead of idling at the front.
  if (u.behavior === 'routing') u.behavior = 'retreat';

  if (u.manual && runManual(world, u)) return;

  if (u.behavior !== 'retreat' && u.behavior !== 'recover' && needsRetreat(world, u)) {
    u.behavior = 'retreat';
    u.status = 'status.retreat';
  }
  if (u.behavior === 'retreat') {
    const zone = lerpV(hq, world.cityOf(u.owner).exit, 1.2);
    moveTo(world, u, { x: zone.x + spread(u, 30).x, z: zone.z + spread(u, 30).z });
    if (dist(u.pos, hq) < world.data.rules.supply.city_recovery_radius_m) u.behavior = 'recover';
    selectTarget(world, u, null);
    return;
  }
  if (u.behavior === 'recover') {
    if (dist(u.pos, hq) > world.data.rules.supply.city_recovery_radius_m && !nearRepairPoint(world, u)) {
      u.behavior = 'retreat';
      return;
    }
    u.status = 'status.recovering';
    stop(u);
    if (readyToReturn(world, u)) u.behavior = 'rally';
    selectTarget(world, u, null);
    return;
  }
  if (u.def.id === 'supply_truck') return thinkConvoyTruck(world, u);
  if (u.spearhead && thinkSpearhead(world, u)) return;
  if (u.opRole === 'garrison' && thinkGarrison(world, u)) return;
  if (u.opRole === 'occupy' && thinkOccupy(world, u)) return;
  if (u.opRole === 'raid' && thinkOpRaid(world, u)) return;
  if (u.opRole === 'rearguard' && thinkRearGuard(world, u)) return;
  if ((u.def.id === 'recon' || u.def.id === 'light_tank') && thinkRaid(world, u)) return;
  if (u.def.kind !== 'crew' && thinkEscort(world, u)) return;
  if (s.posture === 'withdraw') {
    u.behavior = 'rally';
    u.status = 'status.withdraw';
  }
  if (u.behavior === 'rally') {
    u.status = 'status.rally';
    const p = { x: s.rally.x + spread(u, 35).x, z: s.rally.z + spread(u, 35).z };
    moveTo(world, u, p);
    selectTarget(world, u, s.targetPos);
    // Support units do not wait for the infantry gate.
    if (u.def.kind !== 'infantry' && s.posture !== 'withdraw' && dist(u.pos, s.rally) < 70) u.behavior = 'advance';
    if (u.def.id === 'recon' && s.posture !== 'withdraw') u.behavior = 'advance';
    return;
  }
  u.behavior = 'advance';
  switch (u.def.id) {
    case 'mortar': case 'howitzer': return thinkArtillery(world, u, s);
    case 'mg': case 'at_gun': case 'aa': return thinkCrewWeapon(world, u, s);
    case 'recon': return thinkRecon(world, u, s);
    case 'engineer': if (thinkEngineer(world, u, s)) return; break;
    default: break;
  }
  thinkAssault(world, u, s);
}

function thinkAssault(world: World, u: Unit, s: Sector): void {
  const hq = world.hqPos(u.owner);
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  const atObjective = dist(u.pos, s.targetPos) < 30;
  const holdish = s.posture === 'hold' || s.posture === 'fortify';
  const tanks = u.def.kind === 'vehicle';
  const w = u.primary;
  if (t && w) {
    const d = dist(u.pos, t.pos);
    if (u.moraleState !== 'normal') {
      // Suppressed: go to ground; crawl to cover if close.
      const c = findCover(world, u, u.pos, 20, t.pos);
      if (c && dist(c, u.pos) > 3) moveTo(world, u, c);
      else stop(u);
      u.status = 'status.suppressed';
      return;
    }
    const assault = s.posture === 'assault';
    if (!assault && d < w.range * (tanks ? 0.9 : 0.8)) {
      const c = tanks ? null : findCover(world, u, u.pos, 25, t.pos);
      if (c && dist(c, u.pos) > 3) moveTo(world, u, c);
      else stop(u);
      u.status = 'status.engaging';
      // Cautious push: when the enemy is pinned or we outnumber locally, bound forward.
      if (t.moraleState !== 'normal' || t.routing) moveTo(world, u, objectivePoint(u, s));
      return;
    }
  }
  if (holdish && atObjective) {
    const c = findCover(world, u, s.targetPos, 30, s.targetPos);
    moveTo(world, u, c ?? objectivePoint(u, s));
    u.status = 'status.holding';
    return;
  }
  u.status = s.targetCity !== null ? 'status.assaultCity' : 'status.advancing';
  moveTo(world, u, objectivePoint(u, s));
  void hq;
}

/** The unit's place on its group's battle line (falls back to a spread around the target). */
function objectivePoint(u: Unit, s: Sector): V2 {
  const slot = s.slots[u.id];
  if (slot) return slot;
  const off = spread(u, s.targetCity !== null ? 18 : 22);
  return { x: s.front.x + off.x, z: s.front.z + off.z };
}

function homeFor(world: World, u: Unit): V2 {
  return world.cityOf(u.owner).exit;
}

function thinkArtillery(world: World, u: Unit, s: Sector): void {
  const w = u.primary!;
  const ratio = u.def.id === 'howitzer' ? 0.55 : 0.6;
  const want0 = behind(world, u, s.front, homeFor(world, u), w.range * ratio);
  // Guns stay inside friendly territory, well clear of enemy-held ground.
  const want = safeRear(world, u.owner, want0, homeFor(world, u), u.def.id === 'howitzer' ? 300 : 180);
  const off = spread(u, 20);
  const pos = { x: want.x + off.x, z: want.z + off.z };
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  // Shoot and scoot: after a few salvos the battery relocates (it has been sound-ranged).
  if (u.salvos >= 6 && u.setup === 'set') {
    u.salvos = 0;
    const a = ((u.vseed + Math.floor(world.time)) % 628) / 100;
    moveTo(world, u, { x: pos.x + Math.cos(a) * 80, z: pos.z + Math.sin(a) * 80 });
    u.status = 'status.relocating';
    return;
  }
  // Stay put while we have a legal target; otherwise reposition.
  if (t && dist(u.pos, pos) < 140) {
    if (u.setup !== 'set' && !u.moving) stop(u);
    if (!hasIndirectSolution(world, u, w, t.pos)) u.status = 'status.noArc';
    else u.status = 'status.firing';
    stop(u);
    return;
  }
  u.status = 'status.positioning';
  if (dist(u.pos, pos) > 25) moveTo(world, u, pos);
  else stop(u);
}

function thinkCrewWeapon(world: World, u: Unit, s: Sector): void {
  const back = u.def.id === 'mg' ? 45 : u.def.id === 'at_gun' ? 60 : 130;
  const front = s.front;
  const slot = s.slots[u.id];
  const want = slot ?? behind(world, u, front, homeFor(world, u), back);
  const off = slot ? { x: 0, z: 0 } : spread(u, 25);
  const pos = { x: want.x + off.x, z: want.z + off.z };
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  if (t && u.setup === 'set') {
    u.status = 'status.firing';
    stop(u);
    return;
  }
  // Has a target but packed: set up here instead of walking into fire.
  if (t && dist(u.pos, t.pos) < (u.primary?.range ?? 100) * 0.95) {
    stop(u);
    u.status = 'status.settingUp';
    return;
  }
  if (dist(u.pos, pos) > 20) {
    u.status = 'status.positioning';
    moveTo(world, u, pos);
  } else {
    stop(u);
    if (u.setup === 'set') u.turret = s.facing;
    u.status = u.setup === 'set' ? 'status.covering' : 'status.settingUp';
  }
}

function thinkRecon(world: World, u: Unit, s: Sector): void {
  selectTarget(world, u, s.targetPos);
  const threatNear = world.spatial.query(u.pos.x, u.pos.z, 110).some((o) => o.hp > 0 && world.isHostile(u.owner, o.owner) && world.knows(u.owner, o));
  const obs = behind(world, u, s.front, homeFor(world, u), threatNear ? 140 : 40);
  const off = spread(u, 30);
  const pos = { x: obs.x + off.x, z: obs.z + off.z };
  const c = findCover(world, u, pos, 30, s.targetPos);
  moveTo(world, u, c ?? pos);
  u.status = 'status.observing';
}

/** Engineers build field cover near held objectives when posture is fortify/hold. Returns true if busy. */
function thinkEngineer(world: World, u: Unit, s: Sector): boolean {
  if (s.bridgeSite && thinkBridgeBuilder(world, u, s, s.bridgeSite)) return true;
  if (s.posture !== 'fortify' && s.posture !== 'hold') return false;
  const obj = world.objectives.find((o) => o.id === s.targetObjective);
  if (!obj || obj.owner !== u.owner) return false;
  let fort = world.forts.find((f) => f.id === u.buildTargetId && f.progress < 1 && f.hp > 0);
  const f = world.factions[u.owner];
  if (!fort) {
    const existing = world.forts.filter((x) => x.owner === u.owner && dist(x.pos, obj.pos) < 80 && x.hp > 0);
    if (existing.length >= 3) return false;
    const enemyDir = nearestEnemyBearing(world, u.owner, obj.pos);
    const a = enemyDir + ((existing.length - 1) * Math.PI) / 5;
    const pos = { x: obj.pos.x + Math.cos(a) * 32, z: obj.pos.z + Math.sin(a) * 32 };
    if (existing.some((x) => dist(x.pos, pos) < 25)) return false;
    // Works budget ~60 M/min per faction (one 30 M cover per 30 s) and never the protected reserve.
    if (world.time - f.lastWorksAt < 30 || availableM(world, f) < FORT.field_cover.costM || !trySpend(f, 0, FORT.field_cover.costM).ok) {
      u.status = 'status.noBudget';
      return false;
    }
    fort = { id: world.newId(), owner: u.owner, kind: 'field_cover', pos, facing: enemyDir, hp: FORT.field_cover.hp, maxHp: FORT.field_cover.hp, progress: 0, occupant: null };
    world.forts.push(fort);
    f.lastWorksAt = world.time;
    u.buildTargetId = fort.id;
  }
  if (dist(u.pos, fort.pos) > 12) moveTo(world, u, fort.pos);
  else {
    stop(u);
    if (u.moraleState === 'normal') fort.progress = Math.min(1, fort.progress + 0.4 / FORT.field_cover.work);
  }
  u.status = 'status.building';
  selectTarget(world, u, s.targetPos);
  return true;
}

function nearestEnemyBearing(world: World, f: number, from: V2): number {
  let best = 0;
  let bd = Infinity;
  for (const e of world.factions) {
    if (!e.alive || !world.isHostile(f, e.id)) continue;
    const d = dist(world.hqPos(e.id), from);
    if (d < bd) {
      bd = d;
      best = headingTo(from, world.hqPos(e.id));
    }
  }
  return best;
}

/**
 * Raiders (recon, light tanks) hunt known enemy supply trucks behind the lines when they are
 * not tied up in a fight — cutting convoy chains starves the enemy front of ammunition.
 */
function thinkRaid(world: World, u: Unit): boolean {
  if (u.manual || u.behavior !== 'advance' || u.routing) return false;
  let t = world.unitAlive(u.raidTargetId);
  if (t && (!world.knows(u.owner, t) || dist(t.pos, u.pos) > 650)) t = null;
  if (!t) {
    u.raidTargetId = null;
    // Not while engaged with combat units nearby.
    const engaged = world.spatial.query(u.pos.x, u.pos.z, 160).some((o) => o.hp > 0 && world.isHostile(u.owner, o.owner) && o.primary && world.knows(u.owner, o));
    if (engaged || (u.id + Math.floor(world.time / 10)) % 3 !== 0) return false;
    let bd = 450;
    for (const o of world.spatial.query(u.pos.x, u.pos.z, 450)) {
      if (o.hp > 0 && o.def.id === 'supply_truck' && world.isHostile(u.owner, o.owner) && world.knows(u.owner, o)) {
        const d = dist(o.pos, u.pos);
        if (d < bd) { bd = d; t = o; }
      }
    }
    if (!t) return false;
    u.raidTargetId = t.id;
    world.note(u.owner, 'log.raid', { unit: u.def.id }, 'info');
  }
  selectTarget(world, u, t.pos);
  if (u.primary && dist(u.pos, t.pos) < u.primary.range * 0.85) {
    u.targetId = t.id;
    u.targetSince = world.time;
    stop(u);
  } else moveTo(world, u, t.pos);
  u.status = 'status.raiding';
  return true;
}

/** Combat units near a friendly truck that is under fire move to protect the supply line. */
function thinkEscort(world: World, u: Unit): boolean {
  if (u.manual || u.behavior !== 'advance' || u.routing || u.def.id === 'supply_truck' || !u.primary) return false;
  if (world.unitAlive(u.targetId)) return false;
  for (const o of world.spatial.queryOwners(u.pos.x, u.pos.z, 300, 1 << u.owner)) {
    if (o.owner === u.owner && o.def.id === 'supply_truck' && o.hp > 0 && world.time - o.lastDamagedAt < 6) {
      moveTo(world, u, o.pos);
      selectTarget(world, u, o.pos);
      u.status = 'status.escort';
      return true;
    }
  }
  return false;
}

/** Manual command lifecycle (VISUAL_UX §5.2). Returns true if a manual task controlled the unit. */
function runManual(world: World, u: Unit): boolean {
  const m = u.manual!;
  const mc = world.data.rules.manual_control;
  switch (m.type) {
    case 'move': {
      moveTo(world, u, m.dest);
      if (u.pathFailed) {
        world.note(u.owner, 'log.unreachable', { unit: u.def.id }, 'warn');
        return finishManual(world, u);
      }
      selectTarget(world, u, null);
      u.status = 'status.manualMove';
      if (dist(u.pos, m.dest) <= mc.move_completion_radius_m) {
        if (m.arrivedAt === null) m.arrivedAt = world.time;
        if (!m.hold && world.time - m.arrivedAt >= mc.move_completion_hold_seconds) return finishManual(world, u);
        if (m.hold) u.manual = { type: 'hold', pos: { ...m.dest } };
      }
      return true;
    }
    case 'attackMove': {
      selectTarget(world, u, m.dest);
      const t = world.unitAlive(u.targetId);
      if (t && !u.primary?.canFireMoving) stop(u);
      else moveTo(world, u, m.dest);
      u.status = 'status.manualAttackMove';
      if (dist(u.pos, m.dest) < 15 && !t) {
        if (m.clearSince === null) m.clearSince = world.time;
        if (world.time - m.clearSince >= mc.attack_move_clear_seconds) return finishManual(world, u);
      } else m.clearSince = null;
      return true;
    }
    case 'focus': {
      const t = world.unitAlive(m.targetId);
      if (!t || world.time - m.startedAt > mc.focus_max_seconds || (!world.knows(u.owner, t))) return finishManual(world, u);
      u.targetId = t.id;
      u.targetSince = world.time;
      const w = u.primary;
      const d = dist(u.pos, t.pos);
      if (w && d > w.range * 0.9) moveTo(world, u, t.pos);
      else stop(u);
      u.status = 'status.manualFocus';
      return true;
    }
    case 'retreat': {
      const hq = world.hqPos(u.owner);
      moveTo(world, u, lerpV(hq, world.cityOf(u.owner).exit, 1.2));
      selectTarget(world, u, null);
      u.status = 'status.manualRetreat';
      if (dist(u.pos, hq) < world.data.rules.supply.city_recovery_radius_m) {
        u.manual = null;
        u.behavior = 'recover';
      }
      return true;
    }
    case 'hold': {
      if (dist(u.pos, m.pos) > 6) moveTo(world, u, m.pos);
      else stop(u);
      selectTarget(world, u, null);
      u.status = 'status.manualHold';
      return true;
    }
  }
}

function finishManual(world: World, u: Unit): boolean {
  u.manual = u.queue.shift() ?? null;
  if (!u.manual) {
    u.behavior = 'advance';
    world.note(u.owner, 'log.resumeAuto', { unit: u.def.id }, 'info');
  }
  return false;
}

/** Spearhead: drive past the front to the breakthrough objective; done once it is ours. */
function thinkSpearhead(world: World, u: Unit): boolean {
  const id = u.spearhead!;
  let pos: V2 | null = null;
  if (id.startsWith('hq:')) {
    const e = Number(id.slice(3));
    if (world.factions[e]?.alive) pos = world.hqPos(e);
  } else {
    const o = world.objectives.find((x) => x.id === id);
    if (o && o.owner !== u.owner) pos = o.pos;
  }
  if (!pos || u.routing || u.behavior === 'retreat' || u.behavior === 'recover') {
    u.spearhead = null;
    return false;
  }
  selectTarget(world, u, pos);
  const off = spread(u, 24);
  if (u.moraleState === 'pinned') stop(u);
  else moveTo(world, u, { x: pos.x + off.x, z: pos.z + off.z });
  u.status = 'status.spearhead';
  return true;
}

/** Raid detachment: infiltrate to the enemy rear, ambush convoys, come home when time is up. */
function thinkOpRaid(world: World, u: Unit): boolean {
  if (u.routing || u.manual || world.time > u.opUntil || u.hp < u.def.maxHp * 0.4 || !u.opTarget) {
    u.opRole = 'line';
    u.opTarget = null;
    return false;
  }
  const trucks = enemyConvoyTargets(world, u.owner, u.pos, 450);
  const truck = trucks.sort((a, b) => dist(a.pos, u.pos) - dist(b.pos, u.pos))[0];
  const goal = truck ? truck.pos : u.opTarget;
  selectTarget(world, u, goal);
  if (truck && u.primary && dist(u.pos, truck.pos) < u.primary.range * 0.85) {
    u.targetId = truck.id;
    u.targetSince = world.time;
    stop(u);
  } else moveTo(world, u, goal);
  u.status = 'status.raiding';
  return true;
}

/** Rear guard: hold posts along our convoy routes and hunt raiders that show up behind the lines. */
function thinkRearGuard(world: World, u: Unit): boolean {
  if (u.routing || u.manual) return false;
  let raider: Unit | null = null;
  let bd = 420;
  for (const o of world.spatial.query(u.pos.x, u.pos.z, 420)) {
    if (o.hp <= 0 || !world.isHostile(u.owner, o.owner) || !world.knows(u.owner, o) || !o.primary) continue;
    if (enemyDistance(world, u.owner, o.pos) < 120) continue; // that's the front, not a raider
    const d = dist(o.pos, u.pos);
    if (d < bd) { bd = d; raider = o; }
  }
  if (raider) {
    moveTo(world, u, raider.pos);
    selectTarget(world, u, raider.pos);
    u.status = 'status.huntRaiders';
    return true;
  }
  if (u.opTarget && dist(u.pos, u.opTarget) > 25) moveTo(world, u, u.opTarget);
  else stop(u);
  selectTarget(world, u, null);
  u.status = 'status.rearGuard';
  return true;
}
