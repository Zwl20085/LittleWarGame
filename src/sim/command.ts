import { selectTarget } from './combat';
import { enemyDistance } from './frontai';
import { dig, openWork, startLine } from './works';
import { moveTo, stop } from './movement';
import { hostileMask } from './spatial';
import { noteDirective } from './events';
import { ADAPT, adaptive, EAGER, eagerOn, stormOn } from './strategyai';
import { navPost } from './crewai';
import { assessFinisher, FINISH } from './storm';
import { populationCap } from './production';
import { isCommander } from './formulas';
import { createHomeThreat, fortifyPlace, homeOn, thinkHomeDefence, thinkHomeGuard, type HomeThreat } from './homeguard';
import type { Faction, Objective, Unit } from './types';
import { dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * High command (user request): one theatre-wide commander per faction that looks at every
 * settlement and issues directives — DEFEND threatened holdings, OCCUPY open ground, ATTACK
 * valuable enemy towns. Directives are executed by assigning units roles ('garrison',
 * 'occupy'); attack priorities bias the army groups' target choice. Runs every few seconds
 * with O(settlements × spatial query + directives × candidates) work, so it is cheap.
 */
export const HQ = {
  everySeconds: 5,
  threatRadius: 340,
  /** Max share of the army's value tied down in garrisons. */
  garrisonShare: 0.2,
  /** Garrison wants this many × the known threat's value (and at least `minGarrison`). */
  overmatch: 1.3,
  minGarrison: 2,
  assignRadius: 1600,
  releaseCalmSeconds: 45,
  occupyMaxDetachments: 3,
  occupySize: 3,
  occupyRange: 1400,
  /** Enemy-held ground must be at least this far away for an unescorted occupation. */
  occupySafeDist: 220,
  directivesShown: 6,
} as const;

export type DirectiveKind = 'defend' | 'occupy' | 'attack';

export interface Directive {
  readonly kind: DirectiveKind;
  readonly obj: string;
  readonly pos: V2;
  readonly priority: number;
  /** Units currently assigned (garrison / occupation detachment). */
  assigned: number;
}

export interface HighCommand {
  directives: Directive[];
  /** Attack bias per objective id for army-group targeting (0 … 1). */
  attackBias: Record<string, number>;
  /** Last time each held settlement had enemies near (garrison release). */
  threatAt: Record<string, number>;
  nextAt: number;
  /** Army fullness pop / popCap (0 … 1), refreshed every HQ think. */
  fullness: number;
  /** Economic need for territory (0 … 1): pop-capped or slow to replace losses → value places more. */
  need: number;
  /** Will to attack (0 … 1): full army, not weaker than the neighbour, idle line troops. */
  aggression: number;
  /** Decisive offensive: enemy faction whose capital every group goes for (-1 = none), and since when. */
  finishTarget: number;
  finishSince: number;
  /** Round 5 finisher: we dwarf our strongest remaining enemy and have the money (storm.assessFinisher). */
  finisher: boolean;
  /** Our army value ÷ the known army of the finish target (0 = none). */
  finishArmyRatio: number;
  /** Round 3: forecast risk to the capital, recalled groups and the fortify order (homeguard.ts). */
  homeThreat: HomeThreat;
}

export function createHighCommand(): HighCommand {
  return { directives: [], attackBias: {}, threatAt: {}, nextAt: 0, fullness: 0, need: 0, aggression: 0, finishTarget: -1, finishSince: 0, finisher: false, finishArmyRatio: 0, homeThreat: createHomeThreat() };
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Round 2: the commander's economic and military mood, O(units) every HQ think.
 * - need: replacement time (army value ÷ income) is long, or the army is near its pop cap
 *   (more places raise the cap) → territory is worth more;
 * - aggression: the army is full (money cannot buy more troops), not weaker than the
 *   strongest known neighbour, and line troops stand idle → attack.
 */
function assessMood(world: World, f: Faction): void {
  const hc = f.command;
  const cap = Math.max(1, populationCap(world, f));
  hc.fullness = (f.popPresent + f.popReserved) / cap;
  let army = 0;
  let line = 0;
  let idle = 0;
  const known = new Map<number, number>();
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    const v = u.def.costP + u.def.costM;
    if (u.owner === f.id) {
      army += v;
      if (u.opRole === 'line') {
        line++;
        if (world.time - u.lastFiredAt > EAGER.idleS) idle++;
      }
    } else if (world.isHostile(f.id, u.owner) && world.knows(f.id, u)) known.set(u.owner, (known.get(u.owner) ?? 0) + v);
  }
  // Neighbour = the hostile faction with the nearest capital.
  const hq = world.hqPos(f.id);
  let nb = -1;
  let nd = Infinity;
  for (const e of world.factions) {
    if (!e.alive || e.id === f.id || !world.isHostile(f.id, e.id)) continue;
    const d = dist(world.hqPos(e.id), hq);
    if (d < nd) { nd = d; nb = e.id; }
  }
  const rel = army / Math.max(1, nb >= 0 ? (known.get(nb) ?? 0) : 0);
  const income = Math.max(1, f.incomeP + f.incomeM);
  const full = clamp01((hc.fullness - EAGER.fullLo) / (EAGER.fullHi - EAGER.fullLo));
  hc.need = clamp01(Math.max(full, (army / income - EAGER.rebuildLo) / (EAGER.rebuildHi - EAGER.rebuildLo)));
  const relW = clamp01((rel - EAGER.relLo) / (EAGER.relHi - EAGER.relLo));
  const idleShare = line > 0 ? idle / line : 0;
  hc.aggression = clamp01(full * (0.4 + 0.6 * relW) + (hc.fullness > EAGER.fullLo ? 0.3 * idleShare : 0));
  chooseFinishTarget(world, f, army, known);
  assessFinisher(world, f, army, known);
}

/**
 * Decisive offensive (soak test: no war ended in 60 min; the leader sat pop-capped at the stock
 * cap holding 40–70 settlements). A dominant faction — held share ≥ `dominantShare`, or a full army
 * with stock piling up — or any faction facing a broken enemy (few settlements / small army)
 * concentrates every army group, spearhead and the assault posture on one enemy capital: the
 * weakest, nearest one. The choice is kept ≥ `finishKeepS` unless the target falls.
 */
function chooseFinishTarget(world: World, f: Faction, army: number, known: Map<number, number>): void {
  const hc = f.command;
  if (hc.finishTarget >= 0 && !world.factions[hc.finishTarget]?.alive) hc.finishTarget = -1;
  if (hc.finishTarget >= 0 && world.time - hc.finishSince < EAGER.finishKeepS) return;
  const held = new Map<number, number>();
  for (const o of world.objectives) if (o.owner >= 0) held.set(o.owner, (held.get(o.owner) ?? 0) + 1);
  const total = Math.max(1, world.objectives.length);
  const e = world.data.rules.economy;
  const hoarding = f.p + f.m >= (e.cap_p + e.cap_m) * EAGER.dominantStock;
  // Dominant: a big share of the land, a full army with money piling up, or simply a full and
  // idle army with the will to attack (every faction gets there by mid-game; wars should end).
  const dominant = (held.get(f.id) ?? 0) / total >= EAGER.dominantShare || (hc.fullness >= EAGER.dominantFull && hoarding)
    || (hc.aggression >= EAGER.finishAggression && hc.fullness >= EAGER.finishFullness);
  const hq = world.hqPos(f.id);
  let best = -1;
  let bestScore = Infinity;
  for (const x of world.factions) {
    if (!x.alive || x.id === f.id || !world.isHostile(f.id, x.id)) continue;
    const theirHeld = held.get(x.id) ?? 0;
    const theirArmy = known.get(x.id) ?? 0;
    // Broken relative to us (an absolute count also matched every faction's ~7 starting places).
    const ownHeld = held.get(f.id) ?? 0;
    const broken = (theirHeld <= EAGER.brokenHeld && ownHeld >= EAGER.brokenLead * Math.max(1, theirHeld))
      || (theirArmy < army * EAGER.brokenArmy && ownHeld > theirHeld);
    // Round 4: a side that dwarfs this enemy (≥ dwarfPop × its population) goes for it now.
    const dwarfed = stormOn() && f.popPresent >= EAGER.dwarfPop * Math.max(1, x.popPresent);
    if (!dominant && !dwarfed && !(broken && hc.fullness >= EAGER.fullLo)) continue;
    // Nearest and weakest: distance stretched by the enemy's share of the land and its army.
    const score = dist(world.hqPos(x.id), hq) * (0.5 + (2 * theirHeld) / total + theirArmy / Math.max(1, army));
    if (score < bestScore) { bestScore = score; best = x.id; }
  }
  if (best !== hc.finishTarget) {
    hc.finishTarget = best;
    hc.finishSince = world.time;
  }
}

const GARRISON_TYPES = new Set(['infantry', 'motor_inf', 'mg', 'at_gun', 'engineer', 'light_tank', 'medium_tank', 'heavy_tank']);
const OCCUPY_TYPES = new Set(['infantry', 'motor_inf', 'engineer', 'recon']);

const valueOf = (u: Unit): number => (isCommander(u.def) ? 0 : (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp));

/**
 * Economic + strategic worth of a settlement (income per minute, strategic towns weigh more).
 * `need` (0 … 1, HighCommand.need) adds the population-cap room the place brings, so a
 * pop-capped or poor army values towns and cities over villages more strongly.
 */
export function placeValue(world: World, o: Objective, need = 0): number {
  const t = world.data.rules.territory;
  const inc = (t?.income_p_per_min[o.kind] ?? 10) + (t?.income_m_per_min[o.kind] ?? 6);
  const pop = (t?.pop_per_place?.[o.kind] ?? 0) * POP_WORTH * need;
  return (inc + pop) * (o.strategic ? 1.3 : 1);
}

/** Income-per-minute equivalent of one pop-cap unit of a place (scale-free: both are per army_scale 1). */
const POP_WORTH = 10;

function strengthNear(world: World, f: number, at: V2, r: number): { mine: number; theirs: number } {
  let mine = 0;
  let theirs = 0;
  for (const u of world.spatial.query(at.x, at.z, r)) {
    if (u.hp <= 0 || u.fixed) continue;
    if (u.owner === f) mine += valueOf(u);
    else if (world.isHostile(f, u.owner) && world.knows(f, u)) theirs += valueOf(u);
  }
  return { mine, theirs };
}

/** Theatre planning pass (every HQ.everySeconds). */
export function thinkHighCommand(world: World, f: Faction): void {
  if (!f.alive || world.time < f.command.nextAt) return;
  f.command.nextAt = world.time + HQ.everySeconds;
  const hc = f.command;
  if (eagerOn()) assessMood(world, f);
  thinkHomeDefence(world, f);
  const dirs: Directive[] = [];
  const bias: Record<string, number> = {};
  const hq = world.hqPos(f.id);
  // Round 2: a needy commander risks occupations closer to enemy ground.
  const safeDist = eagerOn() ? EAGER.occupySafeDist - EAGER.occupySafeNeedCut * hc.need : HQ.occupySafeDist;
  for (const o of world.objectives) {
    const v = placeValue(world, o, eagerOn() ? hc.need : 0);
    const s = strengthNear(world, f.id, o.pos, HQ.threatRadius);
    if (o.owner === f.id) {
      // Garrisons for towns and cities; the many villages are held by the front line itself.
      if (s.theirs > 0 && (o.kind === 'town' || o.kind === 'city' || o.kind === 'point')) {
        hc.threatAt[o.id] = world.time;
        dirs.push({ kind: 'defend', obj: o.id, pos: o.pos, priority: v * (1 + s.theirs / (s.mine + 50)), assigned: 0 });
      }
      continue;
    }
    const dHome = dist(o.pos, hq);
    const reach = 1 / (1 + dHome / 1500);
    // Adaptive: an enemy village / point with no known troops near is occupied, not stormed.
    const undefendedEnemy = adaptive() && ADAPT.occupyEnemyHeld && o.owner >= 0 && world.isHostile(f.id, o.owner) && s.theirs === 0 && (o.kind === 'village' || o.kind === 'point');
    if ((o.owner < 0 && s.theirs === 0 && enemyDistance(world, f.id, o.pos) > safeDist) || undefendedEnemy) {
      dirs.push({ kind: 'occupy', obj: o.id, pos: o.pos, priority: v * reach, assigned: 0 });
    } else if (o.owner < 0 || world.isHostile(f.id, o.owner)) {
      const odds = (s.mine + 1) / (s.theirs + 1);
      const p = v * reach * Math.min(2, odds);
      dirs.push({ kind: 'attack', obj: o.id, pos: o.pos, priority: p, assigned: 0 });
      bias[o.id] = p;
    }
  }
  // Normalise attack bias to 0..1 for the group planners.
  const maxB = Math.max(1, ...Object.values(bias));
  for (const k of Object.keys(bias)) bias[k] /= maxB;
  hc.attackBias = bias;
  dirs.sort((a, b) => b.priority - a.priority);
  hc.directives = dirs;
  const top = dirs.find((d) => d.kind === 'attack');
  if (top) noteDirective(world, f.id, 'attack', top.obj, attackersOf(world, f, top.obj));
  const defend = dirs.filter((d) => d.kind === 'defend').slice(0, 8);
  assignGarrisons(world, f, defend);
  // Round 3: the two most pressed garrisoned towns / cities dig a trench across the approach.
  if (homeOn()) {
    for (const d of defend.filter((x) => x.assigned > 0).slice(0, 2)) {
      const o = world.objectives.find((x) => x.id === d.obj);
      if (o && (o.kind === 'town' || o.kind === 'city')) fortifyPlace(world, f, o.pos, o.radius);
    }
  }
  assignOccupations(world, f, dirs.filter((d) => d.kind === 'occupy'));
  // The UI shows the top few (all three kinds represented when present).
  hc.directives = pickShown(dirs);
}

/** Units of the army groups currently aimed at `obj` (for the battle-event log only). */
function attackersOf(world: World, f: Faction, obj: string): Unit[] {
  if (world.battle.lastAttack.get(f.id) === obj) return [];
  const secs = new Set(f.fronts.filter((s) => s.targetObjective === obj).map((s) => s.id));
  if (secs.size === 0) return [];
  const out: Unit[] = [];
  for (const u of world.units.values()) if (u.owner === f.id && u.hp > 0 && !u.fixed && secs.has(u.frontId)) out.push(u);
  return out;
}

function pickShown(dirs: Directive[]): Directive[] {
  const out: Directive[] = [];
  for (const kind of ['defend', 'attack', 'occupy'] as const) out.push(...dirs.filter((d) => d.kind === kind).slice(0, 2));
  return out.slice(0, HQ.directivesShown);
}

function freeLine(u: Unit): boolean {
  if (isCommander(u.def)) return false;
  return u.opRole === 'line' && !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance';
}

/** Defend directives: send the nearest line troops until the garrison outweighs the threat. */
function assignGarrisons(world: World, f: Faction, defend: Directive[]): void {
  const mine: Unit[] = [];
  let army = 0;
  let tied = 0;
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    mine.push(u);
    army += valueOf(u);
    if (u.opRole === 'garrison') tied += valueOf(u);
  }
  // Release garrisons whose town has been quiet for a while (or was lost).
  const kept = new Map<string, number>();
  for (const u of mine) {
    if (u.opRole !== 'garrison' || !u.opObjective || u.opObjective.startsWith('hq:')) continue;
    const o = world.objectives.find((x) => x.id === u.opObjective);
    // Round 5: a finisher strips its garrisons to the minimum, and faster (FINISH.releaseCalmS).
    const quiet = world.time - (f.command.threatAt[u.opObjective] ?? -1e9) > (f.command.finisher ? FINISH.releaseCalmS : HQ.releaseCalmSeconds);
    const n = kept.get(u.opObjective) ?? 0;
    const surplus = f.command.finisher && n >= HQ.minGarrison;
    if (!o || o.owner !== f.id || quiet || surplus) {
      u.opRole = 'line';
      u.opObjective = null;
      u.opTarget = null;
      tied -= valueOf(u);
    } else kept.set(u.opObjective, n + 1);
  }
  const budget = army * (f.command.finisher ? FINISH.garrisonShare : HQ.garrisonShare);
  for (const d of defend) {
    const s = strengthNear(world, f.id, d.pos, HQ.threatRadius);
    let have = 0;
    let count = 0;
    for (const u of mine) if (u.opRole === 'garrison' && u.opObjective === d.obj) { have += valueOf(u); count++; }
    const want = s.theirs * HQ.overmatch;
    const before = count;
    if ((have >= want && count >= HQ.minGarrison) || tied >= budget) {
      d.assigned = count;
      continue;
    }
    // Groups in the middle of an operation (forming up, digging in, storming) keep their troops.
    const busy = new Set(f.fronts.filter((s) => s.op !== 'frontal' && s.opPhase !== '').map((s) => s.id));
    const pool = mine.filter((u) => freeLine(u) && !busy.has(u.frontId) && GARRISON_TYPES.has(u.def.id) && dist(u.pos, d.pos) < HQ.assignRadius)
      .sort((a, b) => dist(a.pos, d.pos) - dist(b.pos, d.pos));
    const sent: Unit[] = [];
    for (const u of pool) {
      if ((have >= want && count >= HQ.minGarrison) || tied >= budget) break;
      sent.push(u);
      u.opRole = 'garrison';
      u.opObjective = d.obj;
      u.opTarget = null;
      have += valueOf(u);
      tied += valueOf(u);
      count++;
    }
    if (before === 0 && count > 0) {
      world.note(f.id, 'log.hqDefend', { point: d.obj, n: count }, 'info');
      noteDirective(world, f.id, 'defend', d.obj, sent);
    }
    d.assigned = count;
  }
}

