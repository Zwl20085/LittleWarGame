import type { AirMissionDef } from '../data/types';
import { spawnProjectile } from './combat';
import { refund, trySpend } from './economy';
import { resolveBlast } from './damage';
import type { Faction, Plane } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

export type AirFail = 'LOCKED' | 'BUSY' | 'INSUFFICIENT_M' | 'UNKNOWN_MISSION' | 'OUT_OF_BOUNDS';

export function missionDef(world: World, id: string): AirMissionDef | undefined {
  return world.data.rules.air.missions.find((m) => m.id === id);
}

/** Request an air mission (player or AI); cost is paid at request time (§9). */
export function requestAir(world: World, f: Faction, missionId: string, target: V2): AirFail | null {
  const m = missionDef(world, missionId);
  if (!m) return 'UNKNOWN_MISSION';
  if (world.time < m.unlock_seconds) return 'LOCKED';
  if (f.air.phase !== 'idle') return 'BUSY';
  if (!world.terrain.inBounds(target.x, target.z)) return 'OUT_OF_BOUNDS';
  if (!trySpend(f, m.cost_p, m.cost_m).ok) return 'INSUFFICIENT_M';
  f.air = { ...f.air, missionId, phase: 'preparing', timer: m.prepare_seconds, target: { ...target }, paidM: m.cost_m, planeId: null };
  world.note(f.id, 'log.airPreparing', { mission: missionId, s: m.prepare_seconds }, 'info');
  return null;
}

export function cancelAir(world: World, f: Faction): boolean {
  if (f.air.phase !== 'preparing') return false;
  refund(f, 0, f.air.paidM * 0.5, world.data.rules);
  f.air = { ...f.air, phase: 'idle', missionId: null, target: null, timer: 0, paidM: 0 };
  return true;
}

function launch(world: World, f: Faction): void {
  const m = missionDef(world, f.air.missionId!)!;
  const entry = world.cityOf(f.id).airEntry;
  const target = f.air.target!;
  const h = headingTo(entry, target);
  const far = Math.max(world.terrain.width, world.terrain.depth) * 1.5;
  const exit = { x: target.x + Math.cos(h) * far, z: target.z + Math.sin(h) * far };
  const alt = world.terrain.maxHeight + world.data.rules.air.cruise_above_map_max_m * 0.6;
  const plane: Plane = {
    id: world.newId(), owner: f.id, mission: m,
    pos: { x: entry.x, y: alt, z: entry.z }, prev: { x: entry.x, y: alt, z: entry.z }, heading: h, hp: m.hp,
    dropsLeft: m.shots ?? 0, nextDropAt: 0, target, phase: 'inbound', exit, entry, visionUntil: 0,
  };
  world.planes.push(plane);
  f.air.phase = 'flying';
  f.air.planeId = plane.id;
  world.note(f.id, 'log.airLaunched', { mission: m.id }, 'info');
}

