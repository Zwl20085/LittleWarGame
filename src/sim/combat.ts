import type { WeaponDef } from '../data/types';
import { arcClear, solveArc } from './ballistics';
import { COMBAT, DISPERSION, TERRAIN_COMBAT } from './config';
import { addSuppression, coverAgainst, resolveBlast, resolveDirectHit } from './damage';
import { firepowerScale, hitProbability } from './formulas';
import type { Projectile, Unit, V3 } from './types';
import { revealBattery } from './operations';
import { recordShot } from './stats';
import { sightLine } from './buildings';
import { forestConcealed, hasHighObserver, shotTerrainMul } from './terrainrules';
import { hostileMask } from './spatial';
import { angleDiff, DEG, dist, headingTo, turnToward, type V2 } from './vec';
import type { World } from './world';

/**
 * Reusable result arrays for the spatial queries below (no per-call allocation). Each call site
 * has its own: a loop over one of them may call a helper that queries with another, never the same.
 */
const SC_CANDS: Unit[] = [];
const SC_CLUSTER: Unit[] = [];
const SC_RISK: Unit[] = [];
const SC_SECONDARY: Unit[] = [];
const SC_OBSERVER: Unit[] = [];
const SC_RECON: Unit[] = [];
const SC_AP: Unit[] = [];

export const muzzleHeight = (u: Unit): number => (u.def.kind === 'vehicle' ? 2.4 : u.def.kind === 'crew' ? 1.3 : 1.6);
export const centerHeight = (u: Unit): number => (u.def.kind === 'vehicle' ? 1.5 : 0.9);
const hitRadius = (u: Unit): number => (u.def.kind === 'vehicle' ? 3.2 : 4.5);

const isIndirect = (w: WeaponDef): boolean => w.fireMode === 'ballistic';
const needsSetup = (u: Unit): boolean => u.def.setupSeconds > 0;

export type FireBlock = 'RANGE' | 'MIN_RANGE' | 'NO_LOS' | 'NOT_SET' | 'MOVING' | 'NO_AMMO' | 'ROUTING' | 'NO_ARC' | 'UNKNOWN' | 'NO_DAMAGE';

/** Can weapon `w` of `u` legally engage ground unit `t` right now (ignores facing; facing is handled by turning). */
export function canEngage(world: World, u: Unit, w: WeaponDef, t: Unit): FireBlock | null {
  if (u.routing) return 'ROUTING';
  if (!world.knows(u.owner, t) && !recentlySeen(world, u.owner, t.id)) return 'UNKNOWN';
  const d = dist(u.pos, t.pos);
  const range = w.range;
  if (range <= 0) return 'NO_DAMAGE';
  if (d > range) return 'RANGE';
  if (d < w.minRange) return 'MIN_RANGE';
  if (u.ammo + 1e-9 < w.ammoCost) return 'NO_AMMO';
  if (needsSetup(u) && u.setup !== 'set') return 'NOT_SET';
  if (u.moving && !w.canFireMoving) return 'MOVING';
  if (isIndirect(w) && !hasIndirectSolution(world, u, w, t.pos)) return 'NO_ARC';
  if (!isIndirect(w)) {
    // Small arms cannot hurt real armour (pen ≤15 vs armour >20) — don't waste time.
    if (w.penetration <= COMBAT.smallArmsPenCutoff && t.def.armorSide > COMBAT.smallArmsArmorCutoff) return 'NO_DAMAGE';
    // Forest hides units that hold fire; garrisons fire through windows (BALANCE_SPEC §7.1).
    if (forestConcealed(world, u.pos, t)) return 'NO_LOS';
    if (!sightLine(world, u, muzzleHeight(u), t, centerHeight(t))) return 'NO_LOS';
  }
  return null;
}

function recentlySeen(world: World, f: number, id: number): boolean {
  const s = world.lastSeen[f].get(id);
  return !!s && world.tick - s.tick <= world.data.rules.information.enemy_memory_seconds * world.tickHz;
}

