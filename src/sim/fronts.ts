import { AI, FRONTLINE } from './config';
import { hostileMask } from './spatial';
import { crossings, defensivePosition, firstCrossing, lineSlot, nearestFeature, threatCentre, unitDepthRank } from './terrainai';
import { frontAnchor } from './frontai';
import { ADAPT, adaptive, EAGER, eagerOn } from './strategyai';
import { maneuvering, planPincer, resetOperation, runOperation, siegeRing } from './doctrine';
import { bridgeSiteFor } from './engineering';
import { frontSegments, OPS, spreadAlong, planOperations } from './operations';
import { defendingHome, homeOn, isRecalled, restoreOrders, saveOrders } from './homeguard';
import { capitalSiege, stormRing } from './storm';
import type { Faction, Objective, Front, Unit } from './types';
import { dist, headingTo, angleDiff, DEG, type V2 } from './vec';
import type { World } from './world';
import { isCommander } from './formulas';

/**
 * 2.0 command hierarchy (docs/COMMAND_V2.md). A faction's army is split into *fronts*, each led
 * by a front commander unit. The supreme HQ (the player, or the AI planner) gives a front one
 * order; the commander (this module + doctrine.ts) does the tactics: objective, posture, battle
 * plan, battle line and formation slots. Front ids are stable for the match; today a front's id
 * is also its index in `f.fronts` (use `frontById` so dynamic fronts can change that later).
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

export const frontById = (f: Faction, id: number): Front | undefined => f.fronts[id]?.id === id ? f.fronts[id] : f.fronts.find((s) => s.id === id);

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
 */
export function issueFrontOrder(world: World, f: Faction, s: Front, order: Front['order']): void {
  s.order = order;
  const hq = world.hqPos(f.id);
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
  s.manualTarget = true;
  s.targetPos = { ...centre };
  const obj = world.objectives.find((o) => dist(o.pos, centre) < Math.max(40, o.radius));
  s.targetObjective = obj?.id ?? null;
  s.name = obj?.id ?? s.name;
  // An enemy capital inside the order is a city assault (the finisher / siege logic keys on targetCity).
  s.targetCity = null;
  for (const e of world.factions) if (e.alive && world.isHostile(f.id, e.id) && dist(world.hqPos(e.id), centre) < 60) s.targetCity = e.id;
  s.lastRetarget = world.time;
  s.rally = lerpV(world.cityOf(f.id).exit, centre, order.kind === 'attack' ? 0.4 : 0.9);
  s.reason = `reason.order.${order.kind}`;
  s.reasonParams = { point: s.targetObjective ?? '' };
  setPosture(world, s, order.kind === 'attack' ? 'cautious' : order.kind === 'fortify' ? 'fortify' : 'hold');
  if (s.opPhase !== '') resetOperation(s, frontUnits(world, f.id, s.id), world);
  if (order.kind === 'fallBack') {
    // Everyone drops what they are doing and marches back to the new line before fighting again.
    for (const u of frontUnits(world, f.id, s.id)) {
      if (u.manual || u.def.id === 'supply_truck') continue;
      u.spearhead = null;
      if (u.opRole !== 'garrison') { u.opRole = 'line'; u.opTarget = null; u.opObjective = null; }
      u.behavior = 'advance';
    }
  }
}

function setPosture(world: World, s: Front, p: Front['posture']): void {
  if (s.posture === p) return;
  s.posture = p;
  s.postureSince = world.time;
}

/** Does the standing order fix this front's objective (the commander may not retarget on its own)? */
export const orderedTarget = (s: Front): boolean => s.order.kind !== 'auto';

// ---------------------------------------------------------------- front commanders

/** Nearest own settlement (town / city preferred) within `commander_post_radius_m` of the front, else the capital exit. */
export function commanderPost(world: World, f: Faction, s: Front): V2 {
  const r = world.data.rules.command.commander_post_radius_m;
  const anchor = s.line ? { x: (s.line.a.x + s.line.b.x) / 2, z: (s.line.a.z + s.line.b.z) / 2 } : s.front;
  let best: V2 | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.kind === 'point') continue;
    const d = dist(o.pos, anchor) * (o.kind === 'village' ? 1.3 : 1);
    if (d < bd && d < r) { bd = d; best = o.pos; }
  }
  return best ?? world.cityOf(f.id).exit;
}

