import type { WeaponDef } from '../data/types';
import type { UpgradeEffectRules } from '../data/upgradeRules';
import { solveArc } from './ballistics';
import { resolveDirectHit } from './damage';
import { firepowerScale } from './formulas';
import { housedIn } from './shelter';
import { hostileMask } from './spatial';
import type { Fort, Unit, V3 } from './types';
import { KIT_BITS, UPG } from './upgradestats';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 squad kit upgrades (V30_SPEC §9): the **attached gun team** (an infantry gun / light mortar
 * with each rifle squad) lobs HE at dug-in targets — squads in works, garrisons, houses, set-up
 * guns — and at enemy works themselves, so its shells break trenches, pillboxes and buildings
 * (damage.resolveBlast); **AP grenades** let a squad hurt a vehicle that comes within throwing
 * range. Called once per tick per unit from combat.updateWeapons; a unit without kit bits returns
 * on the first test, and a kit with nothing to shoot at waits RETRY_S before it looks again.
 */

const RETRY_S = 3;
/** Scatter multiplier for a gun-team shot fired while the squad is on the move. */
const MOVING_SIGMA_MUL = 1.5;
const SC_NADE: Unit[] = [];

/** Synthetic weapon records (projectile / hit bookkeeping), one per effects-rules object. */
const gunWeapons = new WeakMap<UpgradeEffectRules, WeaponDef>();
function gunWeapon(fx: UpgradeEffectRules): WeaponDef {
  let w = gunWeapons.get(fx);
  if (!w) {
    const g = fx.inf_gun;
    w = {
      id: 'inf_gun', labelZh: '步兵炮', fireMode: 'ballistic', range: g.range_m, minRange: 40, interval: g.interval_s,
      damage: g.damage, penetration: 30, accuracy: 0, blastRadius: g.blast_m, suppression: g.suppression, canFireMoving: false,
      ammoCost: g.ammo_cost, muzzleSpeed: g.muzzle_mps, minElevationDeg: 5, maxElevationDeg: 85,
    };
    gunWeapons.set(fx, w);
  }
  return w;
}

/** Squads / guns that sit in cover: what an infantry gun is for. */
function dugIn(world: World, t: Unit): boolean {
  return t.fortId !== null || t.fixed || t.cover >= 2 || (t.def.kind === 'crew' && t.setup === 'set') || housedIn(world, t) >= 0;
}

/** Nearest hostile work (finished or rising) within `range` of `u`, else null. */
function nearestWork(world: World, u: Unit, range: number, minRange: number): Fort | null {
  let best: Fort | null = null;
  let bd = range;
  for (const f of world.forts) {
    if (f.hp <= 0 || f.kind === 'pontoon' || !world.isHostile(u.owner, f.owner)) continue;
    const d = dist(u.pos, f.pos);
    if (d < bd && d >= minRange) {
      bd = d;
      best = f;
    }
  }
  return best;
}

function gunAim(world: World, u: Unit, w: WeaponDef): V2 | null {
  const t = world.unitAlive(u.targetId);
  if (t && dugIn(world, t)) {
    const d = dist(u.pos, t.pos);
    if (d >= w.minRange && d <= w.range) return t.pos;
  }
  return nearestWork(world, u, w.range, w.minRange)?.pos ?? null;
}

