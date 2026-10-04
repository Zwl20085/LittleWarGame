import { AI, FRONTLINE } from './config';
import { hostileMask } from './spatial';
import { crossings, defensivePosition, firstCrossing, lineSlot, nearestFeature, threatCentre, unitDepthRank } from './terrainai';
import { frontAnchor, safeRear } from './frontai';
import { ADAPT, adaptive, EAGER, eagerOn } from './strategyai';
import { deadCapital, maneuvering, planPincer, resetOperation, runOperation, siegeRing } from './doctrine';
import { bridgeSiteFor } from './engineering';
import { frontSegments, OPS, spreadAlong, planOperations } from './operations';
import { defendingHome, homeOn, isRecalled, releaseRecall, restoreOrders, ROUND7_AB, saveOrders } from './homeguard';
import { capitalSiege, stormRing } from './storm';
import { STRUCT, structureSlots } from './structures';
import type { Faction, Objective, Front, Unit, Zone } from './types';
import { dist, headingTo, angleDiff, DEG, type V2 } from './vec';
import type { World } from './world';
import { isCommander } from './formulas';
import { activeSegment, inMass, LINE_ORDER, lineThrough, massSlot, orderAlong, terrainLine } from './frontslots';
import { boundLine, boundOrder, frontById } from './frontref';

export { frontById };

/**
 * 2.0 command hierarchy (docs/COMMAND_V2.md). A faction's army is split into *fronts*, each led
 * by a front commander unit. The supreme HQ (the player, or the AI planner) gives a front one
 * order; the commander (this module + doctrine.ts) does the tactics: objective, posture, battle
 * plan, battle line and formation slots. Front ids are stable for the match but are NOT indices
 * into `f.fronts`: the AI supreme HQ (theatre.ts) creates, merges and dissolves fronts, and a far
 * player order opens a new one (`frontForOrder`). Always look fronts up with `frontById`.
 */

/** New front with no units and an `auto` order, aimed at `target`. */
export function newFront(world: World, f: Faction, target: Objective, wing: Front['wing'], share: number): Front {
  const city = world.cityOf(f.id);
  const id = f.frontSeq++;
  return {
    id, name: target.id, wing, commanderId: null, commanderLostAt: -1,
    order: { kind: 'auto', a: { ...target.pos }, b: null, issuedAt: world.time, manual: false }, line: null,
    share, posture: 'cautious', targetPos: { ...target.pos }, targetObjective: target.id,
    targetCity: null, rally: lerpV(city.exit, target.pos, 0.35), reason: 'reason.capturePoint', reasonParams: { point: target.id }, lastRetarget: -999, postureSince: 0,
    manualTarget: false, gatheredSince: -1, advancing: false,
    front: { ...target.pos }, facing: headingTo(city.hq, target.pos), slots: {}, crossing: null, stagedSince: -1, lastSpearhead: -999, mode: 'advance', shelledAt: -999, segment: [], bridgeSite: null, bridgeCheckAt: 0,
    op: 'frontal', opLocked: false, opRoute: [], opPhase: '',
  };
}

/** Initial fronts: the nearest forward settlements by bearing from the capital (left … right). */
export function initFronts(world: World, f: Faction): void {
  const city = world.cityOf(f.id);
  const fwd = city.forwardDeg * DEG;
  const n = Math.max(1, world.data.rules.command.fronts_initial);
  const scored = world.objectives
    .map((o) => ({ o, ang: angleDiff(fwd, headingTo(city.hq, o.pos)), d: dist(city.hq, o.pos) }))
    .filter((x) => Math.abs(x.ang) < 75 * DEG)
    .sort((a, b) => a.d - b.d);
  const near = scored.slice(0, n).sort((a, b) => a.ang - b.ang);
  const shares = world.data.rules.proposed_defaults.sector_reinforcement_shares;
  // Fallback: maps without forward objectives still get fronts on the nearest points.
  const order = near.length > 0 ? near : world.objectives.map((o) => ({ o, ang: 0, d: dist(city.hq, o.pos) })).sort((a, b) => a.d - b.d).slice(0, n);
  if (order.length === 0) throw new Error(`map ${world.map.id}: no objectives for fronts`);
  const centreIdx = Math.floor((order.length - 1) / 2);
  // Biggest share to the centre, then the wings (negative bearing = left as seen from the city).
  const shareFor = (i: number): number => (i === centreIdx ? shares[0] : i < centreIdx ? shares[1] : shares[2]) ?? 1 / order.length;
  f.frontSeq = 0;
  f.fronts = order.map((x, i) => newFront(world, f, x.o, i === centreIdx ? 0 : i < centreIdx ? -1 : 1, shareFor(i)));
  f.mainFront = f.fronts[centreIdx].id;
  for (const s of f.fronts) appointCommander(world, f, s);
}

