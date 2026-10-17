import type { DefenceTierRules } from '../data/types';
import { applyDamage } from './damage';
import { trySpend } from './economy';
import type { Faction, Fort, Unit } from './types';
import type { V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 minefields (V30 §8): engineer-laid rectangles (`length_m` along the line, `depth_m` toward
 * the enemy) in front of works. A hostile vehicle inside is slowed (× vehicle_speed_mul) and, each
 * second it stays, sets off a mine with `trigger_chance_per_second` (damage_ratio × its max HP; one
 * charge of the field's HP). Hostile engineers inside clear it slowly (`clear_hp_per_second`, under
 * fire); HE shellfire wears it down like any work (damage.ts). Infantry are not affected (AT mines).
 */
export const MINES = {
  /** A slowed vehicle keeps the slowdown this long after the last sweep (sweeps are 1 s apart). */
  slowHoldS: 1.4,
  /** Engineers this close to the rectangle's edge clear it. */
  clearPadM: 6,
} as const;

export const tierRules = (world: World): DefenceTierRules | null => {
  const t = world.data.rules.construction.defensive.tiers;
  return t && t.enabled ? t : null;
};

/** Rectangle frame of a minefield: centre, facing (toward the enemy), half length / depth. */
function frame(world: World, f: Fort): { c: V2; cos: number; sin: number; hl: number; hd: number } {
  const m = tierRules(world)?.minefield ?? world.data.rules.construction.defensive.tiers!.minefield;
  return { c: f.pos, cos: Math.cos(f.facing), sin: Math.sin(f.facing), hl: (f.length ?? m.length_m) / 2, hd: m.depth_m / 2 };
}

/** Is p inside (or within pad of) the minefield's rectangle? */
export function inMinefield(world: World, f: Fort, p: V2, pad = 0): boolean {
  const fr = frame(world, f);
  const dx = p.x - fr.c.x;
  const dz = p.z - fr.c.z;
  const depth = dx * fr.cos + dz * fr.sin;
  const along = -dx * fr.sin + dz * fr.cos;
  return Math.abs(depth) <= fr.hd + pad && Math.abs(along) <= fr.hl + pad;
}

/** Lay out and pay for a minefield (progress 0: engineers lay it). Null if it cannot be paid / placed. */
export function startMinefield(world: World, f: Faction, centre: V2, facing: number): Fort | null {
  const t = tierRules(world);
  if (!t || !world.terrain.inBounds(centre.x, centre.z)) return null;
  const m = t.minefield;
  for (const w of world.forts) if (w.kind === 'minefield' && w.hp > 0 && Math.hypot(w.pos.x - centre.x, w.pos.z - centre.z) < m.length_m * 0.6) return null;
  if (f.p < m.cost_p || f.m < m.cost_m || !trySpend(f, m.cost_p, m.cost_m).ok) return null;
  const along = facing + Math.PI / 2;
  const h = m.length_m / 2;
  const fort: Fort = {
    id: world.newId(), owner: f.id, kind: 'minefield', pos: { ...centre }, facing,
    start: { x: centre.x - Math.cos(along) * h, z: centre.z - Math.sin(along) * h },
    end: { x: centre.x + Math.cos(along) * h, z: centre.z + Math.sin(along) * h },
    length: m.length_m, hp: m.max_hp, maxHp: m.max_hp, progress: 0, occupant: null,
  };
  world.forts.push(fort);
  return fort;
}

/** Vehicles slowed by a minefield: sim time until which the slowdown holds. */
const slowedUntil = new WeakMap<Unit, number>();

/** Speed multiplier for `u` from minefields (movement.speedOf; 1 when not in one). */
export function mineSpeedMul(world: World, u: Unit): number {
  const until = slowedUntil.get(u);
  if (until === undefined || world.time > until) return 1;
  return tierRules(world)?.minefield.vehicle_speed_mul ?? 1;
}

const SC: Unit[] = [];

/** Once per second: slow / blow up hostile vehicles inside finished minefields; hostile engineers clear them. */
export function minefieldSecond(world: World): void {
  const t = tierRules(world);
  if (!t) return;
  const m = t.minefield;
  for (const f of world.forts) {
    if (f.kind !== 'minefield' || f.hp <= 0 || f.progress < 1) continue;
    const r = Math.hypot((f.length ?? m.length_m) / 2, m.depth_m / 2) + MINES.clearPadM;
    let cleared = 0;
    for (const u of world.spatial.query(f.pos.x, f.pos.z, r, SC)) {
      if (u.hp <= 0 || !world.isHostile(f.owner, u.owner)) continue;
      if (u.def.id === 'engineer' && !u.mounted) {
        if (inMinefield(world, f, u.pos, MINES.clearPadM)) cleared += m.clear_hp_per_second;
        continue;
      }
      if (u.def.kind !== 'vehicle' || !inMinefield(world, f, u.pos)) continue;
      slowedUntil.set(u, world.time + MINES.slowHoldS);
      if (f.hp <= 0 || !world.rngCombat.chance(m.trigger_chance_per_second)) continue;
      f.hp = Math.max(0, f.hp - m.charge_hp);
      world.emit({ t: 'explosion', pos: { x: u.pos.x, y: u.y, z: u.pos.z }, radius: 4, kind: 'he' });
      applyDamage(world, u, u.def.maxHp * m.damage_ratio, f.owner, 'mine');
    }
    if (cleared > 0) f.hp = Math.max(0, f.hp - cleared);
    if (f.hp <= 0) world.note(f.owner, 'log.minefieldGone', {}, 'info');
  }
}
