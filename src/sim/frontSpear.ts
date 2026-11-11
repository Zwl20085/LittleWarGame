import { EAGER, eagerOn } from './strategyai';
import { STRUCT, structureSlots } from './structures';
import type { Faction, Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';
import { inMass } from './frontslots';
import { boundOrder } from './frontref';
import { isTank } from './armour';
import { isMotorized } from './upgradestats';

/**
 * 2.1 (works on the ordered line): free building slots and trench bays within `STRUCT.zoneSlotM` of
 * the line go to the nearest foot squads of the front (buildings first, as structureSlots orders
 * them); the rest keep their line slots. Squads already inside a building keep it. O(slots × squads).
 */
export function manWorks(world: World, f: Faction, line: { a: V2; b: V2 }, liners: Unit[], slots: Record<number, V2>): void {
  const posts = structureSlots(world, f.id, line.a, line.b, STRUCT.zoneSlotM).filter((p) => !p.taken);
  if (posts.length === 0) return;
  const free = liners.filter((u) => u.def.kind === 'infantry' && u.fortId === null);
  const used = new Set<number>();
  for (const p of posts) {
    let best: Unit | null = null;
    let bd = Infinity;
    for (const u of free) {
      if (used.has(u.id)) continue;
      const d = dist(u.pos, p.pos);
      if (d < bd) { bd = d; best = u; }
    }
    if (!best) return;
    used.add(best.id);
    slots[best.id] = { ...p.pos };
  }
}

/** 2.1: a binding attack order masses at most this long before it pushes. */
const BOUND_MASS_WAIT_S = 30;

/** Round 2 per-group push bookkeeping (not shipped to the UI / snapshot). */
export interface EagerState { holdSince: number; pushUntil: number; massSince: number; massed: number; massNeed: number }
export const eager = new WeakMap<Front, EagerState>();

/**
 * Round 2 push decision on top of the ratio threshold:
 * - holding has a cost: after `holdPatienceS` in hold while the whole group outweighs the enemy at the
 *   anchor (groupRatio ≥ holdPushRatio) and with an army that wants to fight (aggression > 0), push;
 * - frontal attacks mass first: hold near the anchor until `frontalMassShare` of the mass is within
 *   `massRadius` (or `massWaitS` passed) instead of trickling forward unit by unit.
 */
export function eagerPush(world: World, f: Faction, s: Front, units: Unit[], anchor: V2, ratio: number, groupRatio: number, wantsPush: boolean, pushing: boolean): boolean {
  const now = world.time;
  let st = eager.get(s);
  if (!st) {
    st = { holdSince: now, pushUntil: -1, massSince: -1, massed: 0, massNeed: 0 };
    eager.set(s, st);
  }
  if (!wantsPush) {
    st.holdSince = now;
    st.pushUntil = -1;
    st.massSince = -1;
    return false;
  }
  const ordered = boundOrder(s) && s.order.kind === 'attack';
  let push = ordered || pushing || (now < st.pushUntil && ratio >= 0.8);
  if (!push && f.command.aggression > 0 && groupRatio >= EAGER.holdPushRatio && now - st.holdSince > EAGER.holdPatienceS) push = true;
  if (!push) st.massSince = -1;
  if (push && s.op === 'frontal' && s.posture !== 'assault' && s.mode !== 'push') {
    if (st.massSince < 0) st.massSince = now;
    const share = EAGER.massShare + EAGER.massShareAggr * f.command.aggression;
    let liners = 0;
    let near = 0;
    for (const u of units) {
      if (u.opRole !== 'line' || u.spearhead || u.behavior !== 'advance' || !inMass(u, share)) continue;
      liners++;
      if (dist(u.pos, anchor) < EAGER.massRadius) near++;
    }
    st.massed = near;
    st.massNeed = Math.ceil(liners * EAGER.frontalMassShare);
    if (near < st.massNeed && now - st.massSince < (ordered ? Math.min(EAGER.massWaitS, BOUND_MASS_WAIT_S) : EAGER.massWaitS)) push = false;
  }
  if (push) {
    if (s.mode !== 'push') st.pushUntil = Math.max(st.pushUntil, now + EAGER.holdPatienceS * 0.5);
    st.massSince = -1;
  } else if (s.mode !== 'hold') st.holdSince = now;
  return push;
}

/**
 * Breakthrough: with decisive local superiority, detach a mobile group (tanks + motorized/fresh infantry)
 * to drive through the front and seize an enemy settlement behind it — or the enemy capital.
 */
const SPEAR_MOBILE = new Set(['light_tank', 'medium_tank', 'heavy_tank', 'motor_inf']);
const isSpearMobile = (u: Unit): boolean => SPEAR_MOBILE.has(u.def.id) || isMotorized(u);
// 2.2 wave 2: a unit on a detachment (raid, garrison …) is not pulled into a thrust.
const spearReady = (u: Unit): boolean => !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance' && u.hp > u.def.maxHp * 0.6 && u.opRole === 'line';

/** Fresh tanks and motorized squads (including rifle squads with `motorization` upgrade) free for a thrust. */
export function mobileFresh(units: Unit[]): number {
  let n = 0;
  for (const u of units) if (isSpearMobile(u) && spearReady(u)) n++;
  return n;
}

const spearRank = (u: Unit): number => (isTank(u) ? 0 : isSpearMobile(u) ? 1 : 2);

export function launchSpearhead(world: World, f: Faction, s: Front, units: Unit[], anchor: V2): void {
  let target: string | null = null;
  let tpos: V2 | null = null;
  let best = Infinity;
  const fin = eagerOn() ? f.command.finishTarget : -1;
  if (fin >= 0 && dist(world.hqPos(fin), anchor) < EAGER.finishSpearheadM) {
    target = `hq:${fin}`;
    tpos = world.hqPos(fin);
  }
  for (const o of world.objectives) {
    if (target) break;
    if (o.owner < 0 || o.owner === f.id || !world.isHostile(f.id, o.owner)) continue;
    const d = dist(o.pos, anchor) * (o.kind === 'city' ? 0.7 : o.kind === 'town' ? 0.85 : 1);
    if (d < best && d < 1100) {
      best = d;
      target = o.id;
      tpos = o.pos;
    }
  }
  if (!target) {
    for (const e of world.factions) {
      if (!e.alive || !world.isHostile(f.id, e.id)) continue;
      const d = dist(world.hqPos(e.id), anchor);
      if (d < best && d < 1400) {
        best = d;
        target = `hq:${e.id}`;
        tpos = world.hqPos(e.id);
      }
    }
  }
  if (!target || !tpos) return;
  const pool = units
    .filter((u) => spearReady(u)
      && (u.def.kind === 'vehicle' ? u.def.id !== 'supply_truck' : u.def.id === 'infantry' || u.def.id === 'engineer' || u.def.id === 'motor_inf'))
    .sort((a, b) => spearRank(a) - spearRank(b) || dist(a.pos, anchor) - dist(b.pos, anchor));
  const size = Math.max(4, Math.round(units.length * EAGER.spearShare));
  const head = pool.slice(0, size);
  const foot = pool.slice(size).filter((u) => u.def.kind === 'infantry').slice(0, Math.max(0, 3 - head.filter((u) => u.def.kind === 'infantry').length));
  const group = [...head, ...foot];
  if (group.filter((u) => u.def.kind === 'infantry').length < 2) return;
  for (const u of group) u.spearhead = target;
  s.lastSpearhead = world.time;
  s.mode = 'breakthrough';
  world.note(f.id, 'log.spearhead', { point: target.startsWith('hq:') ? '' : target, n: group.length }, 'info');
}