/** The front whose battle line is nearest to `p` (for orders given on the map without a front). */
export function nearestFront(f: Faction, p: V2): Front | undefined {
  let best: Front | undefined;
  let bd = Infinity;
  for (const s of f.fronts) {
    const d = s.line ? segmentDistance(p, s.line.a, s.line.b) : Math.min(dist(p, s.front), dist(p, s.targetPos));
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function segmentDistance(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/** Default line length for a point order (a line through the point, square to the capital bearing). */
const ORDER_LINE_M = 240;

/**
 * Apply a supreme-HQ order to a front: stores it, derives the line and the objective, and sets
 * the posture the order implies. The commander keeps refining tactics every think
 * (`thinkFronts`); `auto` hands the objective choice back to it.
 *
 * `order.manual` (the player) pins the objective (`manualTarget`: no AI recall, pincer or
 * retarget) and resets any operation under way. AI orders (theatre.ts, `manual: false`) are
 * re-issued by the AI supreme HQ every think, so an attack order keeps the commander's operation
 * (runOperation re-plans on a new objective) and its posture (cityai), exactly like the 1.x
 * retarget did.
 */
export function issueFrontOrder(world: World, f: Faction, s: Front, order: Front['order']): void {
  // Round 7: the same manual order given again (a player re-confirming it) keeps the posture and the operation under way.
  const prev = s.order;
  const repeat = ROUND7_AB.assault && order.manual && prev.manual && prev.kind === order.kind && dist(prev.a, order.a) < 30
    && (prev.b === null) === (order.b === null) && (!prev.b || !order.b || dist(prev.b, order.b) < 30);
  s.order = order;
  const hq = world.hqPos(f.id);
  // 2.1: the player's order is binding — it ends a recall of this front (the capital's own guards stay).
  if (order.manual) releaseRecall(f, s);
  if (order.kind === 'auto') {
    s.line = null;
    s.manualTarget = false;
    s.lastRetarget = -999;
    s.opLocked = false;
    if (s.posture === 'hold' || s.posture === 'fortify') setPosture(world, s, 'cautious');
    return;
  }
  const a = order.a;
  const b = order.b ?? (() => {
    const along = headingTo(hq, a) + Math.PI / 2;
    return { x: a.x + Math.cos(along) * ORDER_LINE_M, z: a.z + Math.sin(along) * ORDER_LINE_M };
  })();
  const a0 = order.b ? a : { x: 2 * a.x - b.x, z: 2 * a.z - b.z };
  const centre = order.b ? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : a;
  s.line = order.kind === 'attack' && !order.b ? null : { a: a0, b };
  s.manualTarget = order.manual;
  s.targetPos = { ...centre };
  const obj = world.objectives.find((o) => dist(o.pos, centre) < Math.max(40, o.radius));
  s.targetObjective = obj?.id ?? null;
  s.name = obj?.id ?? s.name;
  // An enemy capital inside the order is a city assault (the finisher / siege logic keys on targetCity).
  s.targetCity = null;
  for (const e of world.factions) if (e.alive && world.isHostile(f.id, e.id) && dist(world.hqPos(e.id), centre) < 60) s.targetCity = e.id;
  s.lastRetarget = world.time;
  const exit = world.cityOf(f.id).exit;
  const attack = order.kind === 'attack';
  if (order.manual) {
    s.rally = lerpV(exit, centre, attack ? 0.4 : 0.9);
    s.reason = `reason.order.${order.kind}`;
    s.reasonParams = { point: s.targetObjective ?? '' };
    if (!repeat) {
      setPosture(world, s, attack ? 'cautious' : order.kind === 'fortify' ? 'fortify' : 'hold');
      if (s.opPhase !== '') resetOperation(s, frontUnits(world, f.id, s.id), world);
    }
  } else {
    // 1.x retarget rally points (lab-tuned): halfway to a capital, a third of the way to a place.
    s.rally = lerpV(exit, centre, attack ? (s.targetCity !== null ? 0.5 : 0.35) : 0.9);
    setGoalReason(s);
    if (!attack) {
      setPosture(world, s, order.kind === 'fortify' ? 'fortify' : 'hold');
      if (s.opPhase !== '') resetOperation(s, frontUnits(world, f.id, s.id), world);
    } else if (s.posture === 'hold' || s.posture === 'fortify') setPosture(world, s, 'cautious');
  }
  if (order.kind === 'fortify' && s.line) addZone(world, f, s);
  if (order.kind === 'fallBack') {
    // Everyone drops what they are doing and marches back to the new line before fighting again
    // (behavior.fallingBack keeps them marching until they reach it). 2.1: on the player's order
    // town garrisons come back too (only the capital's guards stay).
    for (const u of frontUnits(world, f.id, s.id)) {
      if (u.manual || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
      u.spearhead = null;
      if (u.opRole !== 'garrison' || (order.manual && !capitalGuard(u))) { u.opRole = 'line'; u.opTarget = null; u.opObjective = null; }
      u.behavior = 'advance';
    }
  }
  if (boundOrder(s)) recallDetachments(s, frontUnits(world, f.id, s.id));
}

/** A home guard of the capital (standing garrison, HQ point): exempt from binding orders (user rule 8). */
const capitalGuard = (u: Unit): boolean => u.opRole === 'garrison' && !!u.opObjective?.startsWith('hq:');

/**
 * 2.1 binding orders (COMMAND_V2 §3): the front's detachments come back — town garrisons,
 * occupations, raids and rear guards; on a line order also manoeuvre / siege parties and
 * spearheads, and nobody waits at the rally point. The capital's guards stay (user rule 8).
 */
export function recallDetachments(s: Front, units: readonly Unit[]): void {
  const line = boundLine(s);
  for (const u of units) {
    if (u.manual || u.def.id === 'supply_truck' || isCommander(u.def) || capitalGuard(u)) continue;
    const r = u.opRole;
    if (r === 'garrison' || r === 'occupy' || r === 'raid' || r === 'rearguard' || (line && (r === 'maneuver' || r === 'infiltrate' || r === 'siege'))) {
      u.opRole = 'line';
      u.opTarget = null;
      u.opObjective = null;
    }
    if (line) {
      u.spearhead = null;
      if (u.behavior === 'rally') u.behavior = 'advance';
    }
  }
}

/** Match radius for "the same line again" (a re-issued Fortify order binds the existing zone). */
const ZONE_SAME_M = 40;
/** Shortest line that counts as a zone (works are laid every ~55 m). */
const ZONE_MIN_M = 60;

/**
 * Register the front's ordered line as a permanent fortified-zone project (2.1). A line already
 * registered is re-bound to this front instead of duplicated; other zones of the faction are
 * untouched, so a new Fortify order never cancels an earlier one.
 */
export function addZone(world: World, f: Faction, s: Front): Zone | null {
  if (!s.line) return null;
  const { a, b } = s.line;
  // A zone needs a real line to lay works along (a point order resolved on the capital gave a == b).
  if (dist(a, b) < ZONE_MIN_M) return null;
  const same = f.zones.find((z) => !z.cancelled && ((dist(z.a, a) < ZONE_SAME_M && dist(z.b, b) < ZONE_SAME_M) || (dist(z.a, b) < ZONE_SAME_M && dist(z.b, a) < ZONE_SAME_M)));
  if (same) {
    same.frontId = s.id;
    return same;
  }
  const z: Zone = { id: f.zoneSeq++, a: { ...a }, b: { ...b }, frontId: s.id, createdAt: world.time, cancelled: false };
  f.zones = [...f.zones, z];
  world.note(f.id, 'log.zonePlanned', { point: s.name }, 'info');
  return z;
}

function setPosture(world: World, s: Front, p: Front['posture']): void {
  if (s.posture === p) return;
  s.posture = p;
  s.postureSince = world.time;
}

/**
 * Round 7 (challenge lab): `cityai.thinkCity` sets postures for AI factions only, so a player front
 * on an `attack` order stayed 'cautious' for good and a front-order rush never stormed. Its
 * commander now applies the same rule: assault when the army is eager (aggression ≥ assaultAll),
 * when it is the main effort and eager or strong (> assaultAt), or when it outweighs the known
 * defence at the objective by `localRatio`; else cautious. A posture stands ≥ `holdS`.
 */
export const ORDER_ASSAULT = { localRatio: 1.5, targetR: 220, assaultAt: 900, holdS: 45 } as const;

function orderedAssault(world: World, f: Faction, s: Front, units: Unit[]): void {
  if (s.order.kind !== 'attack' || defendingHome(s) || world.time - s.postureSince < ORDER_ASSAULT.holdS) return;
  const own = world.objectives.find((o) => o.id === s.targetObjective);
  const attacking = s.targetCity !== null || !own || own.owner !== f.id;
  const mine = strengthOf(units);
  const theirs = knownEnemyStrength(world, f.id, s.targetPos, ORDER_ASSAULT.targetR);
  const aggr = eagerOn() ? f.command.aggression : 0;
  const strong = mine > ORDER_ASSAULT.assaultAt * (world.data.rules.proposed_defaults.army_scale ?? 1);
  const main = s.id === f.mainFront && (aggr >= EAGER.assaultMain || strong);
  const assault = attacking && (aggr >= EAGER.assaultAll || main || mine >= ORDER_ASSAULT.localRatio * (theirs + 1));
  setPosture(world, s, assault ? 'assault' : 'cautious');
}

/** Does the standing order fix this front's objective (the commander may not retarget on its own)? */
export const orderedTarget = (s: Front): boolean => s.order.kind !== 'auto';

// ---------------------------------------------------------------- front commanders

/** Front commander placement (COMMAND_V2 §4). */
export const COMMANDER = {
  /** No own place near the line: the commander follows the front this far behind its line … */
  behindM: 260,
  /** … on ground at least this far from enemy-held cells (frontai.safeRear). */
  safeM: 200,
} as const;

/**
 * Commander post: the nearest own, uncontested settlement (town / city preferred) within
 * `commander_post_radius_m` of the front's line (a contested place is a capture-ring fight the
 * commander keeps out of). A front that advanced beyond our towns is followed: the post is
 * `COMMANDER.behindM` behind its line on safe own ground; a front at home posts at the capital exit.
 */
export function commanderPost(world: World, f: Faction, s: Front): V2 {
  const r = world.data.rules.command.commander_post_radius_m;
  const anchor = s.line ? { x: (s.line.a.x + s.line.b.x) / 2, z: (s.line.a.z + s.line.b.z) / 2 } : s.front;
  let best: V2 | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.kind === 'point' || o.contested) continue;
    const d = dist(o.pos, anchor) * (o.kind === 'village' ? 1.3 : 1);
    if (d < bd && d < r) { bd = d; best = o.pos; }
  }
  if (best) return best;
  const home = world.hqPos(f.id);
  const d = dist(anchor, home);
  if (d < COMMANDER.behindM * 2) return world.cityOf(f.id).exit;
  return safeRear(world, f.id, lerpV(anchor, home, COMMANDER.behindM / d), home, COMMANDER.safeM);
}

/** Spawn a front commander at the capital exit (free of charge at the start, P-paid later). */
export function appointCommander(world: World, f: Faction, s: Front): void {
  const id = world.data.rules.command.commander_unit;
  if (!world.data.units.has(id)) return;
  const exit = world.cityOf(f.id).exit;
  const spread = ((s.id * 2654435761) % 1000) / 1000 - 0.5;
  const nav = world.nav(false, 35);
  const p = nav.nearestPassable({ x: exit.x + spread * 30, z: exit.z + spread * 20 }, 40) ?? exit;
  const u = world.spawnUnit(f.id, id, p, s.id);
  u.behavior = 'advance';
  u.opRole = 'line';
  s.commanderId = u.id;
  s.commanderLostAt = -1;
}

/**
 * Every front think: note a lost commander (the front holds for `commander_lost_hold_seconds`),
 * and appoint a replacement after `commander_respawn_seconds` if the faction can pay for one.
 */
export function upkeepCommander(world: World, f: Faction, s: Front): void {
  const rules = world.data.rules.command;
  const alive = world.unitAlive(s.commanderId);
  if (alive) return;
  if (s.commanderId !== null) {
    s.commanderId = null;
    s.commanderLostAt = world.time;
    world.note(f.id, 'log.commanderLost', { point: s.name }, 'alert');
  }
  if (s.commanderLostAt >= 0 && world.time - s.commanderLostAt < rules.commander_respawn_seconds) return;
  const def = world.data.units.get(rules.commander_unit);
  if (!def || f.p < def.costP) return;
  f.p -= def.costP;
  appointCommander(world, f, s);
  world.note(f.id, 'log.commanderAppointed', { point: s.name }, 'info');
}

/** A front without its commander fights on, but holds its ground until the replacement arrives. */
export const leaderless = (world: World, s: Front): boolean =>
  s.commanderId === null && s.commanderLostAt >= 0 && world.time - s.commanderLostAt < world.data.rules.command.commander_lost_hold_seconds;

export const lerpV = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

function knownEnemyStrength(world: World, f: number, at: V2, r: number): number {
  let s = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp > 0 && world.isHostile(f, u.owner) && world.knows(f, u) && !isCommander(u.def)) s += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
  }
  return s;
}

