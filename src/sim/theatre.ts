import { deadCapital, maneuvering } from './doctrine';
import { isCommander } from './formulas';
import { counterStrikes } from './frontref';
import { assignWings, createFront, dissolveFront, transferable } from './frontops';
import { finishNow, frontGroups, issueFrontOrder, nextTarget } from './fronts';
import { defendingHome, HOME, isRecalled, ROUND7_AB } from './homeguard';
import { hostileMask } from './spatial';
import { capitalDefence } from './storm';
import { stormOn, STRATEGY_AI } from './strategyai';
import { isStructure } from './structures';
import type { Faction, Front, FrontOrder, Objective, Unit, Zone } from './types';
import { angleDiff, DEG, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * AI supreme HQ (2.0, docs/COMMAND_V2.md §1; user: "最高统帅部仅负责全局战略设置"; "取消左中右三路设计").
 * Every HQ think (5 s) for AI factions:
 *   1. theatre structure — one front per real axis (neighbouring enemy capitals, clusters of
 *      settlements worth attacking), up to `fronts_max` and one per `unitsPerFront` troops: open a
 *      front for an uncovered axis, merge fronts whose objectives and troops converged, dissolve
 *      empty ones (at most one change per `changeEveryS`);
 *   2. one order per front through the player's API (`issueFrontOrder`, `manual: false`): attack the
 *      objective the front commander's 1.x target choice picks (`nextTarget`, so rounds 1–5 keep
 *      working underneath), defend / fortify a threatened own town, fall back when routed;
 *   3. counter-strike: a front goes for an enemy capital whose army is committed against ours.
 * Reinforcement shares by need are set in cityai.balanceReserves; home recall stays in homeguard.ts.
 */
