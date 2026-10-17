import type { FrontRules } from '../data/frontRules';
import { isCommander } from './formulas';
import { frontById as frontIndexed } from './frontref';
import { hostileMask } from './spatial';
import type { Faction, Front, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 front scale (docs/V30_SPEC.md §5, WP-B): why the supreme HQ wants more and larger fronts.
 * A front's *command tier* follows its combat units (rules.json `fronts.tiers`: ≥ 12 / 24 / 40):
 * its batteries share one barrage target, its units lose less morale and shoot straighter, and it
 * gets a larger weight on the supply and reinforcement allocation. A front with too few units for
 * its stretch of the front line is *stretched* (accuracy / morale penalty). Tiers are refreshed
 * every front think (fronts.thinkFronts → `updateFrontTier`) and read per shot / per hit through an
 * O(1) front index, so nothing here is O(units × fronts) per tick.
 */

/** Lab switch (A/B): tiers and their effects on / off (rules `fronts.tiers_enabled` is the default). */
export const FRONT_TIERS_AB = { on: true };

const rulesOf = (world: World): FrontRules => world.data.rules.fronts;
const tiersOn = (world: World): boolean => FRONT_TIERS_AB.on && rulesOf(world).tiers_enabled;

/** Fighting units of a front (no commander, no trucks). */
export const combatCount = (units: readonly Unit[]): number => {
  let n = 0;
  for (const u of units) if (!isCommander(u.def) && u.def.id !== 'supply_truck') n++;
  return n;
};

/** Tier for `n` units, kept down to min_units − hysteresis_units once reached (no flicker at the threshold). */
export function tierFor(rules: FrontRules, n: number, cur: number): number {
  let t = 0;
  for (let k = 0; k < rules.tiers.length; k++) {
    const min = rules.tiers[k].min_units - (cur > k ? rules.hysteresis_units : 0);
    if (n >= min) t = k + 1;
  }
  return t;
}

/** Length of a front's stretch of the line: its ordered line, else its angle-ordered front cells (gaps > 48 m skipped). */
export function lineLength(s: Front): number {
  if (s.line) return dist(s.line.a, s.line.b);
  let len = 0;
  for (let i = 1; i < s.segment.length; i++) {
    const d = dist(s.segment[i - 1], s.segment[i]);
    if (d <= 48) len += d;
  }
  return len;
}

/** Densest known enemy concentration within barrage_search_m of the front (60 m bins), or null. */
function barragePoint(world: World, f: Faction, s: Front): V2 | null {
  const r = rulesOf(world).barrage_search_m;
  const bins = new Map<number, { x: number; z: number; v: number }>();
  let best: { x: number; z: number; v: number } | null = null;
  for (const u of world.spatial.queryOwners(s.front.x, s.front.z, r, hostileMask(world, f.id))) {
    if (u.hp <= 0 || !world.knows(f.id, u) || isCommander(u.def)) continue;
    const k = Math.floor(u.pos.x / 60) * 4096 + Math.floor(u.pos.z / 60);
    const w = u.def.costP + u.def.costM;
    const b = bins.get(k) ?? { x: 0, z: 0, v: 0 };
    b.x += u.pos.x * w;
    b.z += u.pos.z * w;
    b.v += w;
    bins.set(k, b);
    if (!best || b.v > best.v) best = b;
  }
  return best && best.v > 0 ? { x: best.x / best.v, z: best.z / best.v } : null;
}

/** Refresh a front's tier, stretched flag and barrage point (every front think, from its units). */
export function updateFrontTier(world: World, f: Faction, s: Front, units: readonly Unit[]): void {
  const rules = rulesOf(world);
  if (!tiersOn(world)) {
    s.tier = 0;
    s.stretched = false;
    s.barrage = null;
    return;
  }
  const n = combatCount(units);
  const tier = tierFor(rules, n, s.tier);
  if (tier > s.tier && tier >= 2) world.note(f.id, 'log.frontTierUp', { point: s.name, tier }, 'info');
  s.tier = tier;
  const len = lineLength(s);
  s.stretched = len >= rules.stretched_min_line_m && n / (len / 100) < rules.stretched_units_per_100m;
  s.barrage = tier >= 1 && units.some((u) => u.def.id === 'howitzer' || u.def.id === 'mortar') ? barragePoint(world, f, s) : null;
}

function unitFront(world: World, u: Unit): Front | undefined {
  const f = world.factions[u.owner];
  return f ? frontIndexed(f, u.frontId) : undefined;
}

/** Hit-probability multiplier from the shooter's front (tier bonus, stretched penalty). */
export function frontAccuracyMul(world: World, u: Unit): number {
  if (!tiersOn(world) || u.fixed) return 1;
  const s = unitFront(world, u);
  if (!s) return 1;
  const r = rulesOf(world);
  return 1 + (s.tier > 0 ? r.tiers[s.tier - 1].accuracy : 0) - (s.stretched ? r.stretched_accuracy : 0);
}

/** Morale-loss multiplier from the unit's front (tier bonus, stretched penalty). */
export function frontMoraleLossMul(world: World, u: Unit): number {
  if (!tiersOn(world) || u.fixed) return 1;
  const s = unitFront(world, u);
  if (!s) return 1;
  const r = rulesOf(world);
  return Math.max(0, 1 - (s.tier > 0 ? r.tiers[s.tier - 1].morale : 0) + (s.stretched ? r.stretched_morale : 0));
}

/** Supply-allocation weight of a front (supply.ts). */
export function frontSupplyWeight(world: World, f: Faction, frontId: number): number {
  if (!tiersOn(world)) return 1;
  const s = frontIndexed(f, frontId);
  return s && s.tier > 0 ? rulesOf(world).tiers[s.tier - 1].supply_weight : 1;
}

/** Reinforcement-share weight of a front (cityai.balanceReserves). */
export function frontReinforceWeight(world: World, s: Front): number {
  if (!tiersOn(world) || s.tier <= 0) return 1;
  return rulesOf(world).tiers[s.tier - 1].reinforce_weight;
}

/** Coordinated artillery: the barrage point of the gun's front (null below tier 1). */
export function barrageFocus(world: World, u: Unit): V2 | null {
  if (!tiersOn(world)) return null;
  return unitFront(world, u)?.barrage ?? null;
}

/** Target-score bonus for an indirect weapon whose candidate lies at its front's barrage point. */
export function barrageBonus(world: World, focus: V2 | null, t: Unit): number {
  if (!focus) return 0;
  const r = rulesOf(world);
  return dist(t.pos, focus) <= r.barrage_radius_m ? r.barrage_bonus : 0;
}

// ---------------------------------------------------------------- theatre helpers

/** Total front line held by the faction's fronts (sum of their stretches, m). */
export function frontage(f: Faction): number {
  let len = 0;
  for (const s of f.fronts) len += lineLength(s);
  return len;
}

/**
 * Fronts the army and the frontage justify (3.0): one per units_per_front troops and one per
 * frontage_m_per_front of line, never more than the troops can make tier-1 fronts of. `slack`
 * > 1 is the keep (merge) side of the hysteresis.
 */
export function scaleFronts(world: World, f: Faction, troops: number, slack = 1): number {
  const r = rulesOf(world);
  const byArmy = Math.floor((troops * slack) / r.units_per_front);
  const byLine = Math.floor((frontage(f) * slack) / r.frontage_m_per_front);
  const tier1 = r.tiers[0]?.min_units ?? r.units_per_front;
  return Math.min(Math.max(byArmy, byLine), Math.floor((troops * slack) / tier1));
}

/**
 * Free line troops away from their own front (> stray_m from its line and centre, not at home):
 * the densest cluster (stray_cell_m bins with their neighbours) if it would make a tier-1 front.
 */
export function strayCluster(world: World, f: Faction, groups: ReadonlyMap<number, Unit[]>, free: (u: Unit) => boolean): { pos: V2; n: number } | null {
  const r = rulesOf(world);
  const tier1 = r.tiers[0]?.min_units ?? r.units_per_front;
  const hq = world.hqPos(f.id);
  const cell = r.stray_cell_m;
  const bins = new Map<number, { x: number; z: number; n: number; i: number; j: number }>();
  for (const s of f.fronts) {
    for (const u of groups.get(s.id) ?? []) {
      if (!free(u) || u.behavior === 'rally' || dist(u.pos, hq) < r.stray_m || dist(u.pos, s.front) < r.stray_m || dist(u.pos, s.targetPos) < r.stray_m) continue;
      const i = Math.floor(u.pos.x / cell);
      const j = Math.floor(u.pos.z / cell);
      const k = i * 4096 + j;
      const b = bins.get(k) ?? { x: 0, z: 0, n: 0, i, j };
      b.x += u.pos.x;
      b.z += u.pos.z;
      b.n++;
      bins.set(k, b);
    }
  }
  let best: { pos: V2; n: number } | null = null;
  for (const b of bins.values()) {
    let n = 0;
    let x = 0;
    let z = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const o = bins.get((b.i + di) * 4096 + b.j + dj);
        if (o) { n += o.n; x += o.x; z += o.z; }
      }
    }
    if (n >= tier1 && (!best || n > best.n)) best = { pos: { x: x / n, z: z / n }, n };
  }
  return best;
}