/** Like knownEnemyStrength, but routed / pinned enemies weigh less (adaptive layer: exploit routs). */
function fightingEnemyStrength(world: World, f: number, at: V2, r: number): number {
  let s = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp <= 0 || !world.isHostile(f, u.owner) || !world.knows(f, u)) continue;
    const broken = u.routing || u.moraleState === 'pinned';
    s += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp)) * (broken ? ADAPT.brokenEnemyWeight : 1);
  }
  return s;
}

/** Reason text describing the front's current goal (not a temporary gate). */
function setGoalReason(s: Front): void {
  // The player's orders are shown as such; the AI supreme HQ's attack orders read like 1.x goals.
  if (orderedTarget(s) && (s.order.manual || s.order.kind !== 'attack')) {
    s.reason = `reason.order.${s.order.kind}`;
    s.reasonParams = { point: s.targetObjective ?? '' };
  } else if (s.targetCity !== null) {
    s.reason = 'reason.assaultCity';
    s.reasonParams = { city: s.targetCity };
  } else {
    s.reason = 'reason.capturePoint';
    s.reasonParams = { point: s.targetObjective ?? '' };
  }
}

export function frontUnits(world: World, f: number, frontId: number): Unit[] {
  const out: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f && u.frontId === frontId && u.hp > 0 && !u.fixed) out.push(u);
  return out;
}

