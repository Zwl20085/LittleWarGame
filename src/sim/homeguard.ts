import { selectTarget } from './combat';
import { moveTo, stop } from './movement';
import { hostileMask } from './spatial';
import { eagerOn, stormOn, STRATEGY_AI } from './strategyai';
import { Ground } from './terrain';
import { navPost } from './crewai';
import { dig, openWork, startLine, WORKS } from './works';
import { isCommander } from './formulas';
import { planPlaceStructure, planStructures } from './fortplans';
import { counterStrikes, frontById } from './frontref';
import type { Faction, Front, Unit } from './types';
import { angleDiff, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * Round 3 (user: "加强统帅部决策, when the base is under risk, troops should back to defend" and
 * "let the 统帅部建造工事 when they feel the base will be attacked"). Once per HQ think (5 s) the
 * high command forecasts the risk to its capital from the current world state, recalls just
 * enough force to outweigh the attack (home-guard detachments first, then whole army groups,
 * nearest and least engaged first), and digs trenches and sandbags on the threatened approach
 * before the enemy arrives. See docs/STRATEGY_LAB.md "Round 3".
 */
export const HOME = {
  /** Known enemies inside this radius of the capital count fully (in contact). */
  contactM: 450,
  /** …inside this radius at `offAxisWeight` unless they head for the capital (then fully). */
  scanM: 900,
  offAxisWeight: 0.35,
  /** …or this if their group is not closing in (a front line standing near the capital kept the alarm on for good). */
  offAxisIdleWeight: 0.1,
  /** Enemies heading for the capital (spearhead / their group's target / destination) out to this range, weight falling linearly from scanM. */
  farM: 2400,
  /** …and only while that group's mean distance to the capital shrinks at ≥ this (m/s, smoothed). */
  closingMps: 0.25,
  /** Own value inside this radius = the capital's garrison. */
  garrisonM: 250,
  /** Threat level = forecast ÷ (forecast + garrison + levelPad). */
  levelPad: 150,
  /** Raise the alarm at level ≥ activeLevel with a forecast ≥ minThreat; stand down below releaseLevel after calmS (and ≥ minHoldS active). */
  activeLevel: 0.4,
  minThreat: 150,
  releaseLevel: 0.25,
  calmS: 30,
  minHoldS: 60,
  /** Recall until own strength at home ≥ overmatch × forecast. */
  overmatch: 1.2,
  /** A group is recalled only if it can march home (at `marchMps`) within the threat's ETA + `reachSlackS`. */
  marchMps: 1.6,
  reachSlackS: 360,
  /** A recalled group is released early once the rest outweighs the forecast by `surplus` × overmatch (after ≥ `minRecallS`). */
  surplus: 1.0,
  minRecallS: 60,
  /** All groups come home only if the forecast × overmatch is ≥ this share of the whole army; otherwise one keeps attacking. */
  allGroupsShare: 0.5,
  /** Hopeless: forecast ≥ this × our whole army → no group marches home early (only once the enemy is within `gatesEtaS`); guards and works still go in. */
  hopelessRatio: 1.5,
  gatesEtaS: 120,
  /** Occupation detachments within this range of the capital are the first home guards. */
  occupyRecallM: 600,
  /** Home-guard detachments: free units inside guardRadiusM, at most guardMax. */
  guardRadiusM: 1500,
  guardMax: 14,
  /** Fortify at level ≥ fortifyLevel, or when a superior force heads our way with ETA ≤ fortifyEtaS; never with an enemy inside noDigM. */
  fortifyLevel: 0.2,
  fortifyEtaS: 900,
  /** A fortify order stands at least this long (no flicker), and is announced at most every 2 × this. */
  fortifyHoldS: 60,
  noDigM: 150,
  /** Works on the approach axis: trench line `trenchR` out, sandbags at the town edge `sandbagR`; caps per capital. */
  trenchR: 160,
  sandbagR: 85,
  maxTrench: 3,
  maxSandbag: 4,
  worksRadiusM: 260,
  /** At most this many unfinished home works at a time; diggers wanted per open work; P kept back for production (× work cost). */
  maxOpen: 2,
  diggersPerWork: 2,
  reserveCostMul: 0.5,
  /** Towns / cities with a defend directive: one trench across the approach, `placeTrenchPad` m outside the place radius. */
  placeTrenchPad: 40,
} as const;

export const homeOn = (): boolean => eagerOn() && STRATEGY_AI.homeDefence;

/**
 * 2.0 capital rule (user: "首都区域必须有驻防"): every faction keeps
 * `rules.command.capital_standing_garrison` home guards from `fromS` on, threat or not: infantry
 * squads (they dig and man the capital line), nearest the capital first.
 */
export const STANDING = {
  fromS: 120,
  /** A recall / counter-strike front is taken last by the recall (cost added to its rank). */
  counterStrikeCost: 3,
} as const;

/** A group in the middle of an assault, a breakthrough or a siege of its own. */
const storming = (s: Front): boolean => s.opPhase === 'assault' || s.mode === 'breakthrough' || (s.op === 'siege' && s.opPhase !== '');

export interface HomeThreat {
  /** Risk to the capital, 0 … 1. */
  level: number;
  /** Seconds until the forecast attack reaches the capital (0 = there, -1 = none known). */
  eta: number;
  /** Forecast attacking value, own value inside `garrisonM`, and own value committed (guards + recalled groups). */
  enemy: number;
  garrison: number;
  committed: number;
  /** Bearing from the capital toward the threat (rad). */
  bearing: number;
  active: boolean;
  since: number;
  calmSince: number;
  /** Army groups recalled to the capital, and when each was recalled (by group id). */
  recall: number[];
  recallAt: Record<number, number>;
  fortify: boolean;
  fortifyUntil: number;
  fortifyNoteAt: number;
  /** Last home-defence announcement (log throttle). */
  noteAt: number;
  /** Line works (trench / sandbag) at the capital, alive. */
  works: number;
  /** Superior force heading for the capital (value) and its ETA. */
  far: number;
  /** Round 5: forecast value from enemies in contact or actually heading for the capital (no off-axis share). */
  aimed: number;
  farEta: number;
}

export function createHomeThreat(): HomeThreat {
  return { level: 0, eta: -1, enemy: 0, garrison: 0, committed: 0, bearing: 0, active: false, since: 0, calmSince: 0, recall: [], recallAt: {}, fortify: false, fortifyUntil: -1, fortifyNoteAt: -1e9, noteAt: -1e9, works: 0, far: 0, farEta: -1, aimed: 0 };
}

/** Recalled to the capital (new graded rule or the old all-or-nothing one). */
export const defendingHome = (s: Front): boolean => s.reason === 'reason.defendCity' || s.reason === 'reason.homeDefence';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
const hqKey = (f: number): string => `hq:${f}`;

/** Does this (enemy) unit head for capital `f`? Spearhead, its group's target, or its destination. */
function aimedAt(world: World, f: number, u: Unit, hq: V2): boolean {
  if (u.spearhead === hqKey(f)) return true;
  const owner = world.factions[u.owner];
  if (owner && frontById(owner, u.frontId)?.targetCity === f) return true;
  return !!u.dest && dist(u.dest, hq) < 400;
}

interface GroupInfo { value: number; sx: number; sz: number; firing: number; n: number }

/**
 * Forecast (O(units), every HQ think): weighted known enemy value approaching the capital, its
 * ETA and bearing, the garrison, and per-group strength / position / engagement for the recall.
 */
function forecast(world: World, f: Faction, groups: Map<number, GroupInfo>): number {
  const ht = f.command.homeThreat;
  const hq = world.hqPos(f.id);
  let enemy = 0;
  let etaW = 0;
  let far = 0;
  let farEtaW = 0;
  let garrison = 0;
  let bx = 0;
  let bz = 0;
  let guardAway = 0;
  let aimedV = 0;
  const key = hqKey(f.id);
  const tracks = approachOf(f);
  const acc = new Map<number, { dv: number; v: number }>();
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    const d = dist(u.pos, hq);
    if (u.owner === f.id) {
      const v = valueOf(u);
      // Each own unit counts once: at home (garrison), a home guard on its way, or its group.
      if (d < HOME.garrisonM) {
        garrison += v;
        continue;
      }
      if (u.fixed) continue;
      if (u.opRole === 'garrison' && u.opObjective === key) {
        guardAway += v;
        continue;
      }
      const g = groups.get(u.frontId);
      if (!g) continue;
      g.value += v;
      g.sx += u.pos.x;
      g.sz += u.pos.z;
      g.n++;
      if (world.time - u.lastFiredAt < 10) g.firing++;
      continue;
    }
    if (u.fixed || d > HOME.farM || !world.isHostile(f.id, u.owner) || !world.knows(f.id, u)) continue;
    const v = valueOf(u);
    // Per enemy group: value-weighted distance to our capital (closing speed from think to think).
    const gk = u.owner * 64 + u.frontId;
    const a = acc.get(gk) ?? { dv: 0, v: 0 };
    a.dv += d * v;
    a.v += v;
    acc.set(gk, a);
    const aimed = d < HOME.contactM || aimedAt(world, f.id, u, hq);
    // Beyond scanM only a group that is actually closing in counts (a group aimed at us but
    // fighting elsewhere kept every army group at home for 10 min in the first build).
    const closing = (tracks.get(gk)?.speed ?? 0) >= HOME.closingMps;
    const w = d < HOME.contactM ? 1 : d < HOME.scanM ? (aimed ? 1 : closing ? HOME.offAxisWeight : HOME.offAxisIdleWeight) : aimed && closing ? clamp01(1 - (d - HOME.scanM) / (HOME.farM - HOME.scanM)) : 0;
    const eta = Math.max(0, d - HOME.noDigM) / Math.max(0.8, u.def.speed);
    if (aimed && d >= HOME.contactM && (d < HOME.scanM || closing)) {
      far += v;
      farEtaW += v * eta;
    }
    if (w <= 0) continue;
    enemy += v * w;
    if (aimed) aimedV += v * w;
    etaW += v * w * eta;
    bx += ((u.pos.x - hq.x) / Math.max(1, d)) * v * w;
    bz += ((u.pos.z - hq.z) / Math.max(1, d)) * v * w;
  }
  updateApproach(world, tracks, acc);
  ht.enemy = enemy;
  ht.aimed = aimedV;
  ht.garrison = garrison;
  ht.eta = enemy > 0 ? etaW / enemy : far > 0 ? farEtaW / far : -1;
  ht.far = far;
  ht.farEta = far > 0 ? farEtaW / far : -1;
  // 2.0: guards on their way home (the standing garrison walking to its posts) count too.
  ht.level = enemy > 0 ? enemy / (enemy + garrison + guardAway + HOME.levelPad) : 0;
  // No threat known: face the city's exit (the side the front lies on).
  if (bx !== 0 || bz !== 0) ht.bearing = Math.atan2(bz, bx);
  else if (!ht.active) ht.bearing = headingTo(hq, world.cityOf(f.id).exit);
  return guardAway;
}