/** Occupy directives: small infantry detachments take open settlements behind the lines. */
function assignOccupations(world: World, f: Faction, occupy: Directive[]): void {
  const active = new Map<string, number>();
  const pool: Unit[] = [];
  for (const u of world.units.values()) {
    if (u.owner !== f.id || u.hp <= 0 || u.fixed) continue;
    if (u.opRole === 'occupy' && u.opObjective) active.set(u.opObjective, (active.get(u.opObjective) ?? 0) + 1);
    else if (freeLine(u) && OCCUPY_TYPES.has(u.def.id)) pool.push(u);
  }
  let detachments = active.size;
  for (const d of occupy) d.assigned = active.get(d.obj) ?? 0;
  // Adaptive: nearest places first (fixed-time detachments marching far tended to expire).
  const order = adaptive() ? byReach(occupy, pool) : occupy;
  // Round 2: more detachments for a bigger idle pool and a needier economy (was a flat 3 × 3).
  const maxDetachments = f.command.finisher ? FINISH.occupyDetachments : eagerOn()
    ? Math.min(EAGER.occupyCap, EAGER.occupyBase + Math.floor((pool.length / EAGER.occupyPerUnits) * (0.5 + f.command.need)))
    : HQ.occupyMaxDetachments;
  for (const d of order) {
    if (detachments >= maxDetachments) break;
    if (active.has(d.obj)) {
      d.assigned = active.get(d.obj) ?? 0;
      continue;
    }
    const size = eagerOn() ? occupySizeFor(world, f.id, d) : HQ.occupySize;
    const near = pool.filter((u) => u.opRole === 'line' && dist(u.pos, d.pos) < HQ.occupyRange).sort((a, b) => dist(a.pos, d.pos) - dist(b.pos, d.pos)).slice(0, size);
    if (near.filter((u) => u.def.kind === 'infantry').length === 0) continue;
    for (const u of near) {
      u.opRole = 'occupy';
      u.opObjective = d.obj;
      u.opTarget = null;
      u.opUntil = world.time + (adaptive() ? ADAPT.occupyBaseS + dist(u.pos, d.pos) * ADAPT.occupySecondsPerM : 240) + (eagerOn() ? EAGER.occupyExtraS : 0);
    }
    d.assigned = near.length;
    detachments++;
    world.note(f.id, 'log.hqOccupy', { point: d.obj, n: near.length }, 'info');
    noteDirective(world, f.id, 'occupy', d.obj, near);
  }
}

