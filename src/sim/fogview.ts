import { observationRadius } from './capitalDefence';
import type { EconZone } from './econZones';
import { observerOf } from './terrainrules';
import type { Train } from './transportstate';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Fog of war for things that are not units (review HIGH 2): economic zones and trains. The worker
 * filters what the snapshot sends to the observer with the same observers the unit visibility pass
 * uses (sim.updateVisibility: every own unit's observerOf radius, the capital observation ring, own
 * observation points), so the minimap, the 3D zone models, ZonePanel.pickAt and the rail field only
 * ever see what the player could. Enemy zones are remembered as last seen; trains only while seen.
 * Spectators and open mode see everything.
 */

/** Radius of an owned observation point (sim.updateVisibility). */
const OBSERVATION_POINT_M = 180;

/** Filtering applies: fog mode, a real player (not a spectator) observing. */
export const fogFiltered = (w: World, observer: number): boolean =>
  w.config.infoMode === 'fog' && !w.config.spectate && !!w.factions[observer];

/** Can faction `f` see the ground at `p` now? */
export function pointSeen(w: World, f: number, p: V2): boolean {
  const ring = observationRadius(w);
  if (ring > 0 && dist(w.hqPos(f), p) <= ring) return true;
  for (const o of w.objectives) if (o.owner === f && o.type === 'observation' && dist(o.pos, p) <= OBSERVATION_POINT_M) return true;
  for (const u of w.aliveUnits) {
    if (u.owner !== f || u.hp <= 0) continue;
    const d = dist(u.pos, p);
    // Cheap bound first: no observer reaches beyond 3 × its base vision.
    if (d > u.def.vision * 3) continue;
    if (d <= observerOf(w, u).r) return true;
  }
  return false;
}

const memory = new WeakMap<World, Map<number, Map<number, EconZone>>>();

/** The zones the observer knows: its own (live), enemy ones in sight (live, remembered), else as last seen. */
export function knownZones(w: World, observer: number): EconZone[] {
  let byObs = memory.get(w);
  if (!byObs) memory.set(w, (byObs = new Map()));
  let mem = byObs.get(observer);
  if (!mem) byObs.set(observer, (mem = new Map()));
  const out: EconZone[] = [];
  const live = new Set<number>();
  for (const z of w.econZones) {
    live.add(z.id);
    if (z.owner === observer) {
      mem.delete(z.id);
      out.push(z);
    } else if (pointSeen(w, observer, z.pos)) {
      mem.set(z.id, { ...z });
      out.push(z);
    } else {
      const last = mem.get(z.id);
      if (last) out.push(last);
    }
  }
  // A remembered zone that is gone: forgotten once its ground is seen again.
  for (const [id, z] of mem) if (!live.has(id) && pointSeen(w, observer, z.pos)) mem.delete(id);
  return out;
}

/** Trains the observer sees (its own always), and whether it may know their load. */
export function trainSeen(w: World, observer: number, t: Train): boolean {
  return t.owner === observer || pointSeen(w, observer, t.pos);
}