interface Approach { d: number; speed: number; t: number }
const approach = new WeakMap<Faction, Map<number, Approach>>();

function approachOf(f: Faction): Map<number, Approach> {
  let m = approach.get(f);
  if (!m) {
    m = new Map();
    approach.set(f, m);
  }
  return m;
}

/** Closing speed (m/s, smoothed) of each enemy group toward our capital; groups out of sight are forgotten. */
function updateApproach(world: World, tracks: Map<number, Approach>, acc: Map<number, { dv: number; v: number }>): void {
  for (const k of [...tracks.keys()]) if (!acc.has(k)) tracks.delete(k);
  for (const [k, a] of acc) {
    const d = a.dv / Math.max(1e-6, a.v);
    const prev = tracks.get(k);
    const speed = prev ? 0.5 * prev.speed + (0.5 * (prev.d - d)) / Math.max(1, world.time - prev.t) : 0;
    tracks.set(k, { d, speed, t: world.time });
  }
}

/** High-command home-defence pass (called from thinkHighCommand every HQ think). */
export function thinkHomeDefence(world: World, f: Faction): void {
  if (!homeOn()) return;
  const ht = f.command.homeThreat;
  const groups = new Map<number, GroupInfo>(f.fronts.map((s) => [s.id, { value: 0, sx: 0, sz: 0, firing: 0, n: 0 }]));
  const guardAway = forecast(world, f, groups);
  const now = world.time;
  const wasActive = ht.active;
  if (!ht.active && ht.level >= HOME.activeLevel && ht.enemy >= HOME.minThreat) {
    ht.active = true;
    ht.since = now;
    ht.calmSince = -1;
    world.note(f.id, 'log.homeThreat', { enemy: Math.round(ht.enemy), eta: Math.round(ht.eta) }, 'alert');
  } else if (ht.active) {
    if (ht.level < HOME.releaseLevel) {
      if (ht.calmSince < 0) ht.calmSince = now;
    } else ht.calmSince = -1;
    if (ht.calmSince >= 0 && now - ht.calmSince >= HOME.calmS && now - ht.since >= HOME.minHoldS) {
      ht.active = false;
      ht.recall = [];
      ht.recallAt = {};
      world.note(f.id, 'log.homeSafe', {}, 'info');
    }
  }
  const nearest = nearestEnemy(world, f.id, world.hqPos(f.id), HOME.worksRadiusM);
  const superior = ht.far >= Math.max(HOME.minThreat * 2, 1.2 * (ht.garrison + ownNear(groups, world, f))) && ht.farEta >= 0 && ht.farEta <= HOME.fortifyEtaS;
  const want = (ht.level >= HOME.fortifyLevel && ht.enemy >= HOME.minThreat) || superior;
  if (want) ht.fortifyUntil = now + HOME.fortifyHoldS;
  const fortify = nearest > HOME.noDigM && (want || now < ht.fortifyUntil);
  if (fortify && !ht.fortify && now - ht.fortifyNoteAt > HOME.fortifyHoldS * 2) {
    ht.fortifyNoteAt = now;
    world.note(f.id, 'log.homeFortify', { eta: Math.round(ht.eta) }, 'info');
  }
  ht.fortify = fortify;
  const guards = homeGuards(world, f.id);
  ht.works = fortifyHome(world, f);
  if (ht.active) recall(world, f, groups, guards, guardAway, !wasActive);
  else releaseGuards(world, f, guards);
  keepStanding(world, f, guards);
  if (ht.fortify) ensureDiggers(world, f, guards);
}

