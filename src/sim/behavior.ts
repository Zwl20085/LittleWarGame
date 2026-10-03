import { selectTarget, hasIndirectSolution } from './combat';
import { thinkGarrison, thinkOccupy } from './command';
import { fallBackHome } from './homeguard';
import { dig, openWork } from './works';
import { FORT } from './config';
import { moveTo, stop } from './movement';
import { lerpV } from './sectors';
import { trySpend } from './economy';
import { ESCORT_REACT_S } from './damage';
import { availableM } from './production';
import { thinkConvoyTruck } from './convoy';
import { thinkBridgeBuilder } from './engineering';
import { enemyDistance, safeRear } from './frontai';
import { enemyConvoyTargets } from './operations';
import { EAGER, eagerOn, stormOn } from './strategyai';
import { crewPost, gunPost, holdAfterFire } from './crewai';
import { coverSpot, threatCentre } from './terrainai';
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
  // Holding a point (faceFrom = the point itself): face the known threat instead.
  const from = dist(faceFrom, around) < 5 ? threatCentre(world, u.owner, around, 400) ?? faceFrom : faceFrom;
  // Buildings (lee wall = garrison), crests, town/forest ground: terrainai.coverSpot (§7.1).
  return coverSpot(world, u, around, r, from);
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
  if (u.opRole === 'maneuver' && thinkManeuver(world, u)) return;
  if (u.opRole === 'infiltrate' && thinkInfiltrator(world, u)) return;
  if (u.opRole === 'siege' && thinkSiegeParty(world, u, s)) return;
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
    // Round 2: slow guns (0.7–1 m/s) spent 60–72 % of their life walking to rally points; they go
    // straight to their firing position instead.
    if (eagerOn() && (u.def.id === 'howitzer' || u.def.id === 'mortar') && s.posture !== 'withdraw') u.behavior = 'advance';
    // Round 2: the rally point is laid out from the capital, but units spawn at the forward town
    // nearest the front — they walked back to it, waited, and walked forward again. Units already
    // nearer the objective than the rally point, and reinforcements of a group in contact, join the
    // line directly (the frontal-massing gate in sectors.eagerPush keeps attacks from trickling).
    if (eagerOn() && s.posture !== 'withdraw' && s.reason !== 'reason.outmatched'
      && (s.mode === 'hold' || s.mode === 'push' || dist(u.pos, s.targetPos) < dist(s.rally, s.targetPos) - 50)) u.behavior = 'advance';
    return;
  }
  u.behavior = 'advance';
  // Round 3: a group recalled to the capital falls back in good order before it fights again.
  if (fallBackHome(world, u, s)) return;
  switch (u.def.id) {
    case 'mortar': case 'howitzer': return thinkArtillery(world, u, s);
    case 'mg': case 'at_gun': return thinkCrewWeapon(world, u, s);
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
  if (siegeDig(world, u, s, t)) return;
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
    // Round 2: assaulting foot squads in range bound from cover to cover toward the enemy
    // (buildings' lee walls, forest edges, crests) and shoot on the move, instead of crossing open ground.
    if (eagerOn() && assault && !tanks && d < w.range) {
      // One bound at a time: no new cover search (and path) until the current bound is done.
      if (u.status === 'status.engaging' && u.path.length > 0) return;
      const ahead = lerpV(u.pos, t.pos, 0.35);
      const c = findCover(world, u, ahead, 25, t.pos);
      if (c && dist(c, t.pos) < d - 5 && dist(c, u.pos) > 3) {
        moveTo(world, u, c);
        u.status = 'status.engaging';
        return;
      }
    }
  }
  // Round 2: a group holding its line takes its slots in cover near them (the slot's cover spot is
  // cached per unit until the slot moves, so this costs one cover search per re-slot).
  if (eagerOn() && s.mode === 'hold' && !tanks && !t) {
    const slot = objectivePoint(u, s);
    if (dist(u.pos, slot) < 60) {
      moveTo(world, u, slotCover(world, u, slot, s.targetPos));
      u.status = 'status.holding';
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
  moveTo(world, u, approachPoint(u, s, objectivePoint(u, s)));
  void hq;
}

/**
 * Round 2: units far from their slot march on the group's shared front point first, so the long
 * leg reuses one cached flow field per group instead of one per slot (units now join the line
 * directly instead of gathering at the shared rally point).
 */
function approachPoint(u: Unit, s: Sector, p: V2): V2 {
  // Round 4: a capital siege / storm goes straight for its ring slot (the front point sat at a river
  // 1.2–1.9 km out and held the whole besieging army there).
  if (stormOn() && s.op === 'siege' && s.targetCity !== null && s.opPhase !== '') return p;
  return eagerOn() && dist(u.pos, p) > APPROACH_M && dist(u.pos, s.front) > APPROACH_M ? s.front : p;
}

const APPROACH_M = 350;

const slotCovers = new WeakMap<Unit, { slot: V2; at: V2 }>();

/** Cover spot within 25 m of a line slot (buildings, forest, crests), cached until the slot moves > 8 m. */
function slotCover(world: World, u: Unit, slot: V2, faceFrom: V2): V2 {
  const c = slotCovers.get(u);
  if (c && dist(c.slot, slot) < 8) return c.at;
  const at = findCover(world, u, slot, 25, faceFrom) ?? slot;
  slotCovers.set(u, { slot: { ...slot }, at });
  return at;
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
  const how = u.def.id === 'howitzer';
  // Round 2: guns sat 0.55–0.6 × range behind the line and ≥300 / 180 m from enemy ground, so the
  // nearest enemy was out of range 40–80 % of the time; deploy closer (still inside our ground).
  const ratio = eagerOn() ? (how ? EAGER.howitzerBack : EAGER.mortarBack) : how ? 0.55 : 0.6;
  const safe = eagerOn() ? (how ? EAGER.howitzerSafe : EAGER.mortarSafe) : how ? 300 : 180;
  const want0 = behind(world, u, s.front, homeFor(world, u), w.range * ratio);
  // Guns stay inside friendly territory, well clear of enemy-held ground.
  // Round 4: deploy within range of the group's fight / the besieged capital, and keep the post (crewai.ts).
  const post = stormOn() ? gunPost(world, u, s, safe) : null;
  const want = post ?? safeRear(world, u.owner, want0, homeFor(world, u), safe);
  const off = post ? { x: 0, z: 0 } : spread(u, 20);
  const pos = { x: want.x + off.x, z: want.z + off.z };
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  if (stormOn() && !t && !u.moving && holdAfterFire(world, u, true)) {
    u.status = 'status.covering';
    return;
  }
  // Shoot and scoot: after a few salvos the battery relocates (it has been sound-ranged).
  if (u.salvos >= 6 && u.setup === 'set') {
    u.salvos = 0;
    const a = ((u.vseed + Math.floor(world.time)) % 628) / 100;
    moveTo(world, u, { x: pos.x + Math.cos(a) * 80, z: pos.z + Math.sin(a) * 80 });
    u.status = 'status.relocating';
    return;
  }
  // Stay put while we have a legal target; otherwise reposition. Round 2: a gun that has a target
  // where it stands fires from there unless enemy ground is too close (it used to keep walking).
  const fireHere = eagerOn() && !!t && enemyDistance(world, u.owner, u.pos) >= safe * 0.6;
  if (t && (dist(u.pos, pos) < 140 || fireHere)) {
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
  // Round 4: on the axis of the group's fight, inside range of the enemy mass (crewai.ts).
  const post = stormOn() ? crewPost(world, u, s) : null;
  const want = post ?? slot ?? behind(world, u, front, homeFor(world, u), back);
  const off = post || slot ? { x: 0, z: 0 } : spread(u, 25);
  const pos = { x: want.x + off.x, z: want.z + off.z };
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  if (stormOn() && !t && !u.moving && holdAfterFire(world, u, false)) {
    if (u.setup === 'set') u.turret = s.facing;
    u.status = 'status.covering';
    return;
  }
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

/** Siege: riflemen and engineers dig the trench line at their ring position unless the enemy is close. */
function siegeDig(world: World, u: Unit, s: Sector, t: Unit | null): boolean {
  if (s.op !== 'siege' || s.opPhase !== 'dig' || u.def.kind !== 'infantry' || u.moraleState !== 'normal') return false;
  if (t && dist(t.pos, u.pos) < 150) return false;
  const work = openWork(world, u.owner, objectivePoint(u, s), 90);
  return !!work && dig(u, work, (p) => moveTo(world, u, p), () => stop(u));
}

/** Engineers build field cover near held objectives when posture is fortify/hold. Returns true if busy. */
function thinkEngineer(world: World, u: Unit, s: Sector): boolean {
  if (s.bridgeSite && thinkBridgeBuilder(world, u, s, s.bridgeSite)) return true;
  if (siegeDig(world, u, s, world.unitAlive(u.targetId))) return true;
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
  // Trucks under fire are listed by the damage code; no 300 m scan of all friendlies per unit.
  const hits = world.factions[u.owner].trucksUnderFire;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (world.time - h.at > ESCORT_REACT_S) continue; // retained longer for the rear-guard alert
    const o = world.unitAlive(h.id);
    if (!o || dist(o.pos, u.pos) > 300) continue;
    moveTo(world, u, o.pos);
    selectTarget(world, u, o.pos);
    u.status = 'status.escort';
    return true;
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

/** Flank / pincer manoeuvre group: march to the waypoint, then storm the objective (attack-move). */
function thinkManeuver(world: World, u: Unit): boolean {
  if (u.routing || u.manual || !u.opTarget || u.behavior === 'retreat' || u.behavior === 'recover') {
    u.opRole = 'line';
    return false;
  }
  selectTarget(world, u, u.opTarget);
  const off = spread(u, 30);
  if (u.moraleState === 'pinned') stop(u);
  else moveTo(world, u, { x: u.opTarget.x + off.x, z: u.opTarget.z + off.z });
  u.status = 'status.maneuver';
  return true;
}

/** Siege work party: dig the open trench nearest its ring post, otherwise man the post. */
function thinkSiegeParty(world: World, u: Unit, s: Sector): boolean {
  if (u.routing || u.manual || !u.opTarget || s.op !== 'siege') {
    u.opRole = 'line';
    return false;
  }
  selectTarget(world, u, s.targetPos);
  const t = world.unitAlive(u.targetId);
  const close = !!t && dist(t.pos, u.pos) < 150;
  const work = close || u.moraleState !== 'normal' ? null : openWork(world, u.owner, u.opTarget, 720);
  if (work && dig(u, work, (p) => moveTo(world, u, p), () => stop(u))) return true;
  if (dist(u.pos, u.opTarget) > 10) moveTo(world, u, u.opTarget);
  else stop(u);
  u.status = 'status.siegeLine';
  return true;
}

/** Infiltration team: slip through the gap and seize the objective; shoot back but keep moving. */
function thinkInfiltrator(world: World, u: Unit): boolean {
  if (u.routing || u.manual || !u.opTarget || u.hp < u.def.maxHp * 0.35) {
    u.opRole = 'line';
    return false;
  }
  selectTarget(world, u, u.opTarget);
  const off = spread(u, 18);
  moveTo(world, u, { x: u.opTarget.x + off.x, z: u.opTarget.z + off.z });
  u.status = 'status.infiltrating';
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