/** Weapon/target role suitability matrix (AGENT_HANDOFF §4.4). */
function suitability(w: WeaponDef, t: Unit): number {
  const veh = t.def.kind === 'vehicle';
  const armored = veh && t.def.armorSide > 20;
  switch (w.id) {
    case 'rifle': case 'recon_rifle': case 'engineer_rifle': case 'mg': case 'coax_mg':
      return armored ? 0 : veh ? 0.6 : t.def.kind === 'crew' ? 0.8 : 1;
    case 'at_cannon':
      return armored ? 1 : veh ? 0.8 : t.def.kind === 'crew' ? 0.5 : 0.25;
    case 'light_cannon': case 'medium_cannon': case 'heavy_cannon':
      return armored ? 1 : t.def.kind === 'crew' ? 0.85 : 0.6;
    case 'mortar_shell': case 'howitzer_shell':
      return veh ? 0.25 : t.setup === 'set' || t.fixed || t.fortId !== null ? 1 : 0.8;
    default:
      return 0.5;
  }
}

function threatOf(t: Unit, me: Unit): number {
  const w = t.primary;
  if (!w) return 0;
  const vsMe = me.def.kind === 'vehicle' && me.def.armorSide > 20 ? (w.penetration > me.def.armorSide - 30 ? 1 : 0.1) : me.def.kind === 'vehicle' ? 0.6 : 1;
  return Math.min(1, ((w.damage / w.interval) / 40) * vsMe);
}