function nearestEnemy(world: World, f: number, at: V2, r: number): number {
  let best = Infinity;
  for (const e of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (e.hp <= 0 || !world.knows(f, e)) continue;
    best = Math.min(best, dist(e.pos, at));
  }
  return best;
}

/** Own mobile value within reach of home (groups whose centroid is inside guardRadiusM). */
function ownNear(groups: Map<number, GroupInfo>, world: World, f: Faction): number {
  const hq = world.hqPos(f.id);
  let v = 0;
  for (const g of groups.values()) if (g.n > 0 && dist({ x: g.sx / g.n, z: g.sz / g.n }, hq) < HOME.guardRadiusM) v += g.value;
  return v;
}

function homeGuards(world: World, f: number): Unit[] {
  const key = hqKey(f);
  const out: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f && u.hp > 0 && u.opRole === 'garrison' && u.opObjective === key) out.push(u);
  return out;
}

function toGuard(u: Unit, f: number): void {
  u.opRole = 'garrison';
  u.opObjective = hqKey(f);
  u.opTarget = null;
  u.opUntil = 0;
}

function toLine(u: Unit): void {
  u.opRole = 'line';
  u.opObjective = null;
  u.opTarget = null;
}

/** Candidate home guards by tier: occupation / quiet garrison detachments, then AT guns and MGs, then free line troops; nearest first. */
function guardPool(world: World, f: Faction, engineersOnly: boolean, minD: number, anyFront = false): Unit[] {
  const hq = world.hqPos(f.id);
  // The standing garrison (anyFront) is drawn from any front, ordered or busy: the capital is never empty.
  const busy = new Set(anyFront ? [] : f.fronts.filter((s) => (s.op !== 'frontal' && s.opPhase !== '') || s.manualTarget).map((s) => s.id));
  const tiered: { u: Unit; tier: number; d: number }[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed || u.manual || u.routing || u.spearhead) continue;
    if (u.behavior !== 'advance' && u.behavior !== 'rally') continue;
    if (u.def.id === 'supply_truck' || u.def.id === 'howitzer' || u.def.id === 'mortar' || u.def.id === 'recon' || isCommander(u.def)) continue;
    if (engineersOnly && u.def.id !== 'engineer') continue;
    const d = dist(u.pos, hq);
    if (d > HOME.guardRadiusM || d < minD) continue;
    let tier: number;
    if (u.opRole === 'occupy') {
      if (d > HOME.occupyRecallM) continue;
      tier = 0;
    }
    else if (u.opRole === 'garrison' && u.opObjective && !u.opObjective.startsWith('hq:')
      && world.time - (f.command.threatAt[u.opObjective] ?? -1e9) > 20) tier = 0;
    else if (u.opRole !== 'line' || busy.has(u.frontId)) continue;
    else tier = u.def.id === 'at_gun' || u.def.id === 'mg' ? 1 : 2;
    tiered.push({ u, tier, d });
  }
  tiered.sort((a, b) => a.tier - b.tier || a.d - b.d || a.u.id - b.u.id);
  return tiered.map((x) => x.u);
}

