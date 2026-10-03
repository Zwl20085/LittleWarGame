import type { Unit } from './types';
import { hostileMask } from './spatial';
import { dist } from './vec';
import type { World } from './world';

/** Suppression decay, morale regen and hysteresis state machine (§5). */
export function updateMorale(world: World, u: Unit, seconds: number): void {
  const m = world.data.rules.morale;
  if (world.time - u.lastSuppressedAt >= m.suppression_decay_delay_seconds) {
    u.suppression = Math.max(0, u.suppression - m.suppression_decay_per_second * seconds);
  }
  if (u.moraleState === 'normal' && u.suppression >= m.suppression_enter) u.moraleState = 'suppressed';
  if (u.moraleState !== 'pinned' && u.suppression >= m.pinned_enter) u.moraleState = 'pinned';
  if (u.moraleState === 'pinned' && u.suppression <= m.pinned_exit) u.moraleState = u.suppression >= m.suppression_exit ? 'suppressed' : 'normal';
  if (u.moraleState === 'suppressed' && u.suppression <= m.suppression_exit) u.moraleState = 'normal';

  if (!u.wavering && u.morale < m.wavering_enter) u.wavering = true;
  if (u.wavering && u.morale >= m.wavering_exit) u.wavering = false;
  if (!u.routing && u.morale < m.routing_enter && !u.fixed) {
    u.routing = true;
    world.note(u.owner, 'log.routing', { unit: u.def.id }, 'warn');
  }
  if (u.routing && u.morale >= m.routing_exit) u.routing = false;

  // Regen: safe (no enemy within 150 m, supplied) +1.5/s; city recovery zone +3/s; take the max.
  // Evaluated once per second per unit (staggered), applied for the elapsed second.
  const hz = world.tickHz;
  if ((world.tick + u.id) % hz !== 0) return;
  seconds = 1;
  const hq = world.hqPos(u.owner);
  let regen = 0;
  if (dist(u.pos, hq) <= world.data.rules.supply.city_recovery_radius_m) regen = m.city_morale_regen_per_second;
  else if (u.supplyRatio > 0.5 && !enemyWithin(world, u, 150)) regen = m.safe_morale_regen_per_second;
  if (world.time - u.lastDamagedAt < 5) regen = 0;
  u.morale = Math.min(100, u.morale + regen * seconds);
}

export function enemyWithin(world: World, u: Unit, r: number): boolean {
  // Owner-filtered search that stops at the first known live enemy (no result list).
  const f = u.owner;
  return world.spatial.findOwner(u.pos.x, u.pos.z, r, hostileMask(world, f), (o) => o.hp > 0 && world.isHostile(f, o.owner) && world.knows(f, o)) !== null;
}
