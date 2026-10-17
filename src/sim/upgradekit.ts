import type { UpgradeEffectRules } from '../data/upgradeRules';
import { resolveDirectHit } from './damage';
import { firepowerScale } from './formulas';
import { hostileMask } from './spatial';
import type { Unit } from './types';
import { KIT_BITS, UPG } from './upgradestats';
import { dist } from './vec';
import type { World } from './world';

/**
 * 3.0 squad kit upgrade (V30_SPEC §9): **AP grenades** let a squad hurt a vehicle that comes within
 * throwing range. (3.0.1: the attached gun team was removed.) Called once per tick per unit from
 * combat.updateWeapons; a unit without kit bits returns on the first test, and a kit with nothing
 * to throw at waits RETRY_S before it looks again.
 */

const RETRY_S = 3;
const SC_NADE: Unit[] = [];

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
  if (now < u.upgNadeAt) return;
  const fx = world.data.rules.upgrades?.effects;
  if (!fx || u.hp <= 0 || u.routing || u.mounted || u.moraleState === 'pinned' || u.behavior === 'evacuate' || u.rail?.stage === 'aboard') return;
  if ((u.upg & UPG.ap_grenades) !== 0) {
    u.upgNadeAt = now + (throwGrenade(world, u, fx) ? fx.ap_grenade.interval_s : RETRY_S);
  }
}