/**
 * Graded recall: home-guard detachments first, then whole army groups (nearest / least engaged
 * first) until home strength ≥ overmatch × forecast. Recalled groups stay recalled while the
 * alarm lasts (no yo-yo); they get their old orders back when it ends (fronts.ts).
 */
function recall(world: World, f: Faction, groups: Map<number, GroupInfo>, guards: Unit[], guardAway: number, fresh: boolean): void {
  const ht = f.command.homeThreat;
  const hq = world.hqPos(f.id);
  const want = HOME.overmatch * ht.enemy;
  // What is already home or on its way: the garrison (incl. guards and recalled troops arrived),
  // guards still marching, recalled groups' value outside the garrison radius.
  let have = ht.garrison + guardAway;
  for (const id of ht.recall) have += groups.get(id)?.value ?? 0;
  let sent = 0;
  if (have < want) {
    for (const u of guardPool(world, f, false, HOME.garrisonM)) {
      if (have >= want || guards.length + sent >= HOME.guardMax) break;
      toGuard(u, f.id);
      have += valueOf(u);
      sent++;
    }
  }
  const before = ht.recall.length;
  // Round 5: a finisher keeps only its guards at home (a raid cannot cost it the war it is winning),
  // and nobody recalls a whole group unless a real spearhead / contact is coming (no turtling).
  const finisher = stormOn() && f.command.finisher;
  if (finisher) ht.recall = [];
  const groupsAllowed = !finisher && (!stormOn() || ht.aimed >= HOME.minThreat);
  const centre = (id: number): V2 => {
    const g = groups.get(id);
    return g && g.n > 0 ? { x: g.sx / g.n, z: g.sz / g.n } : hq;
  };
  if (have < want && groupsAllowed) {
    // Only groups that can be home in time; the rest keep the offensive going.
    const window = Math.max(0, ht.eta) + HOME.reachSlackS;
    let army = ht.garrison + guardAway;
    for (const g of groups.values()) army += g.value;
    // Round 4: a hopeless defence recalls no further group even at the gates (the army fights on in the
    // field; recalling it made the last capitals unbreakable). Raids never reach this ratio.
    const hopeless = ht.enemy >= army * HOME.hopelessRatio && (stormOn() || ht.eta > HOME.gatesEtaS);
    const maxGroups = hopeless ? ht.recall.length : want >= army * HOME.allGroupsShare ? f.fronts.length : f.fronts.length - 1;
    const cands = f.fronts
      .filter((s) => !s.manualTarget && !ht.recall.includes(s.id) && (groups.get(s.id)?.n ?? 0) > 0 && dist(centre(s.id), hq) / HOME.marchMps <= window)
      // Round 4: an assault / storm under way is not called off (op success −3.7 pts in round 3), unless the enemy is at the gates.
      .filter((s) => !stormOn() || !storming(s) || ht.eta <= HOME.gatesEtaS)
      .map((s) => {
        const g = groups.get(s.id)!;
        const engaged = g.firing / g.n;
        const cost = dist(centre(s.id), hq) / 1000 + engaged * 1.5 + (s.opPhase === 'assault' ? 1 : 0) + (s.mode === 'push' || s.mode === 'breakthrough' ? 0.4 : 0)
          + (counterStrikes.has(s) ? STANDING.counterStrikeCost : 0);
        return { s, cost };
      })
      .sort((a, b) => a.cost - b.cost || a.s.id - b.s.id);
    for (const c of cands) {
      if (have >= want || ht.recall.length >= maxGroups) break;
      ht.recall = [...ht.recall, c.s.id];
      ht.recallAt = { ...ht.recallAt, [c.s.id]: world.time };
      have += groups.get(c.s.id)?.value ?? 0;
    }
  } else if (ht.recall.length > 0) {
    // Surplus: release the most recently recalled group once the rest clearly suffices.
    const last = ht.recall[ht.recall.length - 1];
    const v = groups.get(last)?.value ?? 0;
    if (world.time - (ht.recallAt[last] ?? 0) >= HOME.minRecallS && have - v >= want * HOME.surplus) {
      ht.recall = ht.recall.slice(0, -1);
      have -= v;
    }
  }
  ht.committed = have - ht.garrison;
  // Announce a new alarm, a newly recalled group, or (at most once a minute) fresh guard detachments.
  if (fresh || ht.recall.length > before || (sent > 0 && world.time - ht.noteAt >= 60)) {
    ht.noteAt = world.time;
    world.note(f.id, 'log.homeDefence', { groups: ht.recall.length, n: guards.length + sent, enemy: Math.round(ht.enemy), eta: Math.round(ht.eta) }, 'warn');
  }
}

