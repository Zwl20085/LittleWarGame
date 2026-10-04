import { worksProtect } from './works';
import { MOTOR } from './movement';
import { COMBAT, COVER, type CoverLevel } from './config';
import { crowding, OPS } from './operations';
import { armorFacing, armorSuppressionMul, armorValue, blastFalloff, heTargetMul, penetrationProbability } from './formulas';
import { recordDamage } from './stats';
import { noteHit } from './events';
import { noteBuildingHit, shieldBuilding } from './buildings';
import { exposureSuppressionMul } from './terrainrules';
import type { Fort, ProjectileKind, Unit, V3 } from './types';
import { angleDiff, DEG, headingTo, type V2 } from './vec';
import type { World } from './world';

/** Query scratch arrays: the blast loop calls applyDamage, which queries with its own. */
const SC_WIPE: Unit[] = [];
const SC_BLAST: Unit[] = [];

/**
 * Effective cover of `u` against an attack coming from `from` (fort cover is directional, 120° front).
 * A squad next to an intact building that stands between it and `from` is garrisoned: level 3.
 * `buildings=false` when the blast ray is already blocked by a building (no double counting, §4.3).
 */
export function coverAgainst(world: World, u: Unit, from: V2 | null, buildings = true): CoverLevel {
  if (u.def.kind === 'vehicle') return 0;
  // Trench / sandbag line between us and the attacker: best cover.
  if (worksProtect(u, from)) return 3;
  if (u.fixed) {
    if (!from) return 3;
    return Math.abs(angleDiff(u.fixedFacing, headingTo(u.pos, from))) <= 60 * DEG ? 3 : 0;
  }
  if (u.fortId !== null) {
    const f = world.forts.find((x) => x.id === u.fortId);
    if (f && f.progress >= 1 && f.hp > 0) {
      const lvl: CoverLevel = f.kind === 'mg_bunker' ? 3 : 2;
      if (!from || Math.abs(angleDiff(f.facing, headingTo(f.pos, from))) <= 60 * DEG) return lvl;
    }
  }
  if (u.cover === 3 && buildings && from && shieldBuilding(world, u.pos, from) >= 0) return 3;
  return u.cover > 2 ? 2 : u.cover;
}

/** Add suppression and the morale it costs (§5). */
export function addSuppression(world: World, u: Unit, amount: number): void {
  if (amount <= 0 || u.hp <= 0) return;
  const before = u.suppression;
  u.suppression = Math.min(100, u.suppression + amount);
  const added = u.suppression - before;
  u.morale = Math.max(0, u.morale - COMBAT.moraleSuppressionFactor * added);
  u.lastSuppressedAt = world.time;
}

/** The single HP mutation point. Handles death, resolve loss and logging. */
export function applyDamage(world: World, u: Unit, dmg: number, attackerOwner: number, weaponId: string, src = '?'): void {
  if (dmg <= 0 || u.hp <= 0) return;
  dmg *= world.data.rules.proposed_defaults.tempo_damage_multiplier ?? 1;
  if (u.mounted) dmg *= MOTOR.mountedDamageMul; // packed in soft-skinned trucks
  const maxHp = u.fixed ? 1400 : u.def.maxHp;
  const lost = Math.min(u.hp, dmg);
  u.hp -= lost;
  u.lastDamagedAt = world.time;
  if (u.def.id === 'supply_truck') noteTruckHit(world, u);
  u.morale = Math.max(0, u.morale - COMBAT.moraleHpLossFactor * (lost / maxHp));
  recordDamage(world.stats, attackerOwner, src, u, lost, u.hp <= 0);
  noteHit(world, u, attackerOwner, lost, u.hp <= 0);
  if (u.hp > 0) return;
  u.hp = 0;
  const f = world.factions[u.owner];
  if (!u.fixed && f.alive) {
    if (world.data.rules.victory.resolve_enabled) f.resolve = Math.max(0, f.resolve - u.def.population * world.data.rules.victory.destroyed_population_resolve_multiplier);
    f.lostUnits++;
  }
  world.emit({ t: 'death', pos: { x: u.pos.x, y: u.y, z: u.pos.z }, vehicle: u.def.kind === 'vehicle', unitType: u.def.id });
  world.note(u.owner, 'log.unitLost', { unit: u.def.id, weapon: weaponId, by: attackerOwner }, u.def.kind === 'vehicle' ? 'warn' : 'info');
  if (u.fortId !== null) {
    const fort = world.forts.find((x) => x.id === u.fortId);
    if (fort) fort.occupant = null;
  }
  // Nearby friends lose a little morale when a unit is wiped (rate-limited per unit).
  for (const n of world.spatial.query(u.pos.x, u.pos.z, 60, SC_WIPE)) {
    if (n.owner === u.owner && n.id !== u.id && n.hp > 0 && world.time - n.lastMoraleWipeAt > 10) {
      n.morale = Math.max(0, n.morale - COMBAT.friendWipeMoraleLoss);
      n.lastMoraleWipeAt = world.time;
    }
  }
}