/** Spawn a front commander at the capital exit (free of charge at the start, P-paid later). */
function appointCommander(world: World, f: Faction, s: Front): void {
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
  if (orderedTarget(s)) {
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
function nextTarget(world: World, f: Faction, s: Front): { pos: V2; obj: Objective | null; city: number | null } {
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
  const groups = f.fronts.map((s) => frontUnits(world, f.id, s.id));
  planPincer(world, f, groups);
  for (const s of f.fronts) {
    const units = groups[s.id] ?? frontUnits(world, f.id, s.id);
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
    // (an assault already under way on a nearby place is finished first)
    const finishNow = eagerOn() && f.command.finishTarget >= 0 && s.targetCity !== f.command.finishTarget && s.opPhase !== 'assault';
    if (!s.manualTarget && !maneuvering(s) && (world.time - s.lastRetarget > 60 || finishNow)) {
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
    // Battle doctrine for this group's attack (flank, pincer, infiltration, siege …).
    runOperation(world, f, s, units);
    // Losing badly near target → pause the push (avoid suicidal trickle). Count the whole front,
    // including units waiting at the rally point, so the gate cannot deadlock.
    const mine = strengthOf(units);
    const theirs = knownEnemyStrength(world, f.id, s.targetPos, 220);
    // A front that has just lost its commander holds its ground until the replacement arrives.
    const outmatched = (theirs > mine * 1.6 && s.posture !== 'assault') || leaderless(world, s);
    const gatherAtRally = units.filter((u) => u.behavior === 'rally' && dist(u.pos, s.rally) < 60);
    const inf = gatherAtRally.filter((u) => u.def.kind === 'infantry').length;
    if (gatherAtRally.length > 0 && s.gatheredSince < 0) s.gatheredSince = world.time;
    const waited = s.gatheredSince >= 0 && world.time - s.gatheredSince > AI.rallyMaxWait;
    const scale = world.data.rules.proposed_defaults.army_scale ?? 1;
    const needInf = Math.max(AI.rallyMinInfantry, Math.round(AI.rallyMinInfantry * scale * 0.6));
    const release = (inf >= needInf || waited) && !outmatched && s.posture !== 'withdraw';
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
  }
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
    if (!defensive && !massing && ratio > (finishing ? EAGER.finishSpearRatio : 2.2) && world.time - s.lastSpearhead > (finishing ? 60 : 120)) launchSpearhead(world, f, s, units, anchor);
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
  const seg = ordered && s.line ? lineCells(s.line, FRONTLINE.cell) : eagerOn() && contact ? activeSegment(world, f.id, s.segment) : s.segment;
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
  const massShare = eagerOn() && contact && !siegeSlots && seg.length > 0 && !defendingHome(s)
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
        const lean = s.mode === 'push' ? 25 : eagerOn() ? -35 + EAGER.holdLeanAggr * f.command.aggression : -35;
        const back = lean - (row + rank) * 30;
        const hd = headingTo(home, base);
        p = { x: base.x + Math.cos(hd) * back, z: base.z + Math.sin(hd) * back };
      } else p = lineSlot(front, facing, i, arr.length, rank);
      slots[u.id] = world.navFor(u).nearestPassable(p, 40) ?? p;
    });
  }
  s.slots = slots;
}

/** An ordered line sampled every `cell` metres (same shape as a front segment). */
function lineCells(line: { a: V2; b: V2 }, cell: number): V2[] {
  const n = Math.max(1, Math.round(dist(line.a, line.b) / cell));
  const out: V2[] = [];
  for (let k = 0; k <= n; k++) out.push(lerpV(line.a, line.b, k / n));
  return out;
}

/**
 * Round 2: the part of a front segment that faces known enemies (sampled ~16 points, one spatial
 * query each). Lab: 72 % of line units stood > 300 m from any enemy, spread along quiet front.
 */
function activeSegment(world: World, f: number, seg: V2[]): V2[] {
  if (seg.length < 8) return seg;
  const step = Math.max(1, Math.floor(seg.length / 16));
  const mask = hostileMask(world, f);
  const hot: boolean[] = [];
  let any = false;
  for (let k = 0; k < seg.length; k += step) {
    let h = false;
    for (const u of world.spatial.queryOwners(seg[k].x, seg[k].z, EAGER.activeRadius, mask)) {
      if (u.hp > 0 && world.knows(f, u)) { h = true; break; }
    }
    hot.push(h);
    any ||= h;
  }
  return any ? seg.filter((_, i) => hot[Math.floor(i / step)]) : seg;
}

/** Units sorted by the nearest (sampled) cell index of an angle-ordered segment (monotone slot matching). */
function orderAlong(units: Unit[], seg: V2[]): Unit[] {
  const step = Math.max(1, Math.ceil(seg.length / 64));
  const key = new Map<number, number>();
  for (const u of units) {
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < seg.length; k += step) {
      const d = (seg[k].x - u.pos.x) ** 2 + (seg[k].z - u.pos.z) ** 2;
      if (d < bd) { bd = d; bi = k; }
    }
    key.set(u.id, bi);
  }
  return [...units].sort((a, b) => (key.get(a.id) ?? 0) - (key.get(b.id) ?? 0) || a.id - b.id);
}

/** Stable mass membership by id hash (no per-think re-sorting, so slots don't churn). */
function inMass(u: Unit, share: number): boolean {
  return ((Math.imul(u.id, 2654435761) >>> 0) % 1000) < share * 1000;
}

/** Compact block on `centre` facing `facing`, spaced so the crowding shell penalty doesn't trigger. */
function massSlot(centre: V2, facing: number, i: number, n: number, rank: number, spacing: number): V2 {
  const perRow = Math.max(4, Math.min(16, Math.ceil(Math.sqrt(n * 4))));
  const row = Math.floor(i / perRow);
  const cols = Math.min(perRow, n - row * perRow);
  const col = (i % perRow) - (cols - 1) / 2 + (row % 2 === 1 ? 0.5 : 0);
  const back = (row + Math.max(0, rank)) * (spacing + 5);
  const fx = Math.cos(facing);
  const fz = Math.sin(facing);
  return { x: centre.x - fx * back - fz * col * spacing, z: centre.z - fz * back + fx * col * spacing };
}

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
  let push = pushing || (now < st.pushUntil && ratio >= 0.8);
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
    if (near < st.massNeed && now - st.massSince < EAGER.massWaitS) push = false;
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
    .filter((u) => !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance' && u.hp > u.def.maxHp * 0.6
      && (u.def.kind === 'vehicle' ? u.def.id !== 'supply_truck' : u.def.id === 'infantry' || u.def.id === 'engineer' || u.def.id === 'motor_inf'))
    .sort((a, b) => dist(a.pos, anchor) - dist(b.pos, anchor));
  const size = Math.max(4, Math.round(units.length * 0.3));
  const group = pool.slice(0, size);
  if (group.filter((u) => u.def.kind === 'infantry').length < 2) return;
  for (const u of group) u.spearhead = target;
  s.lastSpearhead = world.time;
  s.mode = 'breakthrough';
  world.note(f.id, 'log.spearhead', { point: target.startsWith('hq:') ? '' : target, n: group.length }, 'info');
}