/**
 * No alarm: guards return to their groups once the fortify order has lapsed (they stay to dig and
 * man the works while it lasts), except the standing garrison (2.0).
 */
function releaseGuards(world: World, f: Faction, guards: Unit[]): void {
  if (f.command.homeThreat.fortify) return;
  const keep = new Set(world.time >= STANDING.fromS ? rankStanding(world, f, guards).slice(0, standingSize(world)) : []);
  const kept = guards.filter((u) => keep.has(u));
  for (const u of guards) if (!keep.has(u)) toLine(u);
  guards.length = 0;
  guards.push(...kept);
}

const standingSize = (world: World): number => world.data.rules.command.capital_standing_garrison;

/** Standing-guard preference: infantry (diggers), then crews, then the rest; nearest the capital first. */
function rankStanding(world: World, f: Faction, units: Unit[]): Unit[] {
  const hq = world.hqPos(f.id);
  const rank = (u: Unit): number => (u.def.kind === 'infantry' ? 0 : u.def.kind === 'crew' ? 1 : 2);
  return [...units].sort((a, b) => rank(a) - rank(b) || dist(a.pos, hq) - dist(b.pos, hq) || a.id - b.id);
}

/** Top the standing garrison up to `capital_standing_garrison` (from `STANDING.fromS`). */
function keepStanding(world: World, f: Faction, guards: Unit[]): void {
  if (world.time < STANDING.fromS) return;
  const missing = standingSize(world) - guards.length;
  if (missing <= 0) return;
  // Squads only (rifle / engineer / motorised): crews posted by the standing garrison sat 'unreachable' (soak seed 13).
  const pool = rankStanding(world, f, guardPool(world, f, false, 0, true).filter((u) => u.def.kind === 'infantry'));
  for (const u of pool.slice(0, missing)) {
    toGuard(u, f.id);
    guards.push(u);
  }
}