/** Seconds a hit truck stays on its faction's "under fire" list (the rear-guard alert reads 90 s). */
export const TRUCK_HIT_MEMORY_S = 90;
/** Escorts only react to hits this recent. */
export const ESCORT_REACT_S = 6;

/** Record a convoy truck taking fire so nearby combat units can escort it without scanning. */
function noteTruckHit(world: World, truck: Unit): void {
  const list = world.factions[truck.owner]?.trucksUnderFire;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    if (world.time - list[i].at > TRUCK_HIT_MEMORY_S) list.splice(i, 1);
    else if (list[i].id === truck.id) {
      list[i].at = world.time;
      return;
    }
  }
  list.push({ id: truck.id, at: world.time });
}

/** Direct AP hit on a unit (projectile or hitscan). Returns whether it penetrated. */
export function resolveDirectHit(
  world: World, target: Unit, from: V2, attackerOwner: number,
  w: { id: string; damage: number; penetration: number; suppression: number }, firepower: number, src = '?',
): boolean {
  const def = target.def;
  const armored = def.armorFront > 0 || def.armorSide > 0;
  let penetrated = true;
  let dmg = w.damage * firepower;
  if (armored) {
    const facing = armorFacing(target.heading, headingTo(target.pos, from));
    const pPen = penetrationProbability(w.penetration, armorValue(def, facing));
    penetrated = world.rngCombat.chance(pPen);
    if (!penetrated) {
      dmg = 0;
      world.emit({ t: 'ricochet', pos: { x: target.pos.x, y: target.y + 2, z: target.pos.z } });
    }
  } else {
    const cover = coverAgainst(world, target, from);
    dmg *= COVER[cover].direct;
    if (w.id === 'at_cannon') dmg *= COMBAT.atVsInfantryMul;
  }
  const cover = coverAgainst(world, target, from);
  const supp = w.suppression * COVER[cover].supp * armorSuppressionMul(def) * exposureSuppressionMul(world, target);
  if (dmg > 0 || !armored) addSuppression(world, target, supp);
  applyDamage(world, target, dmg, attackerOwner, w.id, src);
  return penetrated;
}

/** HE blast at `at`; `exclude` is the primary target already resolved by the direct hit. */
export function resolveBlast(
  world: World, at: V3, radius: number, damage: number, suppression: number,
  attackerOwner: number, weaponId: string, kind: ProjectileKind | 'he', exclude: number | null, src = '?',
): void {
  world.emit({ t: 'explosion', pos: at, radius, kind });
  if (radius <= 0) return;
  // Structural damage: AP rounds are shaped for armour, not walls (capped and halved).
  noteBuildingHit(world, at, kind === 'ap' ? Math.min(damage, 150) * 0.5 : damage);
  const hits = world.spatial.query(at.x, at.z, radius + 4, SC_BLAST);
  for (const u of hits) {
    if (u.id === exclude || u.hp <= 0) continue;
    const d = Math.hypot(u.pos.x - at.x, u.pos.z - at.z, u.y - at.y);
    const fall = blastFalloff(d, radius);
    if (fall <= 0) continue;
    // Terrain fully separating blast and target: no HP damage; buildings in between: x.25 (par. 4.3).
    if (!world.terrain.los(at.x, at.y + 1, at.z, u.pos.x, u.y + 1, u.pos.z, 1e9, 1e9, false)) continue;
    const blocked = !world.terrain.los(at.x, at.y + 1, at.z, u.pos.x, u.y + 1, u.pos.z, 1e9);
    const blockMul = blocked ? 0.25 : 1;
    if (kind === 'shell') {
      const grp = world.factions[u.owner]?.fronts[u.frontId];
      if (grp) grp.shelledAt = world.time;
    }
    // Crowded troops suffer more under shellfire (shock + no room to go to ground).
    const crowdMul = kind === 'shell' && crowding(world, u) >= OPS.crowdThreshold ? 1.35 : 1;
    const cover = coverAgainst(world, u, { x: at.x, z: at.z }, !blocked);
    const dmg = damage * fall * COVER[cover].blast * heTargetMul(u.def) * blockMul;
    const supMul = armorSuppressionMul(u.def) * (blocked ? 0.5 : 1) * crowdMul * exposureSuppressionMul(world, u);
    addSuppression(world, u, suppression * fall * COVER[cover].supp * supMul);
    applyDamage(world, u, dmg, attackerOwner, weaponId, src);
  }
  for (const f of world.forts) damageFort(world, f, at, radius, damage);
}

function damageFort(world: World, f: Fort, at: V3, radius: number, damage: number): void {
  if (f.hp <= 0) return;
  const d = Math.hypot(f.pos.x - at.x, f.pos.z - at.z);
  const fall = blastFalloff(Math.max(0, d - 3), radius);
  if (fall <= 0) return;
  f.hp -= damage * fall * COMBAT.heTargetMul.fort;
  if (f.hp <= 0) {
    f.hp = 0;
    const occ = world.unitAlive(f.occupant);
    if (occ) occ.fortId = null;
    f.occupant = null;
    world.emit({ t: 'explosion', pos: { x: f.pos.x, y: world.terrain.heightAt(f.pos.x, f.pos.z), z: f.pos.z }, radius: 6, kind: 'he' });
  }
}
