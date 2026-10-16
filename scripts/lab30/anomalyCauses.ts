// Root-cause guesses for the anomaly probe (read-only). Each returns the probes that fired, most
// specific first; the first one is the record's main cause.
import type { Front, Place, Unit } from '../../src/sim/types';
import type { V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { dist, isCombat, isTruck, logi, mode, nearestOwnPlace, drawRadiusOf, placeContestedOf } from './anomalyWorld';

export const CAUSE = {
  deadZone: 'cannot fire, above rearm_below (no rearm trigger)',
  rearmRetry: 'rearm search failed (no stock / truck in reach)',
  pathBlocked: 'path blocked',
  outOfRange: 'out of supply range',
  stockEmpty: 'town stock empty',
  crowd: 'crowd cap',
  noTrucks: 'no trucks',
  convoyElsewhere: 'convoy destination elsewhere',
  noTruck: 'no truck assigned',
  truckShort: 'truck stops short of the group',
  inContact: 'in contact (no draw while fighting)',
  aboveRearm: 'above rearm_below (low but still firing)',
} as const;

const majority = (n: number, of: number): boolean => n * 2 >= of && of > 0;

/** Why a cluster of combat units is out of ammunition. */
export function starvedCauses(w: World, members: readonly Unit[], c: V2): string[] {
  const l = logi(w);
  const t = w.time;
  const out: string[] = [];
  const n = members.length;
  const below = l?.rearm_below ?? 0.12;
  const until = l?.rearm_until ?? 0.6;
  if (majority(members.filter((u) => u.ammo >= below && u.primary !== null && u.primary.ammoCost > u.ammo + 1e-9).length, n)) out.push(CAUSE.deadZone);
  if (majority(members.filter((u) => !u.rearming && u.rearmAt > t).length, n)) out.push(CAUSE.rearmRetry);
  if (members.filter((u) => u.pathFailed).length >= n * 0.3) out.push(CAUSE.pathBlocked);
  const f = members[0].owner;
  const need = members.reduce((a, u) => a + Math.max(0, until - u.ammo) * u.def.supplyDemand, 0) / Math.max(1, n);
  const near = nearestOwnPlace(w, f, c);
  if (!near || near.d > (l?.stock_seek_radius_m ?? 2200)) out.push(CAUSE.outOfRange);
  else {
    if (near.place.stock < need) out.push(CAUSE.stockEmpty);
    const r = drawRadiusOf(w, near.place);
    const needy = w.spatial.query(near.place.pos.x, near.place.pos.z, r).filter((u) => u.owner === f && isCombat(u) && u.ammo < 0.999 && dist(u.pos, near.place.pos) <= r).length;
    if (needy > (l?.crowd_free ?? 6) + 4) out.push(CAUSE.crowd);
  }
  const trucks = w.aliveUnits.filter((u) => u.owner === f && u.hp > 0 && isTruck(u));
  const front = mode(members.map((u) => u.frontId));
  const busy = trucks.filter((u) => u.truckState === 'out' || u.truckState === 'unload');
  const mine = busy.filter((u) => u.frontId === front);
  if (trucks.length === 0) out.push(CAUSE.noTrucks);
  else if (mine.length === 0) out.push(busy.length > 0 ? CAUSE.convoyElsewhere : CAUSE.noTruck);
  else if (!mine.some((u) => dist(u.pos, c) <= (l?.truck_seek_radius_m ?? 450))) out.push(CAUSE.truckShort);
  const contactS = l?.draw_contact_seconds;
  if (contactS !== undefined && majority(members.filter((u) => t - u.lastFiredAt < contactS).length, n)) out.push(CAUSE.inContact);
  if (majority(members.filter((u) => u.ammo >= below).length, n) && !out.includes(CAUSE.deadZone)) out.push(CAUSE.aboveRearm);
  return out.length ? out : ['unknown'];
}

/** Why a stuck / unreachable unit cannot get on. */
export function navCause(w: World, u: Unit): string {
  const nav = w.navFor(u);
  if (!nav.nearestPassable(u.pos, 24)) return 'start off the nav grid';
  if (u.dest && !nav.nearestPassable(u.dest, 40)) return 'goal impassable';
  if (w.spatial.query(u.pos.x, u.pos.z, 8).length - 1 > 6) return 'crowd';
  if (w.forts.some((f) => f.hp > 0 && dist(f.pos, u.pos) < 15)) return 'path blocked by works';
  return u.pathFailed ? 'path blocked (no route)' : 'path blocked (local)';
}

/** Why a truck has delivered nothing for 5 minutes. */
export function truckCause(w: World, u: Unit): string {
  const cap = logi(w)?.truck_capacity ?? 40;
  switch (u.truckState) {
    case 'load': {
      const at = nearestOwnPlace(w, u.owner, u.pos);
      if (at && at.d < 150 && at.place.stock < 1) return CAUSE.stockEmpty;
      return u.cargo >= cap * 0.95 ? 'no destination (no demand)' : 'loading (stock slow)';
    }
    case 'out': return u.pathFailed ? CAUSE.pathBlocked : 'never reaches its destination';
    case 'unload': return 'no takers within hand-over radius';
    default: return 'turned back (threat / failed path)';
  }
}

export function idleCause(w: World, herd: readonly Unit[]): string[] {
  const st = mode(herd.map((u) => u.status)) ?? '?';
  const f = w.factions[herd[0].owner];
  const front = f.fronts.find((s) => s.id === mode(herd.map((u) => u.frontId)));
  return [`idle: ${st}`, front ? `front mode ${front.mode} / order ${front.order.kind}` : 'no front'];
}

export function supplyChainCause(w: World, p: Place, owner: number): string {
  if (placeContestedOf(w, p)) return 'contested';
  const f = w.factions[owner];
  if (!f || f.logistics < 1) return 'no logistics L';
  if (w.aliveUnits.some((u) => u.owner === owner && isTruck(u) && u.truckState === 'load' && dist(u.pos, p.pos) < 150)) return 'convoys drain the stock';
  return 'drain exceeds fill';
}

export function phantomCause(w: World, f: number, s: Front): string {
  const army = w.aliveUnits.filter((u) => u.owner === f && isCombat(u)).length;
  const fronts = w.factions[f].fronts.length;
  return army / Math.max(1, fronts) < 8 ? 'army spread over too many fronts' : `front starved (order ${s.order.kind})`;
}
