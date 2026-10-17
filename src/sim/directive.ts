import { isCommander } from './formulas';
import { addZoneLine } from './fronts';
import { doctrineDirective } from './doctrineai';
import type { Directive, DirectiveKind, Faction } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 supreme-HQ directive (docs/V22_SPEC.md §1): one universal command per faction. The player
 * issues it through the command bus (`setDirective`); the AI supreme HQ chooses it here from its
 * strategic state and applies it through the same function, so both sides are symmetric. The front
 * commanders answer it in frontresponse.ts.
 */
export const DIRECTIVE_KINDS: readonly DirectiveKind[] = ['offensive', 'advance', 'defend', 'fortify', 'contract'];

/** Shortest drawn fortify line (works are laid every ~55 m; fronts.addZone needs ≥ 60 m). */
export const DIRECTIVE_LINE_MIN_M = 60;

export const initialDirective = (manual: boolean): Directive => ({ kind: 'advance', axis: null, line: null, issuedAt: 0, manual });

/**
 * Set a faction's directive (validated input). A drawn fortify line becomes a permanent fortified
 * zone at once (held by the front nearest it). The caller applies the fronts' responses.
 */
export function setDirective(world: World, f: Faction, kind: DirectiveKind, axis: V2 | null, line: { a: V2; b: V2 } | null, manual: boolean, forced = false): void {
  f.directive = { kind, axis: axis ? { ...axis } : null, line: line ? { a: { ...line.a }, b: { ...line.b } } : null, issuedAt: world.time, manual, forced: manual && forced };
  if (line) addZoneLine(world, f, line.a, line.b);
  world.note(f.id, `log.directive.${kind}`, {}, 'info');
  // 3.0: an insisted (forced) directive is obeyed at once by every front (compliance.ts).
  if (manual && forced) world.note(f.id, 'log.directiveForced', {}, 'warn');
}

/** AI directive choice (lab-tunable). */
export const AI_DIRECTIVE = {
  /** A directive stands at least this long (no flip-flopping), except for the finisher. */
  keepS: 60,
  /** Defend when our army is below defendBelow × the strongest known hostile army; back to advance above defendExit. */
  defendBelow: 0.35,
  defendExit: 0.55,
} as const;

/** Our army value ÷ the strongest known hostile army (∞ when none is known). */
function armyRatio(world: World, f: Faction): number {
  let mine = 0;
  const theirs = new Map<number, number>();
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || isCommander(u.def)) continue;
    const v = u.def.costP + u.def.costM;
    if (u.owner === f.id) mine += v;
    else if (world.isHostile(f.id, u.owner) && world.knows(f.id, u)) theirs.set(u.owner, (theirs.get(u.owner) ?? 0) + v);
  }
  const top = Math.max(0, ...theirs.values());
  return top > 0 ? mine / top : Infinity;
}

/**
 * The AI supreme HQ's directive (every HQ think): the finisher's capital offensive (Round 7: every
 * front masses on the finish capital), a general defence when clearly outmatched, else the 2.1
 * free advance. Applied through `setDirective`, like the player's.
 */
export function chooseDirective(world: World, f: Faction): boolean {
  if (f.isPlayer || !f.alive) return false;
  const cur = f.directive;
  const fin = f.command.finishTarget;
  let kind: DirectiveKind = 'advance';
  let axis: V2 | null = null;
  if (f.command.finisher && fin >= 0 && world.factions[fin]?.alive) {
    kind = 'offensive';
    axis = world.hqPos(fin);
  } else {
    // 3.0: the doctrine decides (doctrineai.ts); without one, the 2.2 rule.
    const d = doctrineDirective(world, f);
    if (d) {
      kind = d.kind;
      axis = d.axis;
    } else {
      const r = armyRatio(world, f);
      if (r < AI_DIRECTIVE.defendBelow || (cur.kind === 'defend' && r < AI_DIRECTIVE.defendExit)) kind = 'defend';
    }
  }
  const same = cur.kind === kind && ((cur.axis === null && axis === null) || (!!cur.axis && !!axis && dist(cur.axis, axis) < 1));
  if (same) return false;
  const finisherSwitch = kind === 'offensive' || cur.kind === 'offensive';
  if (!finisherSwitch && world.time - cur.issuedAt < AI_DIRECTIVE.keepS && cur.issuedAt > 0) return false;
  setDirective(world, f, kind, axis, null, false);
  return true;
}