/** Engineers first, then infantry, so each open home work has its diggers. */
function ensureDiggers(world: World, f: Faction, guards: Unit[]): void {
  const hq = world.hqPos(f.id);
  let open = 0;
  for (const w of world.forts) if (w.owner === f.id && w.hp > 0 && w.progress < 1 && (w.kind === 'trench' || w.kind === 'sandbag') && dist(w.pos, hq) < HOME.worksRadiusM) open++;
  if (open === 0) return;
  let diggers = guards.filter((u) => u.def.kind === 'infantry').length;
  const want = open * HOME.diggersPerWork;
  if (diggers >= want) return;
  for (const pool of [guardPool(world, f, true, 0), guardPool(world, f, false, 0)]) {
    for (const u of pool) {
      if (diggers >= want || guards.length >= HOME.guardMax) return;
      if (u.def.kind !== 'infantry' || (u.opRole === 'garrison' && u.opObjective === hqKey(f.id))) continue;
      toGuard(u, f.id);
      guards.push(u);
      diggers++;
    }
  }
}

/** Trench / sandbag sites on the approach axis, in build order (trench, sandbag, …). */
const TRENCH_ANGLES = [0, -0.45, 0.45];
const SANDBAG_ANGLES = [-0.22, 0.22, -0.6, 0.6];