/** Detachment size by place: a pair for villages / points well behind the line, 3 near it and for towns, 4 for cities. */
function occupySizeFor(world: World, f: number, d: Directive): number {
  const kind = world.objectives.find((o) => o.id === d.obj)?.kind;
  if (kind === 'city') return 4;
  return kind === 'town' || enemyDistance(world, f, d.pos) < 400 ? 3 : 2;
}

/** Occupy directives sorted by value ÷ (1 + distance from the nearest free detachment / 600 m). */
function byReach(occupy: Directive[], pool: Unit[]): Directive[] {
  const scored = occupy.map((d) => {
    let best = Infinity;
    for (const u of pool) best = Math.min(best, dist(u.pos, d.pos));
    return { d, s: d.priority / (1 + best / 600) };
  });
  return scored.sort((a, b) => b.s - a.s).map((x) => x.d);
}

/** Garrison post: a ring around the settlement centre, facing the threat; fight anything close. */
export function thinkGarrison(world: World, u: Unit): boolean {
  if (u.opObjective?.startsWith('hq:')) return thinkHomeGuard(world, u);
  const o = world.objectives.find((x) => x.id === u.opObjective);
  if (!o) {
    u.opRole = 'line';
    return false;
  }
  if (!u.opTarget) {
    const foe = threatBearing(world, u.owner, o.pos);
    const spreadA = ((u.id * 2654435761) % 1000) / 1000 - 0.5; // ±0.5 rad around the threat bearing
    // Round 4: crews (MG / AT) man the edge facing the threat so the approach is inside their range,
    // on their own nav grid (crewai.navPost).
    const crew = stormOn() && u.def.kind === 'crew';
    const r = crew ? o.radius + 10 : Math.max(25, o.radius * 0.55);
    const a = foe + spreadA * (crew ? 1.2 : 2.2);
    const p = { x: o.pos.x + Math.cos(a) * r, z: o.pos.z + Math.sin(a) * r };
    u.opTarget = stormOn() ? navPost(world, u, p) : world.terrain.freeNear(p, 30);
  }
  // Counter-attack enemies inside the town; otherwise man the post.
  let foeUnit: Unit | null = null;
  let bd = o.radius + 120;
  for (const e of world.spatial.queryOwners(o.pos.x, o.pos.z, bd, hostileMask(world, u.owner))) {
    if (e.hp <= 0 || !world.knows(u.owner, e)) continue;
    const d = dist(e.pos, o.pos);
    if (d < bd) {
      bd = d;
      foeUnit = e;
    }
  }
  // Round 4: crews do not charge into the town; they fight from their post (AT guns walked 20 % of garrison time).
  if (foeUnit && bd < o.radius + 40 && !(stormOn() && u.def.kind === 'crew')) moveTo(world, u, foeUnit.pos);
  else if (homeOn() && u.def.kind === 'infantry' && (!foeUnit || bd > 150) && digPlaceWork(world, u, o.pos, o.radius)) return true;
  else if (dist(u.pos, u.opTarget) > 12) moveTo(world, u, u.opTarget);
  else if (u.def.kind === 'infantry' && fortifyPost(world, u, o.pos)) return true;
  else stop(u);
  selectTarget(world, u, foeUnit ? foeUnit.pos : null);
  u.status = 'status.garrison';
  return true;
}

