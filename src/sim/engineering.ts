import { trySpend } from './economy';
import { moveTo, stop } from './movement';
import { availableM } from './production';
import { crossings } from './terrainai';
import { Ground } from './terrain';
import type { Fort, Front, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * Field engineering (user request): engineers bridge rivers where a group's direct route is
 * blocked and no bridge/ford is reasonably close. A pontoon is a work site on the river; when
 * finished it becomes a real crossing (terrain + navigation updated for everyone).
 */
export const PONTOON = {
  costM: 15, // × army scale
  workSeconds: 70,
  hp: 900,
  width: 9,
  detourMin: 380, // build only if the nearest crossing is farther than this from the route
  maxSpan: 70,
} as const;

export interface BridgeSite {
  readonly a: V2; // our bank
  readonly b: V2; // far bank
  readonly mid: V2;
}

/** Walk the straight line from → to; return the first water span (bank to bank) if any. */
export function waterSpan(world: World, from: V2, to: V2): BridgeSite | null {
  const t = world.terrain;
  const L = dist(from, to);
  const n = Math.ceil(L / 4);
  let a: V2 | null = null;
  for (let k = 1; k <= n; k++) {
    const p = { x: from.x + ((to.x - from.x) * k) / n, z: from.z + ((to.z - from.z) * k) / n };
    const g = t.groundAt(p.x, p.z);
    const wet = g === Ground.Water;
    if (wet && !a) a = { x: from.x + ((to.x - from.x) * (k - 1)) / n, z: from.z + ((to.z - from.z) * (k - 1)) / n };
    if (!wet && a) {
      if (dist(a, p) > PONTOON.maxSpan) return null;
      return { a, b: p, mid: { x: (a.x + p.x) / 2, z: (a.z + p.z) / 2 } };
    }
  }
  return null;
}

/**
 * Does this group need a bridge? True when its route to the target crosses deep water and the
 * nearest existing crossing (bridge, ford, finished or planned pontoon) is a long detour.
 */
export function bridgeSiteFor(world: World, s: Front, from: V2): BridgeSite | null {
  const span = waterSpan(world, from, s.targetPos);
  if (!span) return null;
  const nearestCrossing = crossings(world).filter((c) => c.kind !== 'pass').reduce((m, c) => Math.min(m, dist(c.pos, span.mid)), Infinity);
  const nearestPontoon = world.forts.filter((f) => f.kind === 'pontoon' && f.hp > 0).reduce((m, f) => Math.min(m, dist(f.pos, span.mid)), Infinity);
  if (Math.min(nearestCrossing, nearestPontoon) < PONTOON.detourMin) return null;
  return span;
}

/** Engineer task: go to the site and build; pauses when suppressed. Returns true while busy. */
export function thinkBridgeBuilder(world: World, u: Unit, s: Front, site: BridgeSite): boolean {
  const f = world.factions[u.owner];
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  let fort = world.forts.find((x) => x.kind === 'pontoon' && x.hp > 0 && dist(x.pos, site.mid) < 40);
  if (!fort) {
    const cost = PONTOON.costM * k;
    if (availableM(world, f) < cost || !trySpend(f, 0, cost).ok) {
      u.status = 'status.noBudget';
      return false;
    }
    const span = dist(site.a, site.b);
    const pontoon: Fort = {
      id: world.newId(), owner: u.owner, kind: 'pontoon', pos: site.mid, facing: headingTo(site.a, site.b),
      hp: PONTOON.hp, maxHp: PONTOON.hp, progress: 0, occupant: null, length: span + 10, start: site.a, end: site.b,
    };
    world.forts.push(pontoon);
    world.note(u.owner, 'log.bridgeStarted', {}, 'info');
    fort = pontoon;
  }
  if (fort.progress >= 1) return false;
  const work = fort.start ?? site.a;
  if (dist(u.pos, work) > 14) moveTo(world, u, work);
  else {
    stop(u);
    if (u.moraleState === 'normal') {
      // Called from the unit executor (~every 0.4 s); several engineers build faster.
      fort.progress = Math.min(1, fort.progress + 0.4 / PONTOON.workSeconds);
      if (fort.progress >= 1) completeBridge(world, fort);
    }
  }
  u.status = 'status.bridging';
  s.reason = 'reason.bridging';
  return true;
}

/** Finished pontoon: terrain becomes a deck-height road across the water; paths refresh. */
export function completeBridge(world: World, fort: Fort): void {
  if (!fort.start || !fort.end) return;
  world.terrain.addBridge(fort.start, fort.end, PONTOON.width);
  world.onTerrainChanged?.(fort.start, fort.end);
  world.note(fort.owner, 'log.bridgeBuilt', {}, 'info');
}