export const THEATRE = {
  /** Structural change (open / merge / dissolve) at most once per this long. */
  changeEveryS: 30,
  /** A front younger than this is neither merged nor dissolved (no churn). */
  minAgeS: 120,
  /** A new front gets ≥ newFrontFree free troops (2.0: 20; 2.1: most troops are on a task, ~20–70 of 100–130 are free mid-game). */
  newFrontFree: 14,
  /**
   * 2.1 (user: "前线指挥官可以设置多位，不必拘泥于三位"), fronts wanted (≤ fronts_max) = the most of:
   * one per neighbouring enemy capital (≤ troops ÷ neighbourTroops), the 2.0 rule (strong axes,
   * ≤ troops ÷ unitsPerFront) and one per troopsPerFront troops. Kept (hysteresis) by the same rule
   * with the kept-axis share and keepUnitsPerFront / keepTroopsPerFront.
   */
  unitsPerFront: 20,
  keepUnitsPerFront: 12,
  troopsPerFront: 28,
  keepTroopsPerFront: 20,
  neighbourTroops: 12,
  /** Beyond the axes, extra fronts go for the HQ's best attack objective ≥ extraSpacingM from every front's objective and line. */
  extraSpacingM: 600,
  /**
   * 2.1 garrison fronts (user: "每条永备工事可以拥有单独的前线指挥官"): a fortified zone with ≥ 1 finished
   * pillbox / bunker within zoneStructM of its line and no front holding a line within zoneHeldM gets
   * a front of its own (≤ zoneFrontsMax per faction) when ≥ zoneMinSquads free squads exist; it takes
   * zoneTroops troops nearest the zone and holds the zone's line on a standing (binding) defend order.
   */
  zoneStructM: 60,
  zoneHeldM: 300,
  zoneFrontsMax: 2,
  zoneMinSquads: 6,
  zoneTroops: 8,
  /**
   * 2.1 (AI fortified zones): a quiet `defend` line about to be released becomes a `fortify` (a
   * permanent zone, fronts.addZone) when a free engineer of ours is within zoneEngineerM of it, the
   * line is ≥ zoneMinLineM (addZone's minimum), the faction has < zonesMax live zones and none within
   * zoneSpacingM. The fortify stance then stands its own stanceMinS before it is released.
   */
  zoneEngineerM: 450,
  zoneMinLineM: 60,
  zonesMax: 3,
  zoneSpacingM: 500,
  /** A quiet held town's zone stands this far beyond its radius, toward the nearest enemy capital. */
  zoneFrontPadM: 60,
  /** Never merge below min(fronts_initial, troops / floorUnitsPerFront) fronts (diag seed 7: one 120-unit front held the whole frontage; soak 3 × 45 min: floor 40 → 25 took eliminations 2 → 3). */
  floorUnitsPerFront: 25,
  /** Axes: enemy capitals within neighbourMul × the nearest one (the diagonal capital of a 4-FFA is 1.41 ×, left out unless it is the finish target). */
  neighbourMul: 1.3,
  /** Capital axis weight 1 / (1 + d / capitalScaleM), × 2 for the finish target. */
  capitalScaleM: 2500,
  /** Settlements with HQ attack bias ≥ clusterMinBias form clusters of radius clusterM, weight clusterWeight × Σ bias. */
  clusterM: 700,
  clusterMinBias: 0.35,
  clusterWeight: 0.5,
  /** Axes closer than this in bearing from the capital are one axis. */
  axisMergeRad: 25 * DEG,
  /** Fronts wanted = axes with weight ≥ axisMinShare × the top axis (capped by army and fronts_max); fronts kept down to keepAxisShare (hysteresis: diag seed 7, 6 fronts opened and 5 merged in 20 min without it). */
  axisMinShare: 0.45,
  keepAxisShare: 0.25,
  /** An axis is covered by a front aiming within coverRad of its bearing, or with its target / line within coverM. */
  coverRad: 30 * DEG,
  coverM: 900,
  /** Converged: objectives within mergeTargetM and troop centroids within mergeCentroidM. */
  mergeTargetM: 300,
  mergeCentroidM: 500,
  /** A front without combat units for this long is dissolved. */
  emptyS: 30,
  /** Reinforcement share multipliers (cityai.balanceReserves): main effort, and a front below the mean strength (× the shortfall). */
  shareMain: 1.4,
  shareThin: 0.8,
  /** A front keeps its objective at least this long (1.x: "AI was too fast"). */
  retargetS: 60,
  /** Fall back when ≥ fallBackRouted of the front routs, or the known enemy at its line is ≥ fallBackOutmatch × the front, … */
  fallBackRouted: 0.4,
  fallBackOutmatch: 3,
  /** … unless it is already within fallBackMinHomeM of the capital; the new line is the nearest own town ≥ fallBackStepM nearer home (else a point fallBackStepM back). */
  fallBackMinHomeM: 900,
  fallBackStepM: 400,
  /** Defend a freshly held town / city target when known enemies within defendR are ≥ defendThreat × the front. */
  defendR: 500,
  defendThreat: 0.8,
  /** A stance order stands at least stanceMinS; defend turns to fortify after fortifyAfterS under threat; released after calmS with enemy < releaseRatio × the front, or after stanceMaxS once not outmatched (no front sits on a town for good). */
  stanceMinS: 60,
  stanceMaxS: 180,
  fortifyAfterS: 90,
  calmS: 20,
  releaseRatio: 0.5,
  /** Counter-strike: an enemy with ≥ csCommitted of its known army within csNearM of our capital, and a capital defence ≤ csArmyShare of that army … */
  csCommitted: 0.4,
  /** Round 7 (challenge lab, seed 13: a 20 % strike group took a capital, the 40 % rule never fired): while our capital is under alarm or breached, this share is enough. */
  csCommittedAttacked: 0.2,
  csNearM: 1400,
  csArmyShare: 0.3,
  /** … is struck by our strongest free front within csReachM of its capital with ≥ csRatio × the defence and ≥ csMinUnits troops; kept ≥ csKeepS.
   *  (Soak: csRatio 1 / csArmyShare 0.6 sent fronts at defended capitals; THEATRE_OFF=counter gained 2 eliminations on seeds 11 + 13.) */
  csReachM: 3200,
  csRatio: 2,
  csMinUnits: 6,
  csKeepS: 90,
} as const;

/** Lab switches for the parts of the AI supreme HQ (A/B in scripts/soak.ts: THEATRE_OFF=stances,structure,counter). */
export const THEATRE_AB = { stances: true, structure: true, counter: true };

interface Axis { pos: V2; bearing: number; weight: number; /** A neighbouring enemy capital (else a cluster of settlements). */ capital: boolean }
interface Meta { createdAt: number; emptySince: number; stanceSince: number; calmSince: number }

const metas = new WeakMap<Front, Meta>();
const nextChange = new WeakMap<Faction, number>();

function metaOf(world: World, s: Front): Meta {
  let m = metas.get(s);
  if (!m) {
    m = { createdAt: world.time, emptySince: -1, stanceSince: world.time, calmSince: -1 };
    metas.set(s, m);
  }
  return m;
}

const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);
const combatOf = (units: Unit[]): Unit[] => units.filter((u) => !isCommander(u.def) && u.def.id !== 'supply_truck');
const sumValue = (units: Unit[]): number => units.reduce((a, u) => a + valueOf(u), 0);

