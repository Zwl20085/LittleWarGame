import { selectTarget } from './combat';
import { moveTo, stop } from './movement';
import { hostileMask } from './spatial';
import { stormOn } from './strategyai';
import { navPost } from './crewai';
import { dig, openWork } from './works';
import { isCommander } from './formulas';
import { eligibleCapturer } from './capture';
import { leaveStructure } from './structures';
import { HOME, homeOn, HQ_POINT } from './homeguard';
import type { Front, Unit } from './types';
import { angleDiff, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

const hqKey = (f: number): string => `hq:${f}`;

/** Spread in [-0.5, 0.5) by id (stable). */
const spreadOf = (u: Unit): number => (((Math.imul(u.id, 2654435761) >>> 0) % 1000) / 1000) - 0.5;

/** Round 4: posts on the unit's own nav grid (an AT gun sat "unreachable" for 10 min on a freeNear spot). */
const postAt = (world: World, u: Unit, p: V2): V2 => (stormOn() ? navPost(world, u, p) : world.terrain.freeNear(p, 30));

function guardPost(world: World, u: Unit, hq: V2, bearing: number): V2 {
  const s = spreadOf(u);
  if (u.def.kind === 'crew' || u.def.kind === 'vehicle') {
    const r = u.def.kind === 'crew' ? HOME.trenchR - 40 : HOME.sandbagR + 30;
    const nav = world.navFor(u);
    let first: V2 | null = null;
    for (let k = 0; k < 7; k++) {
      const a = bearing + s * 0.9 + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.35);
      const p = postAt(world, u, { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r });
      first ??= p;
      if (nav.connected(u.pos, p)) return p;
    }
    return first!;
  }
  let best: { a: V2; b: V2; facing: number } | null = null;
  let bestScore = Infinity;
  for (const w of world.forts) {
    if (w.owner !== u.owner || w.hp <= 0 || w.progress < 1 || (w.kind !== 'trench' && w.kind !== 'sandbag') || !w.start || !w.end) continue;
    const d = dist(w.pos, hq);
    if (d > HOME.worksRadiusM) continue;
    const off = Math.abs(angleDiff(headingTo(hq, w.pos), bearing));
    if (off > 1.1) continue;
    const score = off + (((u.id + w.id) * 7) % 5) * 0.05;
    if (score < bestScore) { bestScore = score; best = { a: w.start, b: w.end, facing: w.facing }; }
  }
  if (best) {
    const t = s + 0.5;
    const p = { x: best.a.x + (best.b.x - best.a.x) * t, z: best.a.z + (best.b.z - best.a.z) * t };
    return { x: p.x - Math.cos(best.facing) * 2, z: p.z - Math.sin(best.facing) * 2 };
  }
  const a = bearing + s * 1.4;
  return postAt(world, u, { x: hq.x + Math.cos(a) * HOME.sandbagR * 0.9, z: hq.z + Math.sin(a) * HOME.sandbagR * 0.9 });
}

/**
 * Home guard (a garrison of the capital, `opObjective = hq:<f>`): counter-attack enemies inside
 * the town; otherwise dig the open home works (no enemy inside noDigM) or man a post on the
 * threatened approach — infantry in a finished trench / behind sandbags, AT guns and MGs on the
 * axis just behind the trench line.
 */