function fireGun(world: World, u: Unit, fx: UpgradeEffectRules): boolean {
  const w = gunWeapon(fx);
  // The gun team fires from short halts while its squad advances (WP-T: gated on `!moving` it never
  // fired in an attack-move, where squads keep walking; the shell scatters wider on the move).
  if (u.ammo + 1e-9 < w.ammoCost) return false;
  const at = gunAim(world, u, w);
  if (!at) return false;
  // No shell where our own troops stand (the lob scatters by sigma_m).
  const safeR = w.blastRadius + 2 * fx.inf_gun.sigma_m * (u.moving ? MOVING_SIGMA_MUL : 1);
  if (world.spatial.findOwner(at.x, at.z, safeR, 1 << u.owner, (o) => o.hp > 0 && o.owner === u.owner)) return false;
  const sigma = fx.inf_gun.sigma_m * (u.moving ? MOVING_SIGMA_MUL : 1);
  const land = { x: at.x + world.rngScatter.normal() * sigma, z: at.z + world.rngScatter.normal() * sigma };
  const m: V3 = { x: u.pos.x, y: u.y + 1.2, z: u.pos.z };
  const p1: V3 = { x: land.x, y: world.terrain.heightAt(land.x, land.z), z: land.z };
  const res = solveArc(m, p1, w.muzzleSpeed, world.data.rules.simulation.gravity_mps2, w.minElevationDeg, w.maxElevationDeg, true);
  if (!res.ok) return false;
  const fp = firepowerScale(u.def, u.hp, u.def.maxHp);
  world.projectiles.push({
    id: world.newId(), owner: u.owner, weapon: w, kind: 'shell', pos: { ...m }, prev: { ...m }, vel: res.sol.vel, targetId: null,
    intendedHit: false, sourceId: u.id, srcType: u.def.id, damage: w.damage * fp, blastRadius: w.blastRadius,
    suppression: w.suppression, penetration: w.penetration, age: 0, done: false,
  });
  u.ammo = Math.max(0, u.ammo - w.ammoCost);
  world.emit({ t: 'muzzle', pos: m, dir: Math.atan2(at.z - u.pos.z, at.x - u.pos.x), big: true, weapon: 'inf_gun' });
  return true;
}

function throwGrenade(world: World, u: Unit, fx: UpgradeEffectRules): boolean {
  const g = fx.ap_grenade;
  if (u.ammo + 1e-9 < g.ammo_cost) return false;
  let best: Unit | null = null;
  let bd = g.range_m;
  for (const t of world.spatial.queryOwners(u.pos.x, u.pos.z, g.range_m, hostileMask(world, u.owner), SC_NADE)) {
    if (t.hp <= 0 || t.def.kind !== 'vehicle' || !world.isHostile(u.owner, t.owner) || !world.knows(u.owner, t)) continue;
    const d = dist(u.pos, t.pos);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  if (!best) return false;
  const t = best;
  const from = { x: u.pos.x, z: u.pos.z };
  const owner = u.owner;
  const fp = firepowerScale(u.def, u.hp, u.def.maxHp);
  const hit = { id: 'ap_grenade', damage: g.damage, penetration: g.penetration, suppression: 8 };
  // Resolved with the other hits of this tick (order-independent, like combat.fireHitscan).
  world.deferred.push(() => resolveDirectHit(world, t, from, owner, hit, fp, u.def.id));
  world.emit({ t: 'explosion', pos: { x: t.pos.x, y: t.y + 1, z: t.pos.z }, radius: 2, kind: 'he' });
  u.ammo = Math.max(0, u.ammo - g.ammo_cost);
  return true;
}

/** Per-tick kit handling for one unit (combat.updateWeapons, after its own weapons). */
export function kitFire(world: World, u: Unit): void {
  if ((u.upg & KIT_BITS) === 0) return;
  const now = world.time;
  if (now < u.upgGunAt && now < u.upgNadeAt) return;
  const fx = world.data.rules.upgrades?.effects;
  if (!fx || u.hp <= 0 || u.routing || u.mounted || u.moraleState === 'pinned' || u.behavior === 'evacuate' || u.rail?.stage === 'aboard') return;
  if ((u.upg & UPG.ap_grenades) !== 0 && now >= u.upgNadeAt) {
    u.upgNadeAt = now + (throwGrenade(world, u, fx) ? fx.ap_grenade.interval_s : RETRY_S);
  }
  if ((u.upg & UPG.inf_guns) !== 0 && now >= u.upgGunAt) {
    u.upgGunAt = now + (fireGun(world, u, fx) ? fx.inf_gun.interval_s : RETRY_S);
  }
}