function centroid(units: Unit[], fallback: V2): V2 {
  if (units.length === 0) return fallback;
  let x = 0;
  let z = 0;
  for (const u of units) { x += u.pos.x; z += u.pos.z; }
  return { x: x / units.length, z: z / units.length };
}

function enemyNear(world: World, f: number, at: V2, r: number): number {
  let v = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp > 0 && world.knows(f, u) && !isCommander(u.def)) v += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
  }
  return v;
}

/** AI supreme-HQ pass (from command.thinkHighCommand, every HQ think). */
export function thinkTheatre(world: World, f: Faction): void {
  if (f.isPlayer || !f.alive || f.fronts.length === 0 || !STRATEGY_AI.theatre) return;
  const groups = frontGroups(world, f);
  const combat = new Map<number, Unit[]>();
  for (const s of f.fronts) {
    const c = combatOf(groups.get(s.id) ?? []);
    combat.set(s.id, c);
    const m = metaOf(world, s);
    if (c.length > 0) m.emptySince = -1;
    else if (m.emptySince < 0) m.emptySince = world.time;
  }
  assignWings(world, f);
  upkeepZoneGarrisons(world, f);
  if (THEATRE_AB.structure && world.time >= (nextChange.get(f) ?? 0) && restructure(world, f, combat)) nextChange.set(f, world.time + THEATRE.changeEveryS);
  if (THEATRE_AB.counter) counterStrike(world, f, combat);
  for (const s of [...f.fronts]) orderFront(world, f, s, combat.get(s.id) ?? []);
}

// ---------------------------------------------------------------- structure

/** Threat / opportunity axes, strongest first. */
export function theatreAxes(world: World, f: Faction): Axis[] {
  const hq = world.hqPos(f.id);
  const raw: Axis[] = [];
  const caps = world.factions.filter((e) => e.alive && e.id !== f.id && world.isHostile(f.id, e.id)).map((e) => ({ e, d: dist(world.hqPos(e.id), hq) }));
  const d0 = Math.min(...caps.map((c) => c.d));
  for (const c of caps) {
    const finish = c.e.id === f.command.finishTarget;
    if (c.d > d0 * THEATRE.neighbourMul && !finish) continue;
    const pos = world.hqPos(c.e.id);
    raw.push({ pos, bearing: headingTo(hq, pos), weight: (finish ? 2 : 1) / (1 + c.d / THEATRE.capitalScaleM), capital: true });
  }
  const clusters: { pos: V2; w: number }[] = [];
  const objs = world.objectives.filter((o) => (f.command.attackBias[o.id] ?? 0) >= THEATRE.clusterMinBias)
    .sort((a, b) => (f.command.attackBias[b.id] ?? 0) - (f.command.attackBias[a.id] ?? 0) || (a.id < b.id ? -1 : 1));
  for (const o of objs) {
    const b = f.command.attackBias[o.id] ?? 0;
    const c = clusters.find((x) => dist(x.pos, o.pos) < THEATRE.clusterM);
    if (c) c.w += b;
    else clusters.push({ pos: o.pos, w: b });
  }
  for (const c of clusters) raw.push({ pos: c.pos, bearing: headingTo(hq, c.pos), weight: THEATRE.clusterWeight * c.w, capital: false });
  raw.sort((a, b) => b.weight - a.weight);
  const kept: Axis[] = [];
  for (const a of raw) {
    const same = kept.find((k) => Math.abs(angleDiff(k.bearing, a.bearing)) < THEATRE.axisMergeRad);
    if (same) {
      same.weight += a.weight * 0.5;
      same.capital ||= a.capital;
    }
    else kept.push({ ...a });
  }
  return kept.sort((a, b) => b.weight - a.weight);
}

/**
 * Fronts the theatre needs (open more below it), 1 … fronts_max (THEATRE.troopsPerFront): one per
 * neighbouring enemy capital, the 2.0 rule (strong axes, one per `axisPer` troops) and, 2.1, one
 * per `perFront` troops — whichever asks for most.
 */
export function desiredFronts(world: World, axes: Axis[], troops: number, axisShare: number = THEATRE.axisMinShare, axisPer: number = THEATRE.unitsPerFront, perFront: number = THEATRE.troopsPerFront): number {
  const top = axes[0]?.weight ?? 0;
  const strong = axes.filter((a) => a.weight >= axisShare * top).length;
  const neighbours = Math.min(axes.filter((a) => a.capital).length, Math.floor(troops / THEATRE.neighbourTroops));
  const byAxes = Math.min(strong, Math.floor(troops / axisPer));
  const byArmy = Math.floor(troops / perFront);
  return Math.max(1, Math.min(world.data.rules.command.fronts_max, Math.max(neighbours, byAxes, byArmy)));
}