export function thinkHomeGuard(world: World, u: Unit): boolean {
  if (hqDuty(world, u)) return true;
  const f = world.factions[u.owner];
  const hq = world.hqPos(u.owner);
  const ht = f.command.homeThreat;
  let foe: Unit | null = null;
  let bd: number = HOME.worksRadiusM;
  for (const e of world.spatial.queryOwners(hq.x, hq.z, bd, hostileMask(world, u.owner))) {
    if (e.hp <= 0 || !world.knows(u.owner, e)) continue;
    const d = dist(e.pos, hq);
    if (d < bd) { bd = d; foe = e; }
  }
  u.status = 'status.homeGuard';
  if (foe && bd < HOME.sandbagR + 40) {
    if (u.def.kind !== 'crew') moveTo(world, u, foe.pos);
    else if (u.path.length === 0) stop(u);
    selectTarget(world, u, foe.pos);
    return true;
  }
  if (u.def.kind === 'infantry' && u.moraleState === 'normal' && (!foe || dist(foe.pos, u.pos) > HOME.noDigM)) {
    const work = openWork(world, u.owner, hq, HOME.worksRadiusM);
    if (work) {
      selectTarget(world, u, null);
      if (dig(u, work, (p) => moveTo(world, u, p), () => stop(u))) return true;
    }
  }
  if (!u.opTarget || world.time > u.opUntil || Math.abs(angleDiff(headingTo(hq, u.opTarget), ht.bearing)) > 1.2) {
    u.opTarget = guardPost(world, u, hq, ht.bearing);
    u.opUntil = world.time + 20;
  }
  if (dist(u.pos, u.opTarget) > 8) moveTo(world, u, u.opTarget);
  else stop(u);
  selectTarget(world, u, foe ? foe.pos : null);
  return true;
}

/**
 * Round 7: the HQ point. A point holder stands within `HQ_POINT.postR` of the HQ (only eligible
 * infantry inside command_radius_m blocks a capture); during a breach every non-crew home guard
 * makes for the point and goes for any enemy inside it. Runs before structure duty (behavior.ts).
 */
export function hqDuty(world: World, u: Unit): boolean {
  if (u.opRole !== 'garrison' || u.opObjective !== hqKey(u.owner) || u.manual || u.routing || !homeOn()) return false;
  const ht = world.factions[u.owner].command.homeThreat;
  const holder = ht.holders.includes(u.id);
  if (!holder && !(ht.breach && u.def.kind !== 'crew')) return false;
  const hq = world.hqPos(u.owner);
  const r = world.data.rules.victory.command_radius_m;
  if (u.fortId !== null) {
    if (dist(u.pos, hq) <= r * 0.8) return false;
    leaveStructure(world, u);
  }
  let foe: Unit | null = null;
  let inside: Unit | null = null;
  let bd: number = HQ_POINT.engageR;
  for (const e of world.spatial.queryOwners(hq.x, hq.z, HQ_POINT.engageR, hostileMask(world, u.owner))) {
    if (e.hp <= 0 || !world.knows(u.owner, e)) continue;
    const d = dist(e.pos, hq);
    if (d < bd) { bd = d; foe = e; }
    if (d <= r + HQ_POINT.breachPadM && eligibleCapturer(world, e) && (!inside || d < dist(inside.pos, hq))) inside = e;
  }
  u.status = 'status.homeGuard';
  if (inside && !holder) moveTo(world, u, inside.pos);
  else {
    const a = (spreadOf(u) + 0.5) * Math.PI * 2;
    const post = navPost(world, u, { x: hq.x + Math.cos(a) * HQ_POINT.postR, z: hq.z + Math.sin(a) * HQ_POINT.postR }, 20);
    if (dist(u.pos, post) > 4) moveTo(world, u, post);
    else stop(u);
  }
  selectTarget(world, u, (inside ?? foe)?.pos ?? null);
  return true;
}

/**
 * Recalled group, far from home: fall back in good order — march to the slot near the capital,
 * returning fire at targets of opportunity, instead of staying pinned in the old fight.
 */
export function fallBackHome(world: World, u: Unit, s: Front): boolean {
  if (s.reason !== 'reason.homeDefence' || u.def.id === 'howitzer' || u.def.id === 'mortar' || isCommander(u.def)) return false;
  const hq = world.hqPos(u.owner);
  if (dist(u.pos, hq) < HOME.contactM) return false;
  const slot = s.slots[u.id] ?? s.front;
  moveTo(world, u, slot);
  selectTarget(world, u, null);
  u.status = 'status.fallingBack';
  return true;
}
