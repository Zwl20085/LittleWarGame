import type { Faction, Front } from './types';

/**
 * Front lookup by stable id (docs/COMMAND_V2.md). Fronts are created, merged and dissolved during
 * a match (theatre.ts), so a front's id is NOT its index in `f.fronts`; every consumer looks fronts
 * up through here. Leaf module (types only) so low-level systems can use it without import cycles.
 */
const indexes = new WeakMap<readonly Front[], Map<number, Front>>();
export const frontById = (f: Faction, id: number): Front | undefined => {
  if (f.fronts[id]?.id === id) return f.fronts[id];
  // 3.0 (unlimited fronts): an id map cached per `f.fronts` array (replaced on every change, never spliced).
  let m = indexes.get(f.fronts);
  if (!m) {
    m = new Map(f.fronts.map((s) => [s.id, s]));
    indexes.set(f.fronts, m);
  }
  return m.get(id);
};

/** The unit's front, or the faction's first front for a stale id (dissolved front, until reassigned). */
export const frontOf = (f: Faction, id: number): Front | undefined => frontById(f, id) ?? f.fronts[0];

/**
 * 2.1 binding orders (user: "最高统帅部的指挥命令为强约束"): a manual (player) order other than
 * `auto` binds its front — no detachments (town garrisons, occupations, raids, rear guard) are drawn
 * from it, and the commander's own initiative is limited to the order's intent (COMMAND_V2 §3).
 * The capital's standing garrison and HQ-point squads are exempt (homeguard, user rule 8).
 */
export const boundOrder = (s: Front): boolean => s.order.manual && s.order.kind !== 'auto';

/** A binding line order (defend / fortify / fall back): every unit holds the ordered line. */
export const boundLine = (s: Front): boolean => boundOrder(s) && s.order.kind !== 'attack';

/**
 * 2.2: may the HQ draw town garrisons from this front? Not from a binding order — except under the
 * Contract directive, whose fronts give up exposed ground and garrison the towns they keep.
 */
export const lendsGarrisons = (f: Faction, s: Front): boolean => !boundOrder(s) || f.directive.kind === 'contract';

/** Is unit `u` (front id `frontId`) on a front with a binding order? */
export const onBoundFront = (f: Faction, frontId: number): boolean => {
  const s = frontById(f, frontId);
  return !!s && boundOrder(s);
};

/**
 * Fronts sent by the AI supreme HQ against an enemy capital emptied by an all-in attack on ours
 * (theatre.counterStrike). Home-defence recall takes them last (homeguard.recall).
 */
export const counterStrikes = new WeakSet<Front>();