/** 2.1: AI fronts that garrison a fortified zone (binding defend order on the zone's line). */
const zoneGarrisons = new WeakSet<Front>();
export const garrisonsZone = (s: Front): boolean => zoneGarrisons.has(s);

/** Not in the middle of something a merge would break. */
function mergeable(world: World, f: Faction, s: Front): boolean {
  return !zoneGarrisons.has(s) && world.time - metaOf(world, s).createdAt >= THEATRE.minAgeS && !maneuvering(s) && s.opPhase !== 'assault'
    && !(s.op === 'siege' && s.opPhase !== '') && !isRecalled(f, s) && !defendingHome(s) && !counterStrikes.has(s) && !s.manualTarget;
}

/** At most one structural change; true if one was made. */
function restructure(world: World, f: Faction, combat: Map<number, Unit[]>): boolean {
  // 2.1: zone garrisons are counted apart (they hold a fixed line, not an axis).
  const field = f.fronts.filter((s) => !zoneGarrisons.has(s));
  const total = [...combat.values()].reduce((a, c) => a + c.length, 0);
  const axes = theatreAxes(world, f);
  const want = desiredFronts(world, axes, total);
  const floor = Math.min(world.data.rules.command.fronts_initial, Math.floor(total / THEATRE.floorUnitsPerFront));
  const keep = Math.max(floor, desiredFronts(world, axes, total, THEATRE.keepAxisShare, THEATRE.keepUnitsPerFront, THEATRE.keepTroopsPerFront));
  const value = (s: Front): number => sumValue(combat.get(s.id) ?? []);
  const nearestOther = (s: Front): Front | undefined => f.fronts.filter((x) => x !== s)
    .sort((a, b) => dist(a.targetPos, s.targetPos) - dist(b.targetPos, s.targetPos) || a.id - b.id)[0];
  // 1. Empty fronts dissolve.
  for (const s of f.fronts) {
    const m = metaOf(world, s);
    const into = nearestOther(s);
    if (into && m.emptySince >= 0 && world.time - m.emptySince >= THEATRE.emptyS && world.time - m.createdAt >= THEATRE.minAgeS && !isRecalled(f, s)) {
      dissolveFront(world, f, s, into);
      return true;
    }
  }
  // 2. Converged fronts merge (the smaller into the larger): same objective (or within mergeTargetM
  // of each other while above the kept count) and troops together.
  for (const a of f.fronts) {
    for (const b of f.fronts) {
      if (a.id >= b.id || !mergeable(world, f, a) || !mergeable(world, f, b)) continue;
      // (Fronts converging on an enemy capital stay apart: each is one axis of the siege / storm.)
      const same = a.targetObjective !== null && a.targetObjective === b.targetObjective;
      if (a.targetCity !== null || b.targetCity !== null) continue;
      if (field.length <= floor || (!same && (field.length <= keep || dist(a.targetPos, b.targetPos) > THEATRE.mergeTargetM))) continue;
      const ca = centroid(combat.get(a.id) ?? [], a.front);
      const cb = centroid(combat.get(b.id) ?? [], b.front);
      if (dist(ca, cb) > THEATRE.mergeCentroidM) continue;
      const [small, big] = value(a) < value(b) ? [a, b] : [b, a];
      dissolveFront(world, f, small, big);
      return true;
    }
  }
  // 3. More fronts than the army / axes justify: the weakest joins its nearest neighbour.
  if (field.length > keep && f.command.finishTarget < 0) {
    const weakest = f.fronts.filter((s) => mergeable(world, f, s)).sort((a, b) => value(a) - value(b) || a.id - b.id)[0];
    const into = weakest ? nearestOther(weakest) : undefined;
    if (weakest && into) {
      dissolveFront(world, f, weakest, into);
      return true;
    }
  }
  // 4. An uncovered axis gets a new front; 2.1: with all axes covered, a big enough army opens
  // an extra front on the HQ's best attack objective away from every other front.
  if (field.length < want) {
    const axis = axes.slice(0, want).find((a) => !covered(world, f, a));
    const obj = axis ? axisObjective(world, f, axis) : extraObjective(world, f);
    if (obj) {
      let free = 0;
      for (const u of world.units.values()) if (u.owner === f.id && transferable(u)) free++;
      const share = Math.floor(free / (f.fronts.length + 1));
      if (share >= THEATRE.newFrontFree && createFront(world, f, obj, share) !== null) return true;
    }
  }
  // 5. A finished fortified zone nobody holds gets a garrison front of its own.
  return garrisonZone(world, f);
}

