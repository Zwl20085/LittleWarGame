import { safeRear } from './frontai';
import { hostileMask } from './spatial';
import { bombardPoint } from './storm';
import { threatCentre } from './terrainai';
import type { Sector, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Round 4 crew-weapon deployment (balance probe: MGs stood with no target 59 % of the time and
 * fired ~2 %, AT guns relocated without a target 58 % and fired ~1 %, mortars relocated 73 %).
 * Crews now deploy on the axis of their group's engagement, inside their range of the enemy
 * mass, keep their post unless the fight moves (hysteresis), and stay put for a while after the
 * last shot. Guns besieging a capital deploy within range of its works and garrison (storm.ts).
 */
export const CREW = {
  /** Engagement centre: known enemies within this radius of the group's front (cached per group). */
  engageR: 450,
  cacheS: 2,
  /** Direct-fire crews stand at this share of their range from the enemy mass; lateral spread ±spreadM. */
  mgShare: 0.85,
  atShare: 0.8,
  spreadM: 25,
  /** Indirect fire: share of range from the enemy mass (capital siege: from the defenders). */
  mortarShare: 0.75,
  howitzerShare: 0.7,
  siegeShare: 0.8,
  /** Keep the current post unless the wanted one moved this far (m). */
  holdMoveM: 50,
  gunHoldMoveM: 90,
  /** After the last shot, stay put this long before re-deploying (s). */
  holdAfterFireS: 15,
  gunHoldAfterFireS: 20,
  /** Hot spots: up to `hotSamples` front cells sampled every `hotEveryS`; hot = known enemies within `hotR`. A crew goes to the nearest hot spot within `hotReachM`. */
  hotSamples: 64,
  hotEveryS: 3,
  hotR: 250,
  hotReachM: 900,
} as const;

/** A stretch of our front with known enemies near: our cell and the enemy mass facing it. */
interface HotSpot { cell: V2; enemy: V2 }
const hotCache = new WeakMap<World, Map<number, { t: number; spots: HotSpot[] }>>();

/** Where the faction's front is actually fighting (sampled front cells with known enemies near), cached. */
function hotSpots(world: World, f: number): HotSpot[] {
  let m = hotCache.get(world);
  if (!m) {
    m = new Map();
    hotCache.set(world, m);
  }
  const c = m.get(f);
  if (c && world.time - c.t < CREW.hotEveryS) return c.spots;
  const cells = world.frontInfo[f]?.cells ?? [];
  const step = Math.max(1, Math.floor(cells.length / CREW.hotSamples));
  const mask = hostileMask(world, f);
  const spots: HotSpot[] = [];
  for (let k = 0; k < cells.length; k += step) {
    const cell = cells[k];
    let sx = 0;
    let sz = 0;
    let w = 0;
    for (const u of world.spatial.queryOwners(cell.x, cell.z, CREW.hotR, mask)) {
      if (u.hp <= 0 || !world.knows(f, u)) continue;
      sx += u.pos.x;
      sz += u.pos.z;
      w++;
    }
    if (w > 0) spots.push({ cell, enemy: { x: sx / w, z: sz / w } });
  }
  m.set(f, { t: world.time, spots });
  return spots;
}

/** Nearest hot spot to the unit within reach, else the group's own engagement (as a spot), else null. */
function fightFor(world: World, u: Unit, s: Sector): HotSpot | null {
  let best: HotSpot | null = null;
  let bd: number = CREW.hotReachM;
  for (const h of hotSpots(world, u.owner)) {
    const d = dist(h.cell, u.pos);
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  if (best) return best;
  const e = engagement(world, u.owner, s);
  return e ? { cell: dist(s.front, e) > 40 ? s.front : world.cityOf(u.owner).exit, enemy: e } : null;
}

interface Engagement { t: number; p: V2 | null }
const engagements = new WeakMap<Sector, Engagement>();
const posts = new WeakMap<Unit, V2>();

/** Known enemy mass at the group's front (null = not in contact), cached per group. */
export function engagement(world: World, f: number, s: Sector): V2 | null {
  const e = engagements.get(s);
  if (e && world.time - e.t < CREW.cacheS) return e.p;
  const p = threatCentre(world, f, s.front, CREW.engageR);
  engagements.set(s, { t: world.time, p });
  return p;
}

/** A passable spot for this unit's movement class near p (guards / garrison posts / crews). */
export function navPost(world: World, u: Unit, p: V2, r = 40): V2 {
  return world.navFor(u).nearestPassable(p, r) ?? world.terrain.freeNear(p, 30);
}

/** Keep the old post unless the wanted one moved more than `move` metres. */
function sticky(world: World, u: Unit, want: V2, move: number): V2 {
  const old = posts.get(u);
  if (old && dist(old, want) < move) return old;
  const p = navPost(world, u, want);
  posts.set(u, p);
  return p;
}

/** Point at `d` from `from` toward `to` (or `from` itself if they coincide), shifted sideways by `side` m. */
function along(from: V2, to: V2, d: number, side: number): V2 {
  const l = Math.max(1, dist(from, to));
  const ux = (to.x - from.x) / l;
  const uz = (to.z - from.z) / l;
  return { x: from.x + ux * d - uz * side, z: from.z + uz * d + ux * side };
}

const spreadOf = (u: Unit): number => (((Math.imul(u.id, 2654435761) >>> 0) % 1000) / 1000) - 0.5;

/** MG / AT post: on the axis between the enemy mass and our line, inside range; null = use the formation slot. */
export function crewPost(world: World, u: Unit, s: Sector): V2 | null {
  // The nearest stretch of front that is actually fighting (transit was 60–75 % of crew time).
  const h = fightFor(world, u, s);
  if (!h) {
    posts.delete(u);
    return null;
  }
  const range = u.primary?.range ?? 150;
  const share = u.def.id === 'mg' ? CREW.mgShare : CREW.atShare;
  // On our side of the enemy mass, inside range of it.
  const ours = dist(h.cell, h.enemy) > 20 ? h.cell : world.cityOf(u.owner).exit;
  return sticky(world, u, along(h.enemy, ours, range * share, spreadOf(u) * 2 * CREW.spreadM), CREW.holdMoveM);
}

/** Gun post: within range of the capital's defenders when besieging it, else of the group's enemy mass; null = old rule. */
export function gunPost(world: World, u: Unit, s: Sector, safe: number): V2 | null {
  const range = u.primary?.range ?? 300;
  const home = world.cityOf(u.owner).exit;
  if (s.op === 'siege' && s.targetCity !== null && s.opPhase !== '') {
    const p = bombardPoint(world, u.owner, s.targetPos, home, range, CREW.siegeShare);
    return sticky(world, u, safeRear(world, u.owner, along(p, home, 0, spreadOf(u) * 40), home, safe * 0.5), CREW.gunHoldMoveM);
  }
  const h = fightFor(world, u, s);
  if (!h) {
    posts.delete(u);
    return null;
  }
  const share = u.def.id === 'howitzer' ? CREW.howitzerShare : CREW.mortarShare;
  const p = along(h.enemy, dist(h.cell, h.enemy) > 20 ? h.cell : home, range * share, spreadOf(u) * 40);
  return sticky(world, u, safeRear(world, u.owner, p, home, safe), CREW.gunHoldMoveM);
}

/** Recently fired and no target now: hold the position instead of wandering off. */
export function holdAfterFire(world: World, u: Unit, gun: boolean): boolean {
  return u.lastFiredAt > 0 && world.time - u.lastFiredAt < (gun ? CREW.gunHoldAfterFireS : CREW.holdAfterFireS);
}
