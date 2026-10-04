import type { Faction, Front } from './types';

/**
 * Front lookup by stable id (docs/COMMAND_V2.md). Fronts are created, merged and dissolved during
 * a match (theatre.ts), so a front's id is NOT its index in `f.fronts`; every consumer looks fronts
 * up through here. Leaf module (types only) so low-level systems can use it without import cycles.
 */
export const frontById = (f: Faction, id: number): Front | undefined =>
  f.fronts[id]?.id === id ? f.fronts[id] : f.fronts.find((s) => s.id === id);

/** The unit's front, or the faction's first front for a stale id (dissolved front, until reassigned). */
export const frontOf = (f: Faction, id: number): Front | undefined => frontById(f, id) ?? f.fronts[0];

/**
 * Fronts sent by the AI supreme HQ against an enemy capital emptied by an all-in attack on ours
 * (theatre.counterStrike). Home-defence recall takes them last (homeguard.recall).
 */
export const counterStrikes = new WeakSet<Front>();