/**
 * Order the capital's works while fortify is on: up to 3 trench lines ~160 m out across the
 * approach axis and 4 sandbag barricades at the town edge, one start per startEverySeconds,
 * at most `maxOpen` unfinished at a time, and never eating the P that production needs.
 * Returns the number of home works alive.
 */
function fortifyHome(world: World, f: Faction): number {
  // 2.0: the standing capital line and the other planned works / buildings (fortplans.ts), every HQ think.
  planStructures(world, f);
  const ht = f.command.homeThreat;
  const hq = world.hqPos(f.id);
  let trenches = 0;
  let sandbags = 0;
  let open = 0;
  for (const w of world.forts) {
    if (w.owner !== f.id || w.hp <= 0 || (w.kind !== 'trench' && w.kind !== 'sandbag') || dist(w.pos, hq) > HOME.worksRadiusM) continue;
    if (w.kind === 'trench') trenches++;
    else sandbags++;
    if (w.progress < 1) open++;
  }
  const total = trenches + sandbags;
  if (!ht.fortify || open >= HOME.maxOpen) return total;
  const kind: 'trench' | 'sandbag' | null = trenches < HOME.maxTrench && (trenches <= sandbags || sandbags >= HOME.maxSandbag) ? 'trench'
    : sandbags < HOME.maxSandbag ? 'sandbag' : null;
  if (!kind) return total;
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  if (f.p < WORKS[kind].costP * k * (1 + HOME.reserveCostMul)) return total;
  const angles = kind === 'trench' ? TRENCH_ANGLES : SANDBAG_ANGLES;
  const r0 = kind === 'trench' ? HOME.trenchR : HOME.sandbagR;
  const idx = kind === 'trench' ? trenches : sandbags;
  for (let a = idx; a < angles.length; a++) {
    const ang = ht.bearing + angles[a];
    for (const r of [r0, r0 - 20, r0 + 25, r0 - 35]) {
      const p = { x: hq.x + Math.cos(ang) * r, z: hq.z + Math.sin(ang) * r };
      if (!siteOk(world, p)) continue;
      if (startLine(world, f, kind, p, ang)) return total + 1;
    }
  }
  return total;
}

function siteOk(world: World, p: V2): boolean {
  if (!world.terrain.inBounds(p.x, p.z) || world.terrain.buildingH(p.x, p.z) > 0) return false;
  // Round 4: diggers (infantry) must be able to stand there.
  if (stormOn() && !world.nav(false, 35).nearestPassable(p, 6)) return false;
  const g = world.terrain.groundAt(p.x, p.z);
  return g !== Ground.Water;
}

/**
 * Defend directive on a town / city (generalised): one trench across the approach, just outside
 * the place, when the garrison is there and the enemy is not yet inside `noDigM`. The garrison
 * digs it (command.ts fortifyPost helps any open work in the place).
 */
