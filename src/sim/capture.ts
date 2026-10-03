import { noteCapture } from './events';
import type { Faction, Objective, Unit } from './types';
import { dist } from './vec';
import type { World } from './world';

/** Query scratch (no per-second allocation per objective). */
const SC_PRESENT: Unit[] = [];

/** Eligible capturer: infantry/recon/engineer, ≥50 % strength, not routing nor suppressed (§5.3). */
export function eligibleCapturer(world: World, u: Unit): boolean {
  if (u.hp <= 0 || u.fixed || u.def.kind !== 'infantry') return false;
  if (u.routing || u.moraleState !== 'normal') return false;
  return u.hp >= u.def.maxHp * world.data.rules.victory.eligible_capture_hp_ratio;
}

function presentFactions(world: World, x: number, z: number, r: number): Set<number> {
  const set = new Set<number>();
  for (const u of world.spatial.query(x, z, r, SC_PRESENT)) {
    if (world.factions[u.owner].alive && eligibleCapturer(world, u)) set.add(u.owner);
  }
  return set;
}

/** Strategic point capture with per-faction progress, decay and contest pause. */
export function updateObjective(world: World, o: Objective, seconds: number): void {
  const v = world.data.rules.victory;
  const present = presentFactions(world, o.pos.x, o.pos.z, o.radius);
  const captureSeconds = world.data.rules.territory?.capture_seconds[o.kind] ?? v.point_capture_seconds;
  const attackers = [...present].filter((f) => f !== o.owner && (o.owner < 0 || world.isHostile(f, o.owner)));
  o.contested = attackers.length > 0 && (present.size > 1 || o.owner >= 0);
  if (present.size > 1) return; // multiple sides: pause, no decay
  for (const key of Object.keys(o.progress)) {
    const f = Number(key);
    if (present.has(f)) continue;
    const rate = present.has(o.owner) ? 2 : 1;
    o.progress[f] = Math.max(0, o.progress[f] - rate * seconds);
    if (o.progress[f] <= 0) delete o.progress[f];
  }
  if (attackers.length === 1 && present.size === 1) {
    const a = attackers[0];
    o.progress[a] = (o.progress[a] ?? 0) + seconds;
    if (o.progress[a] >= captureSeconds) {
      const prev = o.owner;
      o.owner = a;
      noteCapture(world, o, prev, a);
      o.progress = {};
      o.contested = false;
      o.activeAt = world.time + world.data.rules.economy.node_activation_seconds;
      world.note(a, 'log.pointTaken', { point: o.id }, 'info');
      const loss = world.data.rules.territory?.resolve_loss_on_capture?.[o.kind];
      if (prev >= 0 && loss && world.data.rules.victory.resolve_enabled) {
        const k = world.data.rules.proposed_defaults.army_scale ?? 1;
        world.factions[prev].resolve = Math.max(0, world.factions[prev].resolve - loss * k);
      }
      if (prev >= 0) world.note(prev, 'log.pointLost', { point: o.id }, 'warn');
    }
  }
}

/** HQ capture (§5.3): 45 s, defender presence decays 2/s, empty decays 1/s. */
export function updateHq(world: World, def: Faction, seconds: number): void {
  if (!def.alive) return;
  const v = world.data.rules.victory;
  const hq = world.hqPos(def.id);
  const present = presentFactions(world, hq.x, hq.z, v.command_radius_m);
  const attackers = [...present].filter((f) => world.isHostile(f, def.id));
  const defenderHere = present.has(def.id);
  if (attackers.length > 1) return;
  for (const key of Object.keys(def.hqProgress)) {
    const f = Number(key);
    if (attackers.length === 1 && attackers[0] === f && !defenderHere) continue;
    const rate = defenderHere ? v.command_defender_decay_progress_seconds_per_second : v.command_empty_decay_progress_seconds_per_second;
    def.hqProgress[f] = Math.max(0, def.hqProgress[f] - rate * seconds);
    if (def.hqProgress[f] <= 0) delete def.hqProgress[f];
  }
  if (attackers.length === 1 && !defenderHere) {
    const a = attackers[0];
    const before = def.hqProgress[a] ?? 0;
    def.hqProgress[a] = before + seconds;
    if (before === 0) world.note(def.id, 'log.hqUnderAttack', {}, 'alert');
  }
}

/** Number of strategic points a faction holds uncontested. */
export function uncontestedHeld(world: World, f: number): number {
  return world.objectives.filter((o) => o.owner === f && !o.contested).length;
}

/** Majority bleed: a sole strict-majority holder drains all other living factions (§5.3). */
export function majorityBleed(world: World, seconds: number): number | null {
  if (!world.data.rules.victory.resolve_enabled) return null;
  const counts = new Map<number, number>();
  const strategic = world.objectives.filter((o) => o.strategic);
  for (const o of strategic) if (o.owner >= 0 && !o.contested) counts.set(o.owner, (counts.get(o.owner) ?? 0) + 1);
  const total = strategic.length;
  for (const [f, c] of counts) {
    if (c * 2 > total && world.factions[f].alive) {
      const bleed = world.data.rules.victory.majority_control_enemy_bleed_per_second * seconds;
      for (const other of world.factions) if (other.alive && other.id !== f) other.resolve = Math.max(0, other.resolve - bleed);
      return f;
    }
  }
  return null;
}

export function hqCaptured(world: World, f: Faction): boolean {
  const need = world.data.rules.victory.command_capture_seconds;
  return Object.values(f.hqProgress).some((p) => p >= need);
}

export function distanceToHq(world: World, u: Unit): number {
  return dist(u.pos, world.hqPos(u.owner));
}
