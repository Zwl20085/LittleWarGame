import type { DoctrineProfileRules } from '../data/doctrineRules';
import { Rng } from './rng';
import type { DoctrineId, Faction } from './types';
import type { World } from './world';

/**
 * 3.0 AI doctrines — 作战风格 (docs/V30_SPEC.md §1, docs/DOCTRINES.md). Every faction has a
 * doctrine; an AI faction's doctrine profile (rules.json `doctrines.profiles`) scales the levers the
 * existing AI already reads — no parallel AI:
 *
 * | lever | read in |
 * |---|---|
 * | production mix / caps | cityai.thinkCity, sim.makeFaction |
 * | investment appetite | econai.thinkInvestment |
 * | occupation detachments | command.assignOccupations |
 * | directive (defend / fortify / contract thresholds, the doctrine offensive) | directive.chooseDirective → doctrineai.ts |
 * | damaged units leave the line | behavior.needsRetreat |
 * | raid cadence and targets | econwar.planEconRaids, operations.planOperations |
 * | troops per front (density) | frontTiers.scaleFronts |
 * | compliance temperament | compliance.complianceOf |
 * | main-effort reinforcement share, armour on the main front | cityai.balanceReserves, armour.armourFront |
 *
 * The player's faction carries a doctrine too (Quick Battle draws one for every slot so a 4-FFA
 * spectate shows all four; the music uses it) but is never steered by it.
 */
export type { DoctrineId } from './types';
export type DoctrineProfile = DoctrineProfileRules;

export const DOCTRINE_IDS: readonly DoctrineId[] = ['builder', 'blitz', 'attrition', 'maneuver'];

/** Lab switch (A/B): doctrine effects on / off (rules `doctrines.enabled` is the default). */
export const DOCTRINE_AB = { on: true };

export const isDoctrineId = (x: unknown): x is DoctrineId => typeof x === 'string' && (DOCTRINE_IDS as readonly string[]).includes(x);

export function doctrinesOn(world: World): boolean {
  const d = world.data.rules.doctrines;
  return DOCTRINE_AB.on && !!d && d.enabled;
}

/** The profile steering faction `f` (null: the player, doctrines off, or a rules file without doctrines). */
export function profileOf(world: World, f: Faction | undefined): DoctrineProfile | null {
  if (!f || f.isPlayer || !doctrinesOn(world)) return null;
  return world.data.rules.doctrines?.profiles[f.doctrine] ?? null;
}

/** The profile of a doctrine id regardless of who holds it (UI, production presets). */
export function profileById(world: World, id: DoctrineId): DoctrineProfile | null {
  return world.data.rules.doctrines?.profiles[id] ?? null;
}

/**
 * Doctrine per faction slot: explicit choices stand; every other slot ('random' / absent) draws from
 * a seed-shuffled deck of the four doctrines not chosen explicitly (all different while they last,
 * then the deck is reused in order). Deterministic per seed.
 */