/** 2.1 extra front: the open objective with the highest HQ attack bias ≥ extraSpacingM from every front's objective / line. */
function extraObjective(world: World, f: Faction): Objective | null {
  let best: Objective | null = null;
  let bestB = 0;
  for (const o of world.objectives) {
    const b = f.command.attackBias[o.id] ?? 0;
    if (o.owner === f.id || b <= bestB) continue;
    if (f.fronts.some((s) => dist(s.targetPos, o.pos) < THEATRE.extraSpacingM || dist(s.front, o.pos) < THEATRE.extraSpacingM)) continue;
    best = o;
    bestB = b;
  }
  return best;
}

/** Distance from `p` to the segment a–b. */
function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

const zoneCentre = (z: Zone): V2 => ({ x: (z.a.x + z.b.x) / 2, z: (z.a.z + z.b.z) / 2 });

/** A zone with at least one finished, standing pillbox / bunker of ours along its line. */
export function zoneManned(world: World, f: Faction, z: Zone): boolean {
  return world.forts.some((w) => w.owner === f.id && w.hp > 0 && w.progress >= 1 && isStructure(w.kind) && segDist(w.pos, z.a, z.b) < THEATRE.zoneStructM);
}

/** A front holds the zone: a line order (not attack) whose line passes within zoneHeldM of the zone's centre. */
function zoneHeld(f: Faction, z: Zone): boolean {
  const c = zoneCentre(z);
  return f.fronts.some((s) => !!s.line && s.order.kind !== 'attack' && segDist(c, s.line.a, s.line.b) < THEATRE.zoneHeldM);
}

/** Open a garrison front for the first finished, unheld zone (named after the nearest settlement). */
function garrisonZone(world: World, f: Faction): boolean {
  const rules = world.data.rules.command;
  if (f.fronts.length >= rules.fronts_max || f.command.finisher) return false;
  if (f.fronts.filter((s) => zoneGarrisons.has(s)).length >= THEATRE.zoneFrontsMax) return false;
  const z = f.zones.find((x) => !x.cancelled && !zoneHeld(f, x) && zoneManned(world, f, x));
  if (!z) return false;
  let squads = 0;
  for (const u of world.units.values()) if (u.owner === f.id && u.def.kind === 'infantry' && transferable(u)) squads++;
  if (squads < THEATRE.zoneMinSquads) return false;
  const c = zoneCentre(z);
  let obj: Objective | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    const d = dist(o.pos, c);
    if (d < bd) { bd = d; obj = o; }
  }
  if (!obj) return false;
  const s = createFront(world, f, obj, THEATRE.zoneTroops, c);
  if (!s) return false;
  zoneGarrisons.add(s);
  z.frontId = s.id;
  // A standing, binding order: the garrison keeps the line (no stance release, detachments or pushes).
  issueFrontOrder(world, f, s, { kind: 'defend', a: { ...z.a }, b: { ...z.b }, issuedAt: world.time, manual: true });
  s.name = obj.id;
  return true;
}

/** A garrison front whose zone was cancelled, lost or re-bound goes back to the field (merged later); a finisher releases them all. */
function upkeepZoneGarrisons(world: World, f: Faction): void {
  for (const s of f.fronts) {
    if (!zoneGarrisons.has(s)) continue;
    const z = f.zones.find((x) => x.frontId === s.id && !x.cancelled);
    if (z && zoneManned(world, f, z) && !f.command.finisher) continue;
    zoneGarrisons.delete(s);
    issueFrontOrder(world, f, s, order(world, 'auto', s.targetPos));
  }
}

function covered(world: World, f: Faction, a: Axis): boolean {
  const hq = world.hqPos(f.id);
  return f.fronts.some((s) => Math.abs(angleDiff(headingTo(hq, s.targetPos), a.bearing)) < THEATRE.coverRad
    || dist(s.targetPos, a.pos) < THEATRE.coverM || dist(s.front, a.pos) < THEATRE.coverM);
}

