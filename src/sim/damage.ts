import { COMBAT, COVER, type CoverLevel } from './config';
import { crowding, OPS } from './operations';
import { armorFacing, armorSuppressionMul, armorValue, blastFalloff, heTargetMul, penetrationProbability } from './formulas';
import { recordDamage } from './stats';
import type { Fort, ProjectileKind, Unit, V3 } from './types';
import { angleDiff, DEG, headingTo, type V2 } from './vec';
import type { World } from './world';

/** Effective cover of `u` against an attack coming from `from` (fort cover is directional, 120° front). */
export function coverAgainst(world: World, u: Unit, from: V2 | null): CoverLevel {
  if (u.def.kind === 'vehicle') return 0;
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
  const maxHp = u.fixed ? 1400 : u.def.maxHp;
  const lost = Math.min(u.hp, dmg);
  u.hp -= lost;
  u.lastDamagedAt = world.time;
  u.morale = Math.max(0, u.morale - COMBAT.moraleHpLossFactor * (lost / maxHp));
  recordDamage(world.stats, attackerOwner, src, u, lost, u.hp <= 0);
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
  for (const n of world.spatial.query(u.pos.x, u.pos.z, 60)) {
    if (n.owner === u.owner && n.id !== u.id && n.hp > 0 && world.time - n.lastMoraleWipeAt > 10) {
      n.morale = Math.max(0, n.morale - COMBAT.friendWipeMoraleLoss);
      n.lastMoraleWipeAt = world.time;
    }
  }
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
  const supp = w.suppression * COVER[cover].supp * armorSuppressionMul(def);
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
  const hits = world.spatial.query(at.x, at.z, radius + 4);
  for (const u of hits) {
    if (u.id === exclude || u.hp <= 0) continue;
    const d = Math.hypot(u.pos.x - at.x, u.pos.z - at.z, u.y - at.y);
    const fall = blastFalloff(d, radius);
    if (fall <= 0) continue;
    // Terrain fully separating blast and target: no HP damage; buildings in between: x.25 (par. 4.3).
    if (!world.terrain.los(at.x, at.y + 1, at.z, u.pos.x, u.y + 1, u.pos.z, 1e9, 1e9, false)) continue;
    const blocked = !world.terrain.los(at.x, at.y + 1, at.z, u.pos.x, u.y + 1, u.pos.z, 1e9);
    const blockMul = blocked ? 0.25 : 1;
    if (kind === 'shell' || kind === 'bomb') {
      const grp = world.factions[u.owner]?.sectors[u.sectorId];
      if (grp) grp.shelledAt = world.time;
    }
    // Crowded troops suffer more under shellfire (shock + no room to go to ground).
    const crowdMul = (kind === 'shell' || kind === 'bomb') && crowding(world, u) >= OPS.crowdThreshold ? 1.35 : 1;
    const cover = coverAgainst(world, u, { x: at.x, z: at.z });
    const dmg = damage * fall * COVER[cover].blast * heTargetMul(u.def) * blockMul;
    addSuppression(world, u, suppression * fall * COVER[cover].supp * armorSuppressionMul(u.def) * (blocked ? 0.5 : 1) * crowdMul);
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
