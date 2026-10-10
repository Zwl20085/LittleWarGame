import { buildingsNear, extentAlong, isCollapsed, shieldBuilding } from './buildings';
import { selectTarget } from './combat';
import { moveTo, stop } from './movement';
import { garrisonCover } from './structures';
import { threatCentre } from './terrainai';
import type { Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 (V22_SPEC §12): foot squads caught by artillery / mortar fire in the open run to the lee
 * wall of the nearest free building — a roadside farm or a town house — within a short radius,
 * keep shooting from there, and go back to their front task once the shelling stops. Buildings
 * then give the usual garrison cover (terrain cover 3, damage.coverAgainst) and block the blast
 * rays of bursts on the far side (damage.resolveBlast).
 */
export const SHELTER = {
  /** Shell bursts within this of a squad count as "shelled". */
  burstR: 45,
  /** A squad already shelled keeps its mark for bursts this much farther out (the barrage it left). */
  keepR: 50,
  /** Bursts needed (within memoryS of each other) before a squad runs for a building. */
  minBursts: 2,
  /** A squad keeps its shelter this long after the last burst, then resumes its task. */
  holdS: 14,
  /** Short search radius for a free building (a squad covers it in ≈ 40–70 s). */
  searchR: 110,
  /** A cached shelter spot is re-checked this often (taken, collapsed). */
  recheckS: 5,
  /** Known enemies within this decide the side to hide from. */
  threatR: 700,
  /** Squads per lee-wall spot (two squads share one wall at most). */
  spotCrowd: 2,
} as const;

/** A/B switch for headless comparisons (scripts only). */
export const SHELTER_AB = { enabled: true };

/** Squads that take cover (guns and their crews stay with the gun). */
const SHELTERS = new Set(['infantry', 'recon', 'mg', 'engineer', 'motor_inf', 'commander']);

interface Mark {
  at: number;
  count: number;
  /** Running mean burst point: the side the squad hides from. */
  x: number;
  z: number;
  spot: V2 | null;
  /** The side the squad hides from (fixed once chosen). */
  from: V2 | null;
  checkedAt: number;
}

const marks = new WeakMap<World, Map<number, Mark>>();

function table(world: World): Map<number, Mark> {
  let m = marks.get(world);
  if (!m) marks.set(world, (m = new Map()));
  return m;
}

const SC: Unit[] = [];

/** A shell burst at `at` (resolveBlast, kind 'shell'): mark the foot squads around it. */
export function noteShellBurst(world: World, at: V2): void {
  const tbl = table(world);
  const reach = SHELTER.burstR + SHELTER.keepR;
  for (const u of world.spatial.query(at.x, at.z, reach, SC)) {
    if (u.hp <= 0 || u.fixed || !SHELTERS.has(u.def.id)) continue;
    const d = Math.hypot(u.pos.x - at.x, u.pos.z - at.z);
    const m = tbl.get(u.id);
    const fresh = !!m && world.time - m.at <= SHELTER.holdS;
    // New marks only close to the burst; a squad already sheltering (or on its way) keeps its
    // mark while the barrage goes on around the place it just left.
    if (d > (fresh ? reach : SHELTER.burstR)) continue;
    if (!m || !fresh) {
      tbl.set(u.id, { at: world.time, count: 1, x: at.x, z: at.z, spot: null, from: null, checkedAt: -1e9 });
      continue;
    }
    m.at = world.time;
    if (d <= SHELTER.burstR) {
      m.count++;
      m.x += (at.x - m.x) * 0.35;
      m.z += (at.z - m.z) * 0.35;
    }
  }
  if (tbl.size > 4096) for (const [id, m] of tbl) if (world.time - m.at > SHELTER.holdS || !world.unitAlive(id)) tbl.delete(id);
}

/** Whether the squad is (still) under shellfire by the rules above. */
export function shelled(world: World, u: Unit): boolean {
  const m = marks.get(world)?.get(u.id);
  return !!m && m.count >= SHELTER.minBursts && world.time - m.at <= SHELTER.holdS;
}

function crowded(world: World, u: Unit, p: V2): boolean {
  let n = 0;
  for (const o of world.spatial.query(p.x, p.z, 6, SC)) if (o.owner === u.owner && o.id !== u.id && o.hp > 0 && ++n >= SHELTER.spotCrowd) return true;
  return false;
}

const NEAR: number[] = [];

/** Nearest free lee-wall spot (against bursts from `from`) of an intact building within searchR of the squad. */
export function shelterSpot(world: World, u: Unit, from: V2): V2 | null {
  const t = world.terrain;
  const nav = world.navFor(u);
  let best: V2 | null = null;
  let bd: number = SHELTER.searchR;
  for (const k of buildingsNear(t, u.pos, SHELTER.searchR, NEAR)) {
    const b = t.buildings[k];
    if (Math.abs(b.x - u.pos.x) > bd + 15 || Math.abs(b.z - u.pos.z) > bd + 15 || isCollapsed(world, k)) continue;
    const dx = b.x - from.x;
    const dz = b.z - from.z;
    const L = Math.hypot(dx, dz);
    if (L < 1) continue;
    const ux = dx / L;
    const uz = dz / L;
    const e = extentAlong(b, ux, uz) + 1.0;
    // Three spots along the lee wall, so a building can shelter more than one squad.
    const along = Math.min(b.w, b.d) / 3;
    for (const s of [0, 1, -1]) {
      const p = { x: b.x + ux * e - uz * along * s, z: b.z + uz * e + ux * along * s };
      const d = dist(p, u.pos);
      if (d >= bd || !t.inBounds(p.x, p.z) || t.buildingH(p.x, p.z) > 0 || !nav.passable(p)) continue;
      if (shieldBuilding(world, p, from) < 0 || crowded(world, u, p)) continue;
      bd = d;
      best = p;
    }
  }
  return best;
}

/**
 * Behaviour hook (behavior.thinkUnit): a shelled foot squad with no works / bunker of its own
 * takes cover at a building and fights from there. Returns false (normal task) when the squad is
 * not shelled, already protected, or has no free building within the short radius.
 */
export function takeShelter(world: World, u: Unit): boolean {
  if (!SHELTER_AB.enabled || !SHELTERS.has(u.def.id) || u.mounted || u.fixed || u.manual) return false;
  const tbl = marks.get(world);
  const m = tbl?.get(u.id);
  if (!m) return false;
  if (world.time - m.at > SHELTER.holdS) {
    tbl!.delete(u.id);
    return false;
  }
  if (m.count < SHELTER.minBursts) return false;
  // Works, a fort slot or a pillbox / bunker already protect it (their own duty keeps it there).
  if (u.fortId !== null || u.worksFacing !== null || garrisonCover(u) !== null) return false;
  if (!m.spot || world.time - m.checkedAt > SHELTER.recheckS) {
    // Hide from the enemy side (where the guns and their spotters are), else from the bursts.
    // The side is fixed once a spot is chosen, so the squad does not circle the house.
    if (!m.from) m.from = threatCentre(world, u.owner, u.pos, SHELTER.threatR) ?? { x: m.x, z: m.z };
    const from = m.from;
    const keep = m.spot && shieldBuilding(world, m.spot, from) >= 0 && (dist(u.pos, m.spot) < 3 || !crowded(world, u, m.spot));
    if (!keep) {
      const here = u.cover === 3 && shieldBuilding(world, u.pos, from) >= 0;
      m.spot = here ? { x: u.pos.x, z: u.pos.z } : shelterSpot(world, u, from);
    }
    m.checkedAt = world.time;
  }
  if (!m.spot) return false;
  if (dist(u.pos, m.spot) > 2.5) moveTo(world, u, m.spot);
  else stop(u);
  selectTarget(world, u, null);
  u.status = 'status.takingCover';
  return true;
}