/** 筑垒防守: a garrison squad at its post stacks a sandbag barricade facing outward. */
/** Round 3: the garrison digs the place's approach trench (homeguard.fortifyPlace) before manning its post. */
function digPlaceWork(world: World, u: Unit, centre: V2, radius: number): boolean {
  if (u.moraleState !== 'normal') return false;
  const work = openWork(world, u.owner, centre, radius + 80);
  if (!work || work.kind !== 'trench') return false;
  selectTarget(world, u, null);
  u.status = 'status.digging';
  return dig(u, work, (p) => moveTo(world, u, p), () => stop(u));
}

function fortifyPost(world: World, u: Unit, centre: V2): boolean {
  const post = u.opTarget;
  if (!post) return false;
  let work = openWork(world, u.owner, post, 14);
  if (!work) {
    const near = world.forts.some((x) => x.owner === u.owner && x.hp > 0 && (x.kind === 'sandbag' || x.kind === 'trench') && dist(x.pos, post) < 14);
    if (near) return false;
    work = startLine(world, world.factions[u.owner], 'sandbag', post, headingTo(centre, post));
    if (!work) return false;
  }
  selectTarget(world, u, null);
  u.status = 'status.fortifying';
  return dig(u, work, (p) => moveTo(world, u, p), () => stop(u));
}