function strengthOf(units: Unit[]): number {
  return units.reduce((s, u) => s + (isCommander(u.def) ? 0 : (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp)), 0);
}

/** Next objective for a front once its own is secured: closest not-owned point, else weakest enemy city. */
export function nextTarget(world: World, f: Faction, s: Front): { pos: V2; obj: Objective | null; city: number | null } {
  const from = s.targetPos;
  // Round 2 decisive offensive: every group goes for the chosen enemy capital (command.ts chooseFinishTarget).
  const fin = eagerOn() ? f.command.finishTarget : -1;
  if (fin >= 0) return { pos: world.hqPos(fin), obj: null, city: fin };
  const own = world.objectives.find((o) => o.id === s.targetObjective);
  if (own && own.owner !== f.id) return { pos: own.pos, obj: own, city: null };
  // Score open objectives: near our current front, weakly held, not already another group's target,
  // and penalise ones behind a river (crossings are costly).
  const mine = strengthOf(frontUnits(world, f.id, s.id)) + 1;
  const taken = new Set(f.fronts.filter((x) => x.id !== s.id).map((x) => x.targetObjective ?? (x.targetCity !== null ? `hq:${x.targetCity}` : null)));
  let best: Objective | null = null;
  let bestScore = -Infinity;
  for (const o of world.objectives) {
    if (o.owner === f.id) continue;
    const d = dist(o.pos, from);
    const enemy = knownEnemyStrength(world, f.id, o.pos, 260);
    const water = crossings(world).some((c) => c.kind !== 'pass' && dist(c.pos, from) + dist(c.pos, o.pos) < d * 1.25);
    // Round 2: mountain passes too (ops through a pass: 13–36 % success vs 64–80 % in the open).
    const pass = eagerOn() && crossings(world).some((c) => c.kind === 'pass' && dist(c.pos, from) + dist(c.pos, o.pos) < d * 1.2 + 40);
    // High command: valuable, winnable settlements pull the army groups (0 … 0.6, more when territory is needed).
    const hcBias = (f.command.attackBias[o.id] ?? 0) * (eagerOn() ? 0.6 + 0.4 * f.command.need : 0.6);
    const score = 1 + hcBias + (o.owner >= 0 ? 0.3 : 0) - d / 1400 - (enemy / mine) * 0.8 - (water ? 0.25 : 0) - (pass ? EAGER.passPenalty : 0) - (taken.has(o.id) ? 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  // Capitals are the only way to win (no resolve): a reachable, weakly held enemy capital
  // competes with towns, and wins when the group clearly outweighs its defenders.
  let bestCity: number | null = null;
  for (const e of world.factions) {
    if (!e.alive || !world.isHostile(f.id, e.id)) continue;
    const hq = world.hqPos(e.id);
    const d = dist(hq, from);
    const enemy = knownEnemyStrength(world, f.id, hq, 320);
    const score = 1.0 - d / 1400 - (enemy / mine) * 0.8 - (taken.has(`hq:${e.id}`) ? 0.6 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestCity = e.id;
    }
  }
  if (bestCity !== null && bestScore > -0.6) return { pos: world.hqPos(bestCity), obj: null, city: bestCity };
  if (best && bestScore > -0.6) return { pos: best.pos, obj: best, city: null };
  const enemies = world.factions.filter((e) => e.alive && world.isHostile(f.id, e.id));
  if (enemies.length === 0) return { pos: from, obj: own ?? null, city: null };
  enemies.sort((a, b) => dist(world.hqPos(a.id), from) * (0.5 + a.resolve / 900) - dist(world.hqPos(b.id), from) * (0.5 + b.resolve / 900));
  return { pos: world.hqPos(enemies[0].id), obj: null, city: enemies[0].id };
}

/** Round 2 decisive offensive: a front not yet on the finish target retargets now (unless mid-assault). */
export const finishNow = (f: Faction, s: Front): boolean =>
  eagerOn() && f.command.finishTarget >= 0 && s.targetCity !== f.command.finishTarget && s.opPhase !== 'assault';

/** Living, mobile units of every front, by front id (one pass over the units). */
export function frontGroups(world: World, f: Faction): Map<number, Unit[]> {
  const out = new Map<number, Unit[]>(f.fronts.map((s) => [s.id, []]));
  for (const u of world.units.values()) if (u.owner === f.id && u.hp > 0 && !u.fixed) out.get(u.frontId)?.push(u);
  return out;
}

/** Front planner (2 s): target choice, gather/advance gate, city-defence override. */
export function thinkFronts(world: World, f: Faction): void {
  const hq = world.hqPos(f.id);
  // Round 3: graded recall decided by the high command (homeguard.ts); else the old all-or-nothing rule.
  const graded = homeOn();
  const threat = graded ? 0 : knownEnemyStrength(world, f.id, hq, 280);
  const ht = f.command.homeThreat;
  // Each group owns a stretch of the front so the whole line is held, not one point.
  const segs = frontSegments(world, f, world.frontInfo[f.id]?.cells ?? []);
  f.fronts.forEach((s, i) => (s.segment = segs[i] ?? []));
  planOperations(world, f);
  const groups = frontGroups(world, f);
  planPincer(world, f, groups);
  for (const s of f.fronts) {
    const units = groups.get(s.id) ?? [];
    upkeepCommander(world, f, s);
    const recalled = graded ? isRecalled(f, s) : threat > 300 && !s.manualTarget;
    if (graded && !recalled && defendingHome(s)) {
      // Threat passed: the group gets its previous orders back.
      if (restoreOrders(s)) setGoalReason(s);
      else s.lastRetarget = -999;
    }
    if (recalled) {
      if (graded) saveOrders(s);
      s.targetPos = { ...hq };
      s.targetObjective = null;
      s.targetCity = null;
      s.reason = graded ? 'reason.homeDefence' : 'reason.defendCity';
      s.reasonParams = graded ? { enemy: Math.round(ht.enemy), mine: Math.round(ht.garrison + ht.committed), eta: Math.max(0, Math.round(ht.eta)) } : {};
      s.advancing = true;
      s.rally = lerpV(hq, world.cityOf(f.id).exit, 1.5);
      for (const u of units) if (u.behavior === 'rally') u.behavior = 'advance';
      if (s.opPhase !== '' || units.some((u) => u.opRole === 'maneuver' || u.opRole === 'siege' || u.opRole === 'infiltrate')) resetOperation(s, units, world);
      planFront(world, f, s, units, true);
      continue;
    }
    // Strategy changes slowly: a front keeps its objective at least 60 s (user: AI was too fast).
    // (an assault already under way on a nearby place is finished first). 2.0: only a front on an
    // `auto` order picks its own objective; the AI supreme HQ re-issues attack orders (theatre.ts).
    if (!orderedTarget(s) && (deadCapital(world, s) || (!maneuvering(s) && (world.time - s.lastRetarget > 60 || finishNow(f, s))))) {
      const t = nextTarget(world, f, s);
      if (dist(t.pos, s.targetPos) > 1 || defendingHome(s)) {
        s.targetPos = { ...t.pos };
        s.targetObjective = t.obj?.id ?? null;
        s.targetCity = t.city;
        s.lastRetarget = world.time;
        setGoalReason(s);
        s.rally = lerpV(world.cityOf(f.id).exit, s.targetPos, t.city !== null ? 0.5 : 0.35);
      }
    }
    // Round 7: the player's attack orders get the AI's cautious ⇄ assault rule (cityai never runs for players).
    if (f.isPlayer && ROUND7_AB.assault) orderedAssault(world, f, s, units);
    // 2.1 binding orders: detachments come back; a line order is held frontally (no manoeuvre ops).
    const bound = boundOrder(s);
    if (bound) recallDetachments(s, units);
    // Battle doctrine for this group's attack (flank, pincer, infiltration, siege …).
    if (bound && boundLine(s)) holdOperation(world, s, units);
    else runOperation(world, f, s, units);
    // Losing badly near target → pause the push (avoid suicidal trickle). Count the whole front,
    // including units waiting at the rally point, so the gate cannot deadlock.
    const mine = strengthOf(units);
    const theirs = knownEnemyStrength(world, f.id, s.targetPos, 220);
    // A front that has just lost its commander holds its ground until the replacement arrives.
    // 2.1: a binding attack order goes regardless (only the massing wait and river staging remain).
    const outmatched = !bound && ((theirs > mine * 1.6 && s.posture !== 'assault') || leaderless(world, s));
    const gatherAtRally = units.filter((u) => u.behavior === 'rally' && dist(u.pos, s.rally) < 60);
    const inf = gatherAtRally.filter((u) => u.def.kind === 'infantry').length;
    if (gatherAtRally.length > 0 && s.gatheredSince < 0) s.gatheredSince = world.time;
    const waited = s.gatheredSince >= 0 && world.time - s.gatheredSince > AI.rallyMaxWait;
    const scale = world.data.rules.proposed_defaults.army_scale ?? 1;
    const needInf = Math.max(AI.rallyMinInfantry, Math.round(AI.rallyMinInfantry * scale * 0.6));
    const release = ((inf >= needInf || waited) && !outmatched && s.posture !== 'withdraw') || boundLine(s);
    if (release) {
      for (const u of gatherAtRally) u.behavior = 'advance';
      s.gatheredSince = -1;
    } else if (gatherAtRally.length > 0) {
      s.reason = outmatched ? 'reason.outmatched' : 'reason.waitGroup';
      s.reasonParams = { n: inf, need: needInf };
    }
    if ((release || gatherAtRally.length === 0) && (s.reason === 'reason.waitGroup' || s.reason === 'reason.outmatched')) setGoalReason(s);
    s.advancing = release;
    planFront(world, f, s, units, outmatched);
    if (bound) orderReason(s);
  }
}

/** 2.1: a line order is held frontally — no flank / pincer / infiltration / siege on a defend / fortify / fall-back order. */
function holdOperation(world: World, s: Front, units: Unit[]): void {
  if (s.opPhase !== '' || s.op !== 'frontal') resetOperation(s, units, world);
  if (!s.opLocked) s.op = 'frontal';
  s.opPhase = '';
  s.opRoute = [];
}

/** Commander tactics reasons that read as obeying the order (a push on an attack order, a hold on a line order). */
const ORDER_REASONS = new Set(['reason.pushFront', 'reason.holdFront', 'reason.holdRiver', 'reason.holdHigh', 'reason.holdLine', 'reason.capturePoint', 'reason.assaultCity', 'reason.outmatched']);

/** 2.1: a front on a binding order shows the order (the player sees obedience), except a river staging / massing wait. */
function orderReason(s: Front): void {
  if (defendingHome(s) || !ORDER_REASONS.has(s.reason)) return;
  s.reason = `reason.order.${s.order.kind}`;
  s.reasonParams = { point: s.targetObjective ?? '' };
}

/**
 * Terrain-aware battle line for one group: defend on high ground / behind a river when
 * holding or outmatched; when attacking across a river, stage before the crossing until the
 * group has massed, then push through. Units get formation slots on the line.
 */
function planFront(world: World, f: Faction, s: Front, units: Unit[], defensive: boolean): void {
  const centroid = units.length > 0
    ? { x: units.reduce((a, u) => a + u.pos.x, 0) / units.length, z: units.reduce((a, u) => a + u.pos.z, 0) / units.length }
    : world.cityOf(f.id).exit;
  const threat = threatCentre(world, f.id, s.targetPos, 600) ?? s.targetPos;
  const holding = defensive || s.posture === 'hold' || s.posture === 'fortify' || defendingHome(s);
  let front = s.targetPos;
  let facing = headingTo(centroid, s.targetPos);
  // After first contact the group fights along the real battle front (from the control map).
  const anchor = defendingHome(s) ? null : frontAnchor(world, f.id, s.targetPos);
  const contact = !!anchor && s.posture !== 'withdraw';
  if (anchor && s.posture !== 'withdraw') {
    const home = world.hqPos(f.id);
    const near = units.filter((u) => dist(u.pos, anchor) < 450 && !u.spearhead);
    const mine = strengthOf(near) + 1;
    const theirs = adaptive() ? fightingEnemyStrength(world, f.id, anchor, 380) : knownEnemyStrength(world, f.id, anchor, 380);
    const ratio = mine / (theirs + 1);
    const toTarget = headingTo(anchor, s.targetPos);
    const wantsPush = !defensive && s.posture !== 'hold' && s.posture !== 'fortify';
    const aggr = eagerOn() ? f.command.aggression : 0;
    let pushing = wantsPush && ratio > (s.posture === 'assault' ? 1.0 : adaptive() ? ADAPT.pushRatio - EAGER.pushAggressionCut * aggr : 1.4);
    if (eagerOn()) pushing = eagerPush(world, f, s, units, anchor, ratio, (strengthOf(units) + 1) / (theirs + 1), wantsPush, pushing);
    // Round 4: a capital storm pushes whatever the local ratio at the anchor (the defenders mass
    // there; the storm was launched on the mass at the capital vs its forecast defence, storm.ts).
    if (capitalSiege(s) && s.op === 'siege' && s.opPhase === 'assault' && !defensive) pushing = true;
    // 2.1: a binding attack order pushes (eagerPush keeps only a short massing wait).
    if (boundOrder(s) && s.order.kind === 'attack' && !defensive && !eagerOn()) pushing = true;
    if (pushing) {
      // Push the line forward toward the objective in bounded steps.
      const d = Math.min(110, dist(anchor, s.targetPos));
      front = { x: anchor.x + Math.cos(toTarget) * d, z: anchor.z + Math.sin(toTarget) * d };
      facing = toTarget;
      s.mode = 'push';
      s.reason = 'reason.pushFront';
      s.reasonParams = { point: s.targetObjective ?? '' };
    } else {
      // Hold just behind the line on the best local ground, facing the enemy.
      const hd = headingTo(anchor, home);
      const back = { x: anchor.x + Math.cos(hd) * 35, z: anchor.z + Math.sin(hd) * 35 };
      const foe = threatCentre(world, f.id, anchor, 450) ?? { x: anchor.x + Math.cos(toTarget) * 150, z: anchor.z + Math.sin(toTarget) * 150 };
      const dp = defensivePosition(world, back, foe, 110);
      front = dp.pos;
      facing = headingTo(front, foe);
      s.mode = 'hold';
      const feat = nearestFeature(world, front, 500);
      s.reason = dp.river ? 'reason.holdRiver' : dp.height > 6 ? 'reason.holdHigh' : 'reason.holdFront';
      s.reasonParams = { feature: feat ? (world.map.features ?? []).indexOf(feat) : -1, point: s.targetObjective ?? '' };
      const m = eager.get(s);
      if (m && m.massSince >= 0) {
        s.reason = 'reason.waitGroup';
        s.reasonParams = { n: m.massed, need: m.massNeed };
      }
    }
    // Round 2 decisive offensive: spearheads toward the enemy capital go at a lower local edge and more often.
    const finishing = eagerOn() && f.command.finishTarget >= 0 && s.targetCity === f.command.finishTarget;
    // Round 4: no trickle of spearheads while a capital siege masses / digs (storm.ts).
    const massing = capitalSiege(s) && s.op === 'siege' && (s.opPhase === 'form' || s.opPhase === 'dig');
    const armoured = mobileFresh(units) >= EAGER.armorSpearMobile;
    const spearRatio = finishing ? Math.min(EAGER.finishSpearRatio, armoured ? EAGER.armorSpearRatio : Infinity) : armoured ? EAGER.armorSpearRatio : EAGER.spearRatio;
    const spearEvery = finishing ? 60 : armoured ? EAGER.armorSpearEveryS : EAGER.spearEveryS;
    if (!defensive && !massing && !boundLine(s) && ratio > spearRatio && world.time - s.lastSpearhead > spearEvery) launchSpearhead(world, f, s, units, anchor);
    s.crossing = null;
  } else if (holding) {
    // Anchor near the objective (or the city) on the best defensive ground facing the threat.
    const anchor = defendingHome(s) ? world.hqPos(f.id) : s.targetObjective && world.objectives.find((o) => o.id === s.targetObjective)?.owner === f.id ? s.targetPos : lerpV(centroid, s.targetPos, 0.5);
    const dp = defensivePosition(world, anchor, threat, 220);
    front = dp.pos;
    facing = headingTo(front, threat);
    if (!defendingHome(s) && s.reason !== 'reason.waitGroup' && s.reason !== 'reason.outmatched') {
      const feat = nearestFeature(world, front, 500);
      const fi = feat ? (world.map.features ?? []).indexOf(feat) : -1;
      s.reason = dp.river ? 'reason.holdRiver' : dp.height > 6 ? 'reason.holdHigh' : 'reason.holdLine';
      s.reasonParams = { feature: fi, point: s.targetObjective ?? '' };
    }
    s.crossing = null;
  } else if (s.posture !== 'withdraw') {
    const exit = world.cityOf(f.id).exit;
    const key = `${Math.round(s.targetPos.x)},${Math.round(s.targetPos.z)}`;
    if (!s.crossing || s.crossing.key !== key) {
      const fc = dist(centroid, s.targetPos) > 250 ? firstCrossing(world, dist(centroid, exit) < 400 ? exit : centroid, s.targetPos) : null;
      s.crossing = fc ? { pos: fc.crossing.pos, kind: fc.crossing.kind, staging: fc.staging, key } : null;
      s.stagedSince = -1;
    }
    const c = s.crossing;
    if (c) {
      const beforeCrossing = dist(centroid, s.targetPos) > dist(c.pos, s.targetPos) + 40;
      const massed = units.filter((u) => dist(u.pos, c.staging) < 160).length >= Math.max(3, units.length * 0.6);
      if (beforeCrossing && !massed && (s.stagedSince < 0 || world.time - s.stagedSince < 90)) {
        if (s.stagedSince < 0) s.stagedSince = world.time;
        front = c.staging;
        facing = headingTo(c.staging, c.pos);
        const feat = nearestFeature(world, c.pos, 300);
        s.reason = 'reason.crossAt';
        s.reasonParams = { feature: feat ? (world.map.features ?? []).indexOf(feat) : -1, kind: c.kind };
      } else {
        if (s.reason === 'reason.crossAt') setGoalReason(s);
        if (!beforeCrossing) s.crossing = null;
      }
    }
  }
  // Engineering: does the route to the objective need a bridge? (checked every 20 s)
  if (world.time >= s.bridgeCheckAt) {
    s.bridgeCheckAt = world.time + 20;
    s.bridgeSite = s.posture === 'withdraw' || holding ? null : bridgeSiteFor(world, s, centroid);
  }
  // Hysteresis: small drifts of the line keep the old anchor so units don't constantly re-path.
  const moved = dist(front, s.front) > 40 || Math.abs(angleDiff(facing, s.facing)) > 20 * DEG;
  if (moved) {
    s.front = front;
    s.facing = facing;
  }
  front = s.front;
  facing = s.facing;
  // Formation slots by rank (front-line troops, AT/MG line behind, support further back).
  const liners = units.filter((u) => u.behavior === 'advance' && !u.manual && !u.spearhead && u.opRole === 'line' && !['howitzer', 'mortar', 'supply_truck', 'recon', 'commander'].includes(u.def.id))
    .sort((a, b) => unitDepthRank(a) - unitDepthRank(b) || a.id - b.id);
  const byRank = new Map<number, Unit[]>();
  for (const u of liners) {
    const r = unitDepthRank(u);
    const arr = byRank.get(r) ?? [];
    arr.push(u);
    byRank.set(r, arr);
  }
  const slots: Record<number, V2> = {};
  // Round 2: in contact, only the stretches of the segment with known enemies near get the screen.
  // 2.0: a line order (defend / fortify / fall back) is held along the ordered line itself.
  const ordered = s.line && s.order.kind !== 'attack' && !defendingHome(s);
  if (ordered && s.line) {
    s.front = { x: (s.line.a.x + s.line.b.x) / 2, z: (s.line.a.z + s.line.b.z) / 2 };
    s.facing = headingTo(world.hqPos(f.id), s.front);
    front = s.front;
    facing = s.facing;
  }
  // An attack along a line keeps the line's shape and pushes it with the battle front (s.front).
  const attackLine = !!s.line && s.order.kind === 'attack' && !defendingHome(s);
  const seg = ordered && s.line ? terrainLine(world, s, s.line, facing)
    : attackLine && s.line ? lineThrough(s.line, s.front)
      : eagerOn() && contact ? activeSegment(world, f.id, s.segment) : s.segment;
  const home = world.hqPos(f.id);
  // Spacing doctrine: spread wider once enemy shells land among the group.
  const spacing = world.time - s.shelledAt < OPS.shelledMemorySeconds ? OPS.shelledSpacing : OPS.minSpacing;
  const segLen = seg.length * FRONTLINE.cell;
  const sieging = s.op === 'siege' && (s.opPhase === 'form' || s.opPhase === 'dig') && !defendingHome(s);
  // Round 4: in the storm of a capital the whole line closes on the HQ (it crept with the front, 0.75–0.9 km out).
  const storming = capitalSiege(s) && s.op === 'siege' && s.opPhase === 'assault' && !defendingHome(s);
  const ringN = Math.max(5, Math.min(24, Math.ceil(liners.length / 2)));
  const siegeSlots = sieging ? siegeRing(world, f.id, s, ringN) : storming ? stormRing(world, f.id, s, ringN) : null;
  // Round 2 Schwerpunkt: in contact, a share of the line masses on the axis toward the target
  // (the rest screens the segment) instead of the whole group thinning out along the front.
  const massShare = (eagerOn() && contact || attackLine) && !ordered && !siegeSlots && seg.length > 0 && !defendingHome(s)
    ? EAGER.massShare + EAGER.massShareAggr * f.command.aggression : 0;
  for (const [rank, all] of byRank) {
    let arr = all;
    if (massShare > 0) {
      const mass = all.filter((u) => inMass(u, massShare));
      mass.forEach((u, j) => {
        const p = massSlot(front, facing, j, mass.length, rank, spacing);
        slots[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
      });
      arr = all.filter((u) => !inMass(u, massShare));
    }
    // Round 2: screen slots in the units' own order along the segment (they were assigned by id, so
    // a unit's slot could be across the front: 0.3 % of line units stood at their slot, 30 % > 500 m off).
    if (eagerOn() && !siegeSlots && seg.length > 0 && !defendingHome(s)) arr = orderAlong(arr, seg);
    // Along the whole front segment when in contact; otherwise a compact line at the objective.
    const perRow = seg.length > 0 ? Math.max(1, Math.floor(segLen / spacing)) : arr.length;
    arr.forEach((u, i) => {
      let p: V2;
      if (siegeSlots) {
        // Siege: dig in along the ring outside the defenders' direct-fire range.
        const row = Math.floor(i / siegeSlots.length);
        const base = siegeSlots[i % siegeSlots.length];
        const hd = headingTo(s.targetPos, base);
        p = { x: base.x + Math.cos(hd) * (row + rank) * 28, z: base.z + Math.sin(hd) * (row + rank) * 28 };
      } else if (seg.length > 0 && !defendingHome(s)) {
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, arr.length - row * perRow);
        const base = spreadAlong(seg, inRow)[i % perRow] ?? seg[0];
        // Pull back from the contact line (holding) or lean forward (pushing); extra rows further back.
        // An ordered line was snapped to terrain (terrainLine): stand on it, just behind the crest.
        const lean = ordered ? -LINE_ORDER.leanM : s.mode === 'push' ? 25 : eagerOn() ? -35 + EAGER.holdLeanAggr * f.command.aggression : -35;
        const back = lean - (row + rank) * 30;
        const hd = headingTo(home, base);
        p = { x: base.x + Math.cos(hd) * back, z: base.z + Math.sin(hd) * back };
      } else p = lineSlot(front, facing, i, arr.length, rank);
      slots[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
    });
  }
  // 2.1: on an ordered line, squads man the finished works along it first (structures.structureSlots).
  if (ordered && s.line) manWorks(world, f, s.line, liners, slots);
  s.slots = slots;
}

/**
 * 2.1 (works on the ordered line): free building slots and trench bays within `STRUCT.zoneSlotM` of
 * the line go to the nearest foot squads of the front (buildings first, as structureSlots orders
 * them); the rest keep their line slots. Squads already inside a building keep it. O(slots × squads).
 */
function manWorks(world: World, f: Faction, line: { a: V2; b: V2 }, liners: Unit[], slots: Record<number, V2>): void {
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
interface EagerState { holdSince: number; pushUntil: number; massSince: number; massed: number; massNeed: number }
const eager = new WeakMap<Front, EagerState>();

/**
 * Round 2 push decision on top of the ratio threshold:
 * - holding has a cost: after `holdPatienceS` in hold while the whole group outweighs the enemy at the
 *   anchor (groupRatio ≥ holdPushRatio)
 *   and with an army that wants to fight (aggression > 0), push; a started push stays committed
 *   for a while unless the local ratio collapses (< 0.8);
 * - frontal attacks mass first: hold near the anchor until `frontalMassShare` of the mass is within
 *   `massRadius` (or `massWaitS` passed) instead of trickling forward unit by unit.
 */
function eagerPush(world: World, f: Faction, s: Front, units: Unit[], anchor: V2, ratio: number, groupRatio: number, wantsPush: boolean, pushing: boolean): boolean {
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
  // 2.1: a binding attack order always pushes (after the short massing wait below).
  const ordered = boundOrder(s) && s.order.kind === 'attack';
  let push = ordered || pushing || (now < st.pushUntil && ratio >= 0.8);
  // Lab: in hold the local ratio at the anchor was < 1 in 90 % of samples while only 10–30 % of the
  // group stood within 450 m of it — the group was strong enough, just not there. Judge patience by
  // the whole group; the push (and frontal massing) brings the rest up.
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
 * Breakthrough: with decisive local superiority, detach a mobile group (tanks + fresh infantry)
 * to drive through the front and seize an enemy settlement behind it — or the enemy capital.
 */
const SPEAR_MOBILE = new Set(['light_tank', 'medium_tank', 'heavy_tank', 'motor_inf']);
const spearReady = (u: Unit): boolean => !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance' && u.hp > u.def.maxHp * 0.6;
/** Fresh tanks and motorized squads free for a thrust. */
function mobileFresh(units: Unit[]): number {
  let n = 0;
  for (const u of units) if (SPEAR_MOBILE.has(u.def.id) && spearReady(u)) n++;
  return n;
}

function launchSpearhead(world: World, f: Faction, s: Front, units: Unit[], anchor: V2): void {
  let target: string | null = null;
  let tpos: V2 | null = null;
  let best = Infinity;
  // Round 2 decisive offensive: break through toward the chosen enemy capital.
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
    // Armour and motorized rifles lead the thrust; then the nearest riflemen.
    .sort((a, b) => (SPEAR_MOBILE.has(b.def.id) ? 1 : 0) - (SPEAR_MOBILE.has(a.def.id) ? 1 : 0) || dist(a.pos, anchor) - dist(b.pos, anchor));
  const size = Math.max(4, Math.round(units.length * EAGER.spearShare));
  // Riflemen to take the objective: at least 3 foot squads ride with an armoured thrust.
  const head = pool.slice(0, size);
  const foot = pool.slice(size).filter((u) => u.def.kind === 'infantry').slice(0, Math.max(0, 3 - head.filter((u) => u.def.kind === 'infantry').length));
  const group = [...head, ...foot];
  if (group.filter((u) => u.def.kind === 'infantry').length < 2) return;
  for (const u of group) u.spearhead = target;
  s.lastSpearhead = world.time;
  s.mode = 'breakthrough';
  world.note(f.id, 'log.spearhead', { point: target.startsWith('hq:') ? '' : target, n: group.length }, 'info');
}