/** Per-tick air update: preparation, flight, drops and cooldown. */
export function updateAir(world: World): void {
  const dt = world.dt;
  for (const f of world.factions) {
    const a = f.air;
    if (a.phase === 'preparing') {
      a.timer -= dt;
      if (a.timer <= 0) {
        if (f.alive) launch(world, f);
        else f.air = { ...a, phase: 'idle' };
      }
    } else if (a.phase === 'cooldown') {
      a.timer -= dt;
      if (a.timer <= 0) f.air = { ...a, phase: 'idle', missionId: null, target: null };
    }
  }
  for (const p of world.planes) {
    p.prev = { ...p.pos };
    if (p.hp <= 0) continue;
    const spd = p.mission.speed_mps;
    p.pos = { x: p.pos.x + Math.cos(p.heading) * spd * dt, y: p.pos.y, z: p.pos.z + Math.sin(p.heading) * spd * dt };
    const toT = dist(p.pos, p.target);
    const m = p.mission;
    if (p.phase === 'inbound') {
      const spanHalf = ((m.shots ?? 1) - 1) * (m.shot_interval_seconds ?? 0) * spd * 0.5;
      const groundY = world.terrain.heightAt(p.target.x, p.target.z);
      const lead = m.id === 'air_bomb' ? bombLeadDistance(world, m, p.pos.y - groundY) : m.id === 'air_strafe' ? 40 : 0;
      if (m.id === 'air_recon' ? toT < 110 : toT <= spanHalf + lead) {
        p.phase = 'attack';
        p.nextDropAt = world.time;
        if (m.id === 'air_recon') p.visionUntil = world.time + (m.vision_duration_seconds ?? 20);
      }
    }
    if (p.phase === 'attack') {
      if (m.id === 'air_recon') {
        if (toT > 130 && dist(p.pos, p.entry) > dist(p.target, p.entry)) p.phase = 'outbound';
      } else if (p.dropsLeft > 0 && world.time >= p.nextDropAt) {
        drop(world, p);
        p.dropsLeft--;
        p.nextDropAt = world.time + (m.shot_interval_seconds ?? 0.5);
        if (p.dropsLeft === 0) p.phase = 'outbound';
      }
    }
  }
  for (let i = world.planes.length - 1; i >= 0; i--) {
    const p = world.planes[i];
    const gone = p.hp <= 0 || (p.phase === 'outbound' && !world.terrain.inBounds(p.pos.x, p.pos.z) && dist(p.pos, p.target) > 300);
    if (!gone) continue;
    if (p.hp <= 0) {
      world.emit({ t: 'planeDown', pos: { ...p.pos } });
      world.note(p.owner, 'log.planeLost', { mission: p.mission.id }, 'warn');
      // Wreck falls (visual) — no extra damage rules for crashes.
    }
    world.planes.splice(i, 1);
    const f = world.factions[p.owner];
    f.air = { ...f.air, phase: 'cooldown', timer: world.data.rules.air.cooldown_seconds, planeId: null };
  }
}

function drop(world: World, p: Plane): void {
  const m = p.mission;
  const sigma = m.lateral_scatter_sigma_m ?? 4;
  const lat = world.rngScatter.normal() * sigma;
  const pos = { x: p.pos.x - Math.sin(p.heading) * lat, y: p.pos.y - 3, z: p.pos.z + Math.cos(p.heading) * lat };
  if (m.id === 'air_strafe') {
    // Strafing rounds: near-instant impacts along the strip in front of the plane.
    const ahead = 40;
    const hit = { x: pos.x + Math.cos(p.heading) * ahead + world.rngScatter.normal() * 4, z: pos.z + Math.sin(p.heading) * ahead + world.rngScatter.normal() * 4 };
    const y = world.terrain.heightAt(hit.x, hit.z);
    world.emit({ t: 'tracer', from: p.pos, to: { x: hit.x, y, z: hit.z }, hit: true, weapon: 'strafe' });
    resolveBlast(world, { x: hit.x, y, z: hit.z }, m.blast_radius_m ?? 5, m.damage ?? 32, m.suppression ?? 12, p.owner, 'air_strafe', 'strafe', null, 'air');
    return;
  }
  const spd = m.speed_mps;
  spawnProjectile(world, {
    owner: p.owner, weapon: null, kind: 'bomb', pos,
    vel: { x: Math.cos(p.heading) * spd, y: 0, z: Math.sin(p.heading) * spd },
    targetId: null, intendedHit: false, sourceId: -1, srcType: 'air',
    damage: m.damage ?? 0, blastRadius: m.blast_radius_m ?? 0, suppression: m.suppression ?? 0, penetration: 0,
  });
}

/** Drop the release point earlier so bombs (falling with the plane's forward speed) land on target. */
export function bombLeadDistance(world: World, m: AirMissionDef, alt: number): number {
  const g = world.data.rules.simulation.gravity_mps2;
  return m.speed_mps * Math.sqrt((2 * alt) / g);
}