export function fortifyPlace(world: World, f: Faction, centre: V2, radius: number): void {
  if (!homeOn()) return;
  const r = radius + HOME.placeTrenchPad;
  let near = Infinity;
  let sx = 0;
  let sz = 0;
  for (const e of world.spatial.queryOwners(centre.x, centre.z, 600, hostileMask(world, f.id))) {
    if (e.hp <= 0 || !world.knows(f.id, e)) continue;
    const d = dist(e.pos, centre);
    near = Math.min(near, d);
    sx += e.pos.x - centre.x;
    sz += e.pos.z - centre.z;
  }
  if (near <= HOME.noDigM || (sx === 0 && sz === 0)) return;
  const ang = Math.atan2(sz, sx);
  // 2.0: with the approach trench standing, add a pillbox just inside it when M allows (fortplans.ts).
  if (world.forts.some((w) => w.owner === f.id && w.hp > 0 && w.kind === 'trench' && dist(w.pos, centre) < r + 40)) {
    planPlaceStructure(world, f, centre, radius, ang);
    return;
  }
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  if (f.p < WORKS.trench.costP * k * (1 + HOME.reserveCostMul)) return;
  for (const rr of [r, r - 20, r + 20]) {
    const p = { x: centre.x + Math.cos(ang) * rr, z: centre.z + Math.sin(ang) * rr };
    if (siteOk(world, p) && startLine(world, f, 'trench', p, ang)) return;
  }
}

// ---------------------------------------------------------------- unit behaviour

/**
 * Home guard (a garrison of the capital, `opObjective = hq:<f>`): counter-attack enemies inside
 * the town; otherwise dig the open home works (no enemy inside noDigM) or man a post on the
 * threatened approach — infantry in a finished trench / behind sandbags, AT guns and MGs on the
 * axis just behind the trench line.
 */
export function thinkHomeGuard(world: World, u: Unit): boolean {
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
    // Inside the town: go for them (the capture ring must hold a defender).
    if (u.def.kind !== 'crew') moveTo(world, u, foe.pos);
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

/** Spread in [-0.5, 0.5) by id (stable). */
const spreadOf = (u: Unit): number => (((Math.imul(u.id, 2654435761) >>> 0) % 1000) / 1000) - 0.5;

function guardPost(world: World, u: Unit, hq: V2, bearing: number): V2 {
  const s = spreadOf(u);
  if (u.def.kind === 'crew' || u.def.kind === 'vehicle') {
    const r = u.def.kind === 'crew' ? HOME.trenchR - 40 : HOME.sandbagR + 30;
    const a = bearing + s * 0.9;
    return postAt(world, u, { x: hq.x + Math.cos(a) * r, z: hq.z + Math.sin(a) * r });
  }
  // Infantry: a place along a finished home work facing the threat (cover), else the town edge.
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
    // Stand just behind the parapet (cover radius ~4–6 m).
    return { x: p.x - Math.cos(best.facing) * 2, z: p.z - Math.sin(best.facing) * 2 };
  }
  const a = bearing + s * 1.4;
  return postAt(world, u, { x: hq.x + Math.cos(a) * HOME.sandbagR * 0.9, z: hq.z + Math.sin(a) * HOME.sandbagR * 0.9 });
}

/** Round 4: posts on the unit's own nav grid (an AT gun sat "unreachable" for 10 min on a freeNear spot). */
const postAt = (world: World, u: Unit, p: V2): V2 => (stormOn() ? navPost(world, u, p) : world.terrain.freeNear(p, 30));

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

// ---------------------------------------------------------------- saved orders (fronts.ts)

interface SavedOrders { targetPos: V2; targetObjective: string | null; targetCity: number | null; rally: V2; lastRetarget: number }
const saved = new WeakMap<Front, SavedOrders>();

/** Remember a group's orders before it is recalled (first recall only). */
export function saveOrders(s: Front): void {
  if (saved.has(s) || defendingHome(s)) return;
  saved.set(s, { targetPos: { ...s.targetPos }, targetObjective: s.targetObjective, targetCity: s.targetCity, rally: { ...s.rally }, lastRetarget: s.lastRetarget });
}

/** Give a released group its old orders back (returns false if it had none saved). */
export function restoreOrders(s: Front): boolean {
  const o = saved.get(s);
  if (!o) return false;
  saved.delete(s);
  s.targetPos = { ...o.targetPos };
  s.targetObjective = o.targetObjective;
  s.targetCity = o.targetCity;
  s.rally = { ...o.rally };
  s.lastRetarget = o.lastRetarget;
  return true;
}

export const isRecalled = (f: Faction, s: Front): boolean => !s.manualTarget && f.command.homeThreat.recall.includes(s.id);