/** Occupation detachment: march in, take the place, then rejoin the army group. */
export function thinkOccupy(world: World, u: Unit): boolean {
  const o = world.objectives.find((x) => x.id === u.opObjective);
  const done = !o || o.owner === u.owner || world.time > u.opUntil || (o.owner >= 0 && !world.isHostile(u.owner, o.owner));
  if (done || !o) {
    u.opRole = 'line';
    u.opObjective = null;
    u.opTarget = null;
    return false;
  }
  if (!u.opTarget) u.opTarget = { ...world.terrain.freeNear(o.pos, 30) };
  if (dist(u.pos, u.opTarget) > 10) moveTo(world, u, u.opTarget);
  else stop(u);
  selectTarget(world, u, null);
  u.status = 'status.occupy';
  return true;
}

/** Bearing from `at` toward the nearest known enemy mass (falls back to away from our HQ). */
function threatBearing(world: World, f: number, at: V2): number {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const e of world.spatial.queryOwners(at.x, at.z, 600, hostileMask(world, f))) {
    if (e.hp <= 0 || !world.knows(f, e)) continue;
    sx += e.pos.x;
    sz += e.pos.z;
    n++;
  }
  if (n > 0) return headingTo(at, { x: sx / n, z: sz / n });
  return headingTo(world.hqPos(f), at);
}