/** First objective of a new axis: the nearest place we do not hold inside its cone, else the place nearest the axis. */
function axisObjective(world: World, f: Faction, a: Axis): Objective | null {
  const hq = world.hqPos(f.id);
  const taken = new Set(f.fronts.map((s) => s.targetObjective));
  let best: Objective | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner === f.id || taken.has(o.id) || Math.abs(angleDiff(headingTo(hq, o.pos), a.bearing)) > THEATRE.coverRad) continue;
    const d = dist(o.pos, hq);
    if (d < bd) { bd = d; best = o; }
  }
  if (best) return best;
  for (const o of world.objectives) {
    const d = dist(o.pos, a.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// ---------------------------------------------------------------- orders

const order = (world: World, kind: FrontOrder['kind'], a: V2, b: V2 | null = null): FrontOrder =>
  ({ kind, a: { ...a }, b: b ? { ...b } : null, issuedAt: world.time, manual: false });

/** One order per front: stances (fall back / defend / fortify) first, else attack the commander's next objective. */
function orderFront(world: World, f: Faction, s: Front, combat: Unit[]): void {
  if (s.manualTarget || isRecalled(f, s) || defendingHome(s) || counterStrikes.has(s) || !f.fronts.includes(s)) return;
  // Round 7 (lead decision, wars must end): the finisher masses every front on the finish capital —
  // no stances, no other objectives — so the storm (storm.stormMass) counts the whole army.
  const fin = f.command.finishTarget;
  if (f.command.finisher && fin >= 0 && world.factions[fin]?.alive) {
    if (s.order.kind !== 'attack' || s.targetCity !== fin) issueFrontOrder(world, f, s, order(world, 'attack', world.hqPos(fin)));
    return;
  }
  const m = metaOf(world, s);
  const mine = sumValue(combat);
  const k = s.order.kind;
  if (k === 'fallBack' || k === 'defend' || k === 'fortify') {
    if (!holdStance(world, f, s, m, mine)) return;
  } else if (THEATRE_AB.stances && wantsFallBack(world, f, s, combat, mine)) {
    issueFrontOrder(world, f, s, order(world, 'fallBack', fallBackPoint(world, f, s)));
    m.stanceSince = world.time;
    m.calmSince = -1;
    world.note(f.id, 'log.frontFallBack', { point: s.name }, 'warn');
    return;
  } else {
    const threatened = THEATRE_AB.stances ? defendPoint(world, f, s, mine) : null;
    if (threatened) {
      issueFrontOrder(world, f, s, order(world, 'defend', threatened));
      m.stanceSince = world.time;
      m.calmSince = -1;
      return;
    }
    // 2.1: a freshly held town on a quiet stretch, an engineer at hand: fortify a line in front of it (a permanent zone).
    const site = THEATRE_AB.stances ? zoneSite(world, f, s, mine) : null;
    if (site) {
      issueFrontOrder(world, f, s, order(world, 'fortify', site));
      m.stanceSince = world.time;
      m.calmSince = -1;
      return;
    }
  }
  attackNext(world, f, s);
}

/** Attack the commander's next objective (1.x retarget cadence: ≥ retargetS, or the finish target now). */
function attackNext(world: World, f: Faction, s: Front): void {
  // A dead target capital is replaced at once (no manoeuvre or retarget cadence keeps it).
  const dead = deadCapital(world, s);
  if (!dead && maneuvering(s)) return;
  if (!dead && s.order.kind === 'attack' && world.time - s.lastRetarget <= THEATRE.retargetS && !finishNow(f, s)) return;
  const t = nextTarget(world, f, s);
  if (s.order.kind !== 'attack' || dist(t.pos, s.targetPos) > 1) issueFrontOrder(world, f, s, order(world, 'attack', t.pos));
}

/** A standing defend / fortify / fall-back order: false while it holds, true once it is released (then attack). */
function holdStance(world: World, f: Faction, s: Front, m: Meta, mine: number): boolean {
  const at = s.line ? { x: (s.line.a.x + s.line.b.x) / 2, z: (s.line.a.z + s.line.b.z) / 2 } : s.targetPos;
  const enemy = enemyNear(world, f.id, at, THEATRE.defendR);
  const since = world.time - m.stanceSince;
  if (enemy < mine * THEATRE.releaseRatio) {
    if (m.calmSince < 0) m.calmSince = world.time;
  } else m.calmSince = -1;
  if (since < THEATRE.stanceMinS) return false;
  if ((m.calmSince >= 0 && world.time - m.calmSince >= THEATRE.calmS) || (since >= THEATRE.stanceMaxS && enemy < mine)) {
    // 2.1: a quiet line with an engineer at hand is fortified for good before the front moves on.
    if (s.order.kind === 'defend' && s.line && dist(s.line.a, s.line.b) >= THEATRE.zoneMinLineM && wantsZone(world, f, lineCentre(s.line))) {
      issueFrontOrder(world, f, s, order(world, 'fortify', s.line.a, s.line.b));
      m.stanceSince = world.time;
      return false;
    }
    s.lastRetarget = -999;
    return true;
  }
  // Still pressed: a fall back becomes a defence of the new line; a long defence digs in.
  const line = s.line;
  if (line && s.order.kind === 'fallBack') issueFrontOrder(world, f, s, order(world, 'defend', line.a, line.b));
  else if (line && s.order.kind === 'defend' && since >= THEATRE.fortifyAfterS) issueFrontOrder(world, f, s, order(world, 'fortify', line.a, line.b));
  return false;
}

const lineCentre = (l: { a: V2; b: V2 }): V2 => ({ x: (l.a.x + l.b.x) / 2, z: (l.a.z + l.b.z) / 2 });

/** A place worth a permanent zone: a free engineer near, below the zone cap, no zone near. */
function wantsZone(world: World, f: Faction, c: V2): boolean {
  const live = f.zones.filter((z) => !z.cancelled);
  if (live.length >= THEATRE.zonesMax || live.some((z) => dist(zoneCentre(z), c) < THEATRE.zoneSpacingM)) return false;
  for (const u of world.units.values()) {
    if (u.owner === f.id && u.def.id === 'engineer' && u.hp > 0 && !u.manual && !u.routing && u.opRole === 'line' && dist(u.pos, c) < THEATRE.zoneEngineerM) return true;
  }
  return false;
}

/** The front's objective is an own, quiet town / city: a point (radius + zoneFrontPadM) toward the nearest enemy capital, if a zone is wanted there. */
function zoneSite(world: World, f: Faction, s: Front, mine: number): V2 | null {
  const o = world.objectives.find((x) => x.id === s.targetObjective);
  if (!o || o.owner !== f.id || o.contested || (o.kind !== 'town' && o.kind !== 'city') || mine <= 0) return null;
  if (enemyNear(world, f.id, o.pos, THEATRE.defendR) >= mine * THEATRE.releaseRatio) return null;
  let toward: V2 | null = null;
  let bd = Infinity;
  for (const e of world.factions) {
    if (!e.alive || !world.isHostile(f.id, e.id)) continue;
    const d = dist(world.hqPos(e.id), o.pos);
    if (d < bd) { bd = d; toward = world.hqPos(e.id); }
  }
  if (!toward) return null;
  const h = headingTo(o.pos, toward);
  const p = { x: o.pos.x + Math.cos(h) * (o.radius + THEATRE.zoneFrontPadM), z: o.pos.z + Math.sin(h) * (o.radius + THEATRE.zoneFrontPadM) };
  const q = world.nav(false, 35).nearestPassable(p, 40);
  return q && wantsZone(world, f, q) ? q : null;
}

function wantsFallBack(world: World, f: Faction, s: Front, combat: Unit[], mine: number): boolean {
  if (combat.length < 4 || f.command.finisher || (s.op === 'siege' && s.opPhase !== '') || s.opPhase === 'assault') return false;
  if (dist(s.front, world.hqPos(f.id)) < THEATRE.fallBackMinHomeM) return false;
  const routed = combat.filter((u) => u.routing).length / combat.length;
  return routed >= THEATRE.fallBackRouted || enemyNear(world, f.id, s.front, 400) > mine * THEATRE.fallBackOutmatch;
}

/** Nearest own uncontested town / city at least fallBackStepM nearer home than the front, else a point that far back. */
function fallBackPoint(world: World, f: Faction, s: Front): V2 {
  const hq = world.hqPos(f.id);
  const df = dist(s.front, hq);
  let best: V2 | null = null;
  let bd = Infinity;
  for (const o of world.objectives) {
    if (o.owner !== f.id || o.contested || (o.kind !== 'town' && o.kind !== 'city')) continue;
    if (dist(o.pos, hq) > df - THEATRE.fallBackStepM) continue;
    const d = dist(o.pos, s.front);
    if (d < bd) { bd = d; best = o.pos; }
  }
  if (best) return best;
  const t = THEATRE.fallBackStepM / Math.max(1, df);
  const p = { x: s.front.x + (hq.x - s.front.x) * t, z: s.front.z + (hq.z - s.front.z) * t };
  return world.nav(false, 35).nearestPassable(p, 60) ?? p;
}

/** A freshly held town / city target under real threat: defend a line in front of it (toward the threat). */
function defendPoint(world: World, f: Faction, s: Front, mine: number): V2 | null {
  const o = world.objectives.find((x) => x.id === s.targetObjective);
  if (!o || o.owner !== f.id || (o.kind !== 'town' && o.kind !== 'city') || mine <= 0) return null;
  let sx = 0;
  let sz = 0;
  let v = 0;
  for (const u of world.spatial.queryOwners(o.pos.x, o.pos.z, THEATRE.defendR, hostileMask(world, f.id))) {
    if (u.hp <= 0 || !world.knows(f.id, u) || u.fixed || isCommander(u.def)) continue;
    const w = valueOf(u);
    v += w;
    sx += u.pos.x * w;
    sz += u.pos.z * w;
  }
  if (v < mine * THEATRE.defendThreat) return null;
  const toward = headingTo(o.pos, { x: sx / v, z: sz / v });
  const p = { x: o.pos.x + Math.cos(toward) * (o.radius + 30), z: o.pos.z + Math.sin(toward) * (o.radius + 30) };
  return world.nav(false, 35).nearestPassable(p, 40) ?? o.pos;
}

// ---------------------------------------------------------------- counter-strike

/**
 * All-in rush answer (user: "I just let all units attack the capital, then it wins"): an enemy
 * with most of its army at our capital has left its own nearly empty. The strongest front that can
 * reach that capital with ≥ csRatio × its defence goes for it while home defence handles the rush.
 */
function counterStrike(world: World, f: Faction, combat: Map<number, Unit[]>): void {
  const cur = f.fronts.find((s) => counterStrikes.has(s));
  if (cur) {
    const city = cur.targetCity;
    const done = city === null || !world.factions[city]?.alive || cur.manualTarget;
    const held = city !== null && world.time - metaOf(world, cur).stanceSince >= THEATRE.csKeepS
      && capitalDefence(world, f.id, city) * THEATRE.csRatio > sumValue(combat.get(cur.id) ?? []);
    if (done || held) {
      counterStrikes.delete(cur);
      cur.lastRetarget = -999;
    }
    return;
  }
  if (!stormOn() || f.command.finisher) return;
  const target = committedEnemy(world, f);
  if (target < 0) return;
  const hqE = world.hqPos(target);
  const defence = capitalDefence(world, f.id, target);
  let best: Front | null = null;
  let bestScore = 0;
  for (const s of f.fronts) {
    const c = combat.get(s.id) ?? [];
    const v = sumValue(c);
    if (c.length < THEATRE.csMinUnits || v < defence * THEATRE.csRatio || isRecalled(f, s) || defendingHome(s) || s.manualTarget) continue;
    const d = dist(centroid(c, s.front), hqE);
    if (d > THEATRE.csReachM) continue;
    const score = v / (1 + d / 1000);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (!best) return;
  issueFrontOrder(world, f, best, order(world, 'attack', hqE));
  counterStrikes.add(best);
  metaOf(world, best).stanceSince = world.time;
  world.note(f.id, 'log.counterStrike', { point: best.name }, 'info');
}

/**
 * A hostile faction with ≥ csCommitted of its known army at our capital and its own capital held
 * by ≤ csArmyShare of it (-1 = none). The most committed wins. (Round 6 lab: also striking enemies
 * committed against a third party's capital turned every mid-game siege into a counter-strike
 * cascade — op success 25 → 12 %, no eliminations in 3 × 30 min.)
 */
function committedEnemy(world: World, f: Faction): number {
  const caps = [{ id: f.id, pos: world.hqPos(f.id) }];
  const army = new Map<number, number>();
  const near = new Map<number, number>();
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed || u.owner === f.id || isCommander(u.def) || u.def.id === 'supply_truck') continue;
    if (!world.isHostile(f.id, u.owner) || !world.knows(f.id, u)) continue;
    const v = valueOf(u);
    army.set(u.owner, (army.get(u.owner) ?? 0) + v);
    if (caps.some((c) => c.id !== u.owner && dist(u.pos, c.pos) < THEATRE.csNearM)) near.set(u.owner, (near.get(u.owner) ?? 0) + v);
  }
  let best = -1;
  let bestNear: number = HOME.minThreat;
  const ht = f.command.homeThreat;
  const share = ROUND7_AB.counter && (ht.active || ht.breach) ? THEATRE.csCommittedAttacked : THEATRE.csCommitted;
  for (const [id, total] of army) {
    const n = near.get(id) ?? 0;
    if (n < total * share || n < bestNear) continue;
    if (capitalDefence(world, f.id, id) > total * THEATRE.csArmyShare) continue;
    best = id;
    bestNear = n;
  }
  return best;
}