export function assignDoctrines(seed: number, n: number, choices?: readonly (DoctrineId | 'random' | undefined)[]): DoctrineId[] {
  const rng = new Rng((seed ^ 0x0d0c7e1a) | 0);
  const deck = [...DOCTRINE_IDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const fixed = Array.from({ length: n }, (_, i) => choices?.[i]).map((c) => (isDoctrineId(c) ? c : null));
  const free = deck.filter((d) => !fixed.includes(d));
  const pool = free.length > 0 ? free : deck;
  let k = 0;
  return fixed.map((c) => c ?? pool[k++ % pool.length]);
}

// ---------------------------------------------------------------- levers (neutral = 1 / the 2.2 value)

/** Investment appetite multiplier (econai.ts). */
export const investWeight = (world: World, f: Faction): number => profileOf(world, f)?.invest ?? 1;

/** Per-faction "the enemy army is broken" flag, refreshed by doctrineai every HQ think. */
const brokenEnemy = new WeakMap<Faction, boolean>();
export const setEnemyBroken = (f: Faction, v: boolean): void => { brokenEnemy.set(f, v); };

/** Occupation detachments multiplier (command.ts); maneuver cares for towns only once the enemy army is broken. */
export function occupyWeight(world: World, f: Faction): number {
  const p = profileOf(world, f);
  if (!p) return 1;
  return brokenEnemy.get(f) ? p.occupy_broken : p.occupy;
}

/** HP share at which a damaged unit of `owner` leaves the line (null = the rules default). */
export function retreatHp(world: World, owner: number): number | null {
  return profileOf(world, world.factions[owner])?.retreat_hp ?? null;
}

export type RaidKind = 'econ' | 'convoy' | 'rail' | 'zone';

/** Multiplier on a raid interval (1 = 2.2 cadence; Infinity = this doctrine never raids that target kind). */
export function raidIntervalMul(world: World, f: Faction, kind: RaidKind): number {
  const p = profileOf(world, f);
  if (!p) return 1;
  const w = p.raid_rate * p.raid_targets[kind];
  return w > 0 ? 1 / w : Infinity;
}

/** Raids go on under defend / fortify (attrition interdicts while it holds). */
export const raidsOnDefence = (world: World, f: Faction): boolean => profileOf(world, f)?.raid_on_defence ?? false;

/** Troops-per-front multiplier (> 1: fewer, denser fronts; frontTiers.scaleFronts). */
export const frontDensity = (world: World, f: Faction): number => profileOf(world, f)?.front_density ?? 1;

/** Seam for WP-E (infiltration pickets): picket spacing multiplier (< 1 = denser pickets). */
export const picketGapMul = (world: World, f: Faction): number => 1 / frontDensity(world, f);

/** Compliance temperament bias (compliance.ts). */
export const temperamentBias = (world: World, f: Faction): number => profileOf(world, f)?.temperament ?? 0;

/** Main-effort reinforcement share multiplier (cityai.balanceReserves). */
export const mainShareMul = (world: World, f: Faction): number => profileOf(world, f)?.main_share ?? 1;

/** Share of the tanks the main front may hold under advance (armour.armourFront). */
export const armourMainShare = (world: World, f: Faction, dflt: number): number => profileOf(world, f)?.armour_main_share ?? dflt;

/** Seam for WP-H (unit upgrades): the order in which this AI buys upgrades. */
export const upgradePriorities = (world: World, f: Faction): readonly string[] => profileOf(world, f)?.upgrades ?? [];

/** Production weights × the doctrine's multipliers (cityai.thinkCity; returns a new record). */
export function doctrineWeights(world: World, f: Faction, base: Readonly<Record<string, number>>): Record<string, number> {
  const p = profileOf(world, f);
  if (!p) return { ...base };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) out[k] = Math.round(v * (p.production[k] ?? 1) * 10) / 10;
  return out;
}

/** Unit caps × the doctrine's multipliers (sim.makeFaction; returns a new record). */
export function doctrineCaps(world: World, f: Pick<Faction, 'isPlayer' | 'doctrine'>, base: Readonly<Record<string, number>>): Record<string, number> {
  const p = f.isPlayer || !doctrinesOn(world) ? null : world.data.rules.doctrines?.profiles[f.doctrine];
  if (!p) return { ...base };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) out[k] = Math.max(0, Math.round(v * (p.caps[k] ?? 1)));
  return out;
}

// ---------------------------------------------------------------- discovery (HUD)

/** First battle between two factions (events.noteHit): both remember the time. */
export function markContact(world: World, a: number, b: number): void {
  const fa = world.factions[a];
  const fb = world.factions[b];
  if (!fa || !fb || a === b) return;
  if ((fa.contactAt[b] ?? -1) < 0) fa.contactAt[b] = world.time;
  if ((fb.contactAt[a] ?? -1) < 0) fb.contactAt[a] = world.time;
}

/** Does `viewer` know `target`'s doctrine (after the first battle with it, or after reveal_s)? */
export function doctrineKnown(world: World, viewer: number, target: number): boolean {
  if (viewer === target) return true;
  const reveal = world.data.rules.doctrines?.reveal_s ?? 300;
  return world.time >= reveal || (world.factions[viewer]?.contactAt[target] ?? -1) >= 0;
}