/** Pick a target with the weighted score + 20 % switch margin + 2 s hold. */
export function selectTarget(world: World, u: Unit, objective: V2 | null): void {
  const w = u.primary;
  if (!w) {
    u.targetId = null;
    return;
  }
  const cur = world.unitAlive(u.targetId);
  const radius = w.range;
  // Only hostiles can score: owner-filtered query skips friendly-only cells (same order).
  const cands = world.spatial.queryOwners(u.pos.x, u.pos.z, radius, hostileMask(world, u.owner), SC_CANDS);
  let best: Unit | null = null;
  let bestScore = -1;
  let curScore = -1;
  for (const t of cands) {
    if (t.hp <= 0 || !world.isHostile(u.owner, t.owner)) continue;
    const suit = suitability(w, t);
    if (suit <= 0) continue;
    const block = canEngage(world, u, w, t);
    if (block !== null && block !== 'NOT_SET' && block !== 'MOVING') continue;
    const d = dist(u.pos, t.pos);
    const objRel = objective ? Math.max(0, 1 - dist(t.pos, objective) / 300) : 0.5;
    const convoyBonus = t.def.id === 'supply_truck' ? 0.15 : 0;
    let score = convoyBonus + 0.3 * threatOf(t, u) + 0.25 * suit + 0.2 * objRel + 0.15 * (1 - d / radius) + (t.id === u.targetId ? 0.1 : 0);
    if (isIndirect(w)) score += clusterBonus(world, t) * 0.2 - friendlyRisk(world, u, t.pos, w) * 2 + counterBatteryBonus(world, u.owner, t);
    if (t.id === u.targetId) curScore = score;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (cur && curScore >= 0 && best && best.id !== cur.id) {
    const held = world.time - u.targetSince < COMBAT.targetHoldSeconds;
    if (held || bestScore < curScore * (1 + COMBAT.targetSwitchMargin)) return;
  }
  if (best && bestScore > 0) {
    if (best.id !== u.targetId) u.targetSince = world.time;
    u.targetId = best.id;
    u.targetScore = bestScore;
  } else {
    u.targetId = null;
  }
}

function clusterBonus(world: World, t: Unit): number {
  let n = 0;
  for (const o of world.spatial.query(t.pos.x, t.pos.z, 25, SC_CLUSTER)) if (o.owner === t.owner && o.hp > 0) n++;
  return Math.min(1, (n - 1) / 3);
}

/** Expected friendly harm ratio for an indirect shot at `aim` (§8.3); >0 means risky. */
function friendlyRisk(world: World, u: Unit, aim: V2, w: WeaponDef): number {
  const sigma = (w.id === 'mortar_shell' ? DISPERSION.mortar_shell : DISPERSION.howitzer_shell);
  const r = DISPERSION.ninetyFiveFactor * (sigma.base + sigma.perRange * dist(u.pos, aim)) + w.blastRadius;
  let friend = 0;
  let enemy = 0;
  for (const o of world.spatial.query(aim.x, aim.z, r, SC_RISK)) {
    if (o.hp <= 0) continue;
    const v = o.def.costP + o.def.costM;
    if (o.owner === u.owner) friend += v;
    else if (world.isHostile(u.owner, o.owner)) enemy += v;
  }
  return friend > 0.2 * enemy ? 1 : 0;
}

function intervalMul(world: World, u: Unit): number {
  const s = world.data.rules.supply;
  let m = 1;
  if (u.ammo < s.critical_ammo_threshold) m *= s.critical_ammo_interval_multiplier;
  else if (u.ammo < s.low_ammo_threshold) m *= s.low_ammo_interval_multiplier;
  if (u.moraleState === 'pinned') m *= 1.5;
  return m;
}

/** Rotate turret/crew mount toward the target; returns true when aligned enough to fire. */
function aim(world: World, u: Unit, at: V2): boolean {
  const want = headingTo(u.pos, at);
  const k = u.def.kind;
  if (k === 'infantry') {
    u.turret = want;
    return true;
  }
  const rate = k === 'vehicle' ? u.def.turretTurnDegps : COMBAT.setupTurnDegps;
  if (k === 'vehicle' && rate === 0) return true;
  u.turret = turnToward(u.turret, want, rate * DEG * world.dt);
  if (k === 'crew' && u.setup === 'set' && !u.moving) u.heading = u.turret;
  return Math.abs(angleDiff(u.turret, want)) < 6 * DEG;
}

/** Per-tick weapon handling for one unit. */
export function updateWeapons(world: World, u: Unit): void {
  if (u.hp <= 0 || u.behavior === 'evacuate' || u.mounted || world.time < u.mountUntil) return;
  u.cooldown1 = Math.max(0, u.cooldown1 - world.dt);
  u.cooldown2 = Math.max(0, u.cooldown2 - world.dt);
  if (u.routing) return;
  const w = u.primary;
  if (w) {
    const t = world.unitAlive(u.targetId);
    if (t) {
      const aligned = aim(world, u, t.pos);
      if (aligned && u.cooldown1 <= 0 && canEngage(world, u, w, t) === null && fire(world, u, w, t)) {
        u.cooldown1 = w.interval * intervalMul(world, u);
      }
    } else if (needsSetup(u) && !u.moving && u.def.kind === 'crew') {
      // idle crew keeps facing its mount direction
    } else if (u.def.kind === 'vehicle') {
      u.turret = turnToward(u.turret, u.heading, u.def.turretTurnDegps * DEG * world.dt);
    }
  }
  const w2 = u.secondary;
  if (w2 && u.cooldown2 <= 0) {
    const t2 = pickSecondaryTarget(world, u, w2);
    if (t2 && fire(world, u, w2, t2)) u.cooldown2 = w2.interval * intervalMul(world, u);
    else u.cooldown2 = COMBAT.secondaryRetrySeconds; // nothing in range: don't rescan every tick
  }
}

function pickSecondaryTarget(world: World, u: Unit, w: WeaponDef): Unit | null {
  const primaryT = world.unitAlive(u.targetId);
  if (primaryT && primaryT.def.kind !== 'vehicle' && dist(u.pos, primaryT.pos) <= w.range && canEngage(world, u, w, primaryT) === null) return primaryT;
  let best: Unit | null = null;
  let bd = Infinity;
  for (const t of world.spatial.queryOwners(u.pos.x, u.pos.z, w.range, hostileMask(world, u.owner), SC_SECONDARY)) {
    if (t.hp <= 0 || t.def.kind === 'vehicle' || !world.isHostile(u.owner, t.owner)) continue;
    const d = dist(u.pos, t.pos);
    if (d < bd && canEngage(world, u, w, t) === null) {
      bd = d;
      best = t;
    }
  }
  return best;
}

function muzzlePos(u: Unit): V3 {
  const off = u.def.kind === 'vehicle' ? 3 : 0.5;
  return { x: u.pos.x + Math.cos(u.turret) * off, y: u.y + muzzleHeight(u), z: u.pos.z + Math.sin(u.turret) * off };
}

/** Fire one event; ammo and the muzzle effect are only spent when a round actually leaves. */
function fire(world: World, u: Unit, w: WeaponDef, t: Unit): boolean {
  const m = muzzlePos(u);
  if (w.fireMode === 'hitscan') fireHitscan(world, u, w, t, m);
  else if (w.fireMode === 'direct_projectile') fireDirect(world, u, w, t, m);
  else if (!fireIndirect(world, u, w, t, m)) return false;
  u.ammo = Math.max(0, u.ammo - w.ammoCost);
  u.lastFiredAt = world.time;
  recordShot(world.stats, u);
  if (w.fireMode === 'ballistic') {
    // Sound ranging: the enemy gets a rough fix on a firing battery (counter-battery intel).
    revealBattery(world, u, world.batteryReveals);
    u.salvos++;
  }
  world.emit({ t: 'muzzle', pos: m, dir: u.turret, big: w.fireMode !== 'hitscan', weapon: w.id });
  return true;
}

function fireHitscan(world: World, u: Unit, w: WeaponDef, t: Unit, m: V3): void {
  const d = dist(u.pos, t.pos);
  const cover = coverAgainst(world, t, u.pos);
  const p = hitProbability({
    baseAccuracy: w.accuracy, distance: d, maxRange: w.range, shooterMoving: u.moving,
    shooterSuppressed: u.moraleState !== 'normal', targetMoving: t.moving, cover,
    terrainMul: shotTerrainMul(world, u, t, u.y + muzzleHeight(u)),
  });
  const hit = world.rngCombat.chance(p);
  const fp = firepowerScale(u.def, u.hp, u.fixed ? 1400 : u.def.maxHp);
  const to: V3 = { x: t.pos.x + world.rngScatter.range(-2.5, 2.5), y: t.y + centerHeight(t), z: t.pos.z + world.rngScatter.range(-2.5, 2.5) };
  if (!hit) {
    to.x += world.rngScatter.range(-4, 4);
    to.z += world.rngScatter.range(-4, 4);
    to.y = world.terrain.heightAt(to.x, to.z);
  }
  world.emit({ t: 'tracer', from: m, to, hit, weapon: w.id });
  // Resolved after every unit has fired this tick, so a same-tick duel is order-independent (§5).
  const from = { ...u.pos };
  const owner = u.owner;
  const src = u.def.id;
  if (hit) world.deferred.push(() => resolveDirectHit(world, t, from, owner, w, fp, src));
  else if (t.def.kind !== 'vehicle') world.deferred.push(() => addSuppression(world, t, w.suppression * COMBAT.nearMissSuppressionMul * fp));
}

function fireDirect(world: World, u: Unit, w: WeaponDef, t: Unit, m: V3): void {
  const d = dist(u.pos, t.pos);
  const p = hitProbability({
    baseAccuracy: w.accuracy, distance: d, maxRange: w.range, shooterMoving: u.moving,
    shooterSuppressed: u.moraleState !== 'normal', targetMoving: t.moving, cover: coverAgainst(world, t, u.pos),
    terrainMul: shotTerrainMul(world, u, t, u.y + muzzleHeight(u)),
  });
  const hit = world.rngCombat.chance(p);
  const aimPt: V3 = { x: t.pos.x, y: t.y + centerHeight(t), z: t.pos.z };
  if (!hit) {
    // Deterministic miss offset: lateral + long/short, decided now (no second pHit roll on impact).
    const bearing = headingTo(u.pos, t.pos);
    const lat = (world.rngCombat.chance(0.5) ? 1 : -1) * world.rngCombat.range(4, 9);
    const lon = world.rngCombat.range(-10, 14);
    aimPt.x += Math.cos(bearing) * lon - Math.sin(bearing) * lat;
    aimPt.z += Math.sin(bearing) * lon + Math.cos(bearing) * lat;
    aimPt.y = world.terrain.heightAt(aimPt.x, aimPt.z) + 0.5;
  }
  const g = world.data.rules.simulation.gravity_mps2;
  const dd = Math.hypot(aimPt.x - m.x, aimPt.y - m.y, aimPt.z - m.z);
  const tf = Math.max(0.05, dd / w.muzzleSpeed);
  const vel: V3 = { x: (aimPt.x - m.x) / tf, y: (aimPt.y - m.y) / tf + 0.5 * g * tf, z: (aimPt.z - m.z) / tf };
  const fp = firepowerScale(u.def, u.hp, u.def.maxHp);
  spawnProjectile(world, {
    owner: u.owner, weapon: w, kind: 'ap', pos: m, vel, targetId: t.id, intendedHit: hit, sourceId: u.id, srcType: u.def.id,
    damage: w.damage * fp, blastRadius: w.blastRadius, suppression: w.suppression, penetration: w.penetration,
  });
}

/** Dispersion sigma for indirect fire (§8.2). */
export function indirectSigma(world: World, u: Unit, w: WeaponDef, t: Unit, range: number): number {
  const base = w.id === 'mortar_shell' ? DISPERSION.mortar_shell : DISPERSION.howitzer_shell;
  let sigma = base.base + base.perRange * range;
  const observed = world.visibleTo[u.owner].has(t.id) || observedByAny(world, u.owner, t);
  if (!observed) sigma *= recentlySeen(world, u.owner, t.id) ? DISPERSION.staleIntelMul : DISPERSION.noObserverMul;
  if (hasReconSpotter(world, u.owner, t)) sigma *= DISPERSION.reconMul;
  // Observer on a crest (≥ 8 m above the target) or a church or tower: tighter fall of shot.
  if (observed && hasHighObserver(world, u.owner, t)) sigma *= TERRAIN_COMBAT.highObserverSigmaMul;
  return sigma;
}

function observedByAny(world: World, f: number, t: Unit): boolean {
  for (const o of world.spatial.query(t.pos.x, t.pos.z, 220, SC_OBSERVER)) {
    if (o.owner !== f || o.hp <= 0) continue;
    if (dist(o.pos, t.pos) <= o.def.vision && world.terrain.los(o.pos.x, o.y + 1.7, o.pos.z, t.pos.x, t.y + 1, t.pos.z)) return true;
  }
  return false;
}

function hasReconSpotter(world: World, f: number, t: Unit): boolean {
  for (const o of world.spatial.query(t.pos.x, t.pos.z, DISPERSION.reconRange, SC_RECON)) {
    if (o.owner !== f || o.def.id !== 'recon' || o.hp <= 0 || o.routing || o.moraleState !== 'normal') continue;
    if (world.terrain.los(o.pos.x, o.y + 1.7, o.pos.z, t.pos.x, t.y + 1, t.pos.z)) return true;
  }
  return false;
}

/**
 * Where to lay the guns on a moving target: its position after the shell's flight time, extrapolated
 * along its heading (observers call the correction; BALANCE_SPEC §8.2). Stationary targets: as is.
 */
function leadPoint(world: World, w: WeaponDef, t: Unit, m: V3, g: number, preferHigh: boolean): V2 {
  if (!t.moving || t.speedNow <= 0.05) return t.pos;
  const res = solveArc(m, { x: t.pos.x, y: world.terrain.heightAt(t.pos.x, t.pos.z), z: t.pos.z }, w.muzzleSpeed, g, w.minElevationDeg, w.maxElevationDeg, preferHigh);
  if (!res.ok) return t.pos;
  const lead = Math.min(DISPERSION.leadMaxM, t.speedNow * res.sol.tFlight * DISPERSION.leadFactor);
  return { x: t.pos.x + Math.cos(t.heading) * lead, z: t.pos.z + Math.sin(t.heading) * lead };
}

function fireIndirect(world: World, u: Unit, w: WeaponDef, t: Unit, m: V3): boolean {
  const range = dist(u.pos, t.pos);
  const sigma = indirectSigma(world, u, w, t, range);
  const g = world.data.rules.simulation.gravity_mps2;
  const preferHigh = w.id === 'mortar_shell';
  const aimAt = leadPoint(world, w, t, m, g, preferHigh);
  const land = { x: aimAt.x + world.rngScatter.normal() * sigma, z: aimAt.z + world.rngScatter.normal() * sigma };
  const p1: V3 = { x: land.x, y: world.terrain.heightAt(land.x, land.z), z: land.z };
  const res = solveArc(m, p1, w.muzzleSpeed, g, w.minElevationDeg, w.maxElevationDeg, preferHigh);
  if (!res.ok) {
    u.status = 'status.noArc';
    return false;
  }
  const h = (x: number, z: number): number => world.terrain.heightAt(x, z) + world.terrain.buildingH(x, z);
  let sol = res.sol;
  if (!arcClear(m, sol, g, h)) {
    // Neither arc clears this fall of shot: the crew does not fire into the crest or the wall in
    // front of it (balance lab 1.1: ~30 % of howitzer shells used to burst short, many on our own
    // troops). Next tick draws a new fall of shot; a masked gun gets NO_ARC from canEngage.
    if (!res.alt || !arcClear(m, res.alt, g, h)) {
      u.status = 'status.noArc';
      return false;
    }
    sol = res.alt;
  }
  const fp = firepowerScale(u.def, u.hp, u.def.maxHp);
  spawnProjectile(world, {
    owner: u.owner, weapon: w, kind: 'shell', pos: m, vel: sol.vel, targetId: null, intendedHit: false, sourceId: u.id, srcType: u.def.id,
    damage: w.damage * fp, blastRadius: w.blastRadius, suppression: w.suppression, penetration: w.penetration,
  });
  return true;
}

/** Whether an indirect weapon has any legal arc to `t` (used by AI to choose firing positions). */
export function hasIndirectSolution(world: World, u: Unit, w: WeaponDef, at: V2): boolean {
  const g = world.data.rules.simulation.gravity_mps2;
  const m: V3 = { x: u.pos.x, y: u.y + muzzleHeight(u), z: u.pos.z };
  const p1: V3 = { x: at.x, y: world.terrain.heightAt(at.x, at.z), z: at.z };
  const res = solveArc(m, p1, w.muzzleSpeed, g, w.minElevationDeg, w.maxElevationDeg, true);
  if (!res.ok) return false;
  const h = (x: number, z: number): number => world.terrain.heightAt(x, z) + world.terrain.buildingH(x, z);
  return arcClear(m, res.sol, g, h) || (!!res.alt && arcClear(m, res.alt, g, h));
}

export function spawnProjectile(world: World, p: Omit<Projectile, 'id' | 'prev' | 'age' | 'done'>): void {
  world.projectiles.push({ ...p, id: world.newId(), prev: { ...p.pos }, pos: { ...p.pos }, age: 0, done: false });
}

/** Integrate projectiles with swept collision against terrain and units (§4.3, C05). */
export function updateProjectiles(world: World): void {
  const g = world.data.rules.simulation.gravity_mps2;
  const dt = world.dt;
  for (const pr of world.projectiles) {
    if (pr.done) continue;
    // In place: no two object allocations per projectile per tick.
    pr.prev.x = pr.pos.x; pr.prev.y = pr.pos.y; pr.prev.z = pr.pos.z;
    pr.vel.y -= g * dt;
    pr.pos.x += pr.vel.x * dt; pr.pos.y += pr.vel.y * dt; pr.pos.z += pr.vel.z * dt;
    pr.age += dt;
    const segLen = Math.hypot(pr.pos.x - pr.prev.x, pr.pos.y - pr.prev.y, pr.pos.z - pr.prev.z);
    const steps = Math.max(1, Math.ceil(segLen / 1.5));
    let impact: V3 | null = null;
    let hitUnit: Unit | null = null;
    for (let k = 1; k <= steps && !impact; k++) {
      const t = k / steps;
      const x = pr.prev.x + (pr.pos.x - pr.prev.x) * t;
      const y = pr.prev.y + (pr.pos.y - pr.prev.y) * t;
      const z = pr.prev.z + (pr.pos.z - pr.prev.z) * t;
      if (pr.kind === 'ap') {
        hitUnit = apCollision(world, pr, x, y, z);
        if (hitUnit) impact = { x, y, z };
      }
      if (!impact && !world.terrain.inBounds(x, z)) impact = { x, y: world.terrain.heightAt(x, z), z };
      if (!impact) {
        // Ground or a building (shells burst on walls and roofs instead of passing through).
        const gy = world.terrain.heightAt(x, z);
        const roof = gy + world.terrain.buildingH(x, z);
        if (y <= roof) impact = { x, y: Math.max(gy, Math.min(y, roof)), z };
      }
    }
    if (pr.age > 30) pr.done = true;
    if (!impact) continue;
    pr.done = true;
    const wid = pr.weapon?.id ?? pr.kind;
    if (hitUnit) {
      resolveDirectHit(world, hitUnit, { x: pr.prev.x, z: pr.prev.z }, pr.owner,
        { id: wid, damage: pr.damage, penetration: pr.penetration, suppression: pr.suppression }, 1, pr.srcType);
      resolveBlast(world, impact, pr.blastRadius, pr.damage, pr.suppression, pr.owner, wid, 'ap', hitUnit.id, pr.srcType);
    } else {
      resolveBlast(world, impact, pr.blastRadius, pr.damage, pr.suppression, pr.owner, wid, pr.kind, null, pr.srcType);
    }
  }
  for (let i = world.projectiles.length - 1; i >= 0; i--) if (world.projectiles[i].done) world.projectiles.splice(i, 1);
}

function apCollision(world: World, pr: Projectile, x: number, y: number, z: number): Unit | null {
  for (const u of world.spatial.query(x, z, 5, SC_AP)) {
    if (u.hp <= 0 || u.id === pr.sourceId) continue;
    const isTarget = u.id === pr.targetId;
    // Missed rounds only collide with vehicles they physically cross; squads let AP pass through.
    if (!isTarget && u.def.kind !== 'vehicle') continue;
    if (isTarget && !pr.intendedHit && u.def.kind !== 'vehicle') continue;
    const r = isTarget && pr.intendedHit ? hitRadius(u) : 2.6;
    const dy = y - (u.y + centerHeight(u));
    if (Math.hypot(u.pos.x - x, u.pos.z - z) <= r && Math.abs(dy) < 3.5) return u;
  }
  return null;
}

/** Enemy guns located by sound ranging are priority targets for our artillery. */
function counterBatteryBonus(world: World, f: number, t: Unit): number {
  if (t.def.id !== 'howitzer' && t.def.id !== 'mortar') return 0;
  for (const r of world.batteryReveals) {
    if (r.by === t.owner && r.until > world.time && world.isHostile(f, r.by) && dist(r.pos, t.pos) < 90) return 0.45;
  }
  return 0;
}
