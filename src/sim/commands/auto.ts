import { stopAutoResearch } from '../upgrades';
import type { Command, CommandOutcome } from '../commands';
import type { Faction } from '../types';
import { OK, fail } from './shared';

type C<T extends Command['type']> = Extract<Command, { type: T }>;

/**
 * 3.0.1 auto toggles (斗蛐蛐: the player may just watch). Each hands one 3.0 system to the HQ staff
 * (on, the default) or takes it over (off), like 2.2.1's `setAutoInvest`. Booleans only.
 */
export function applySetAutoResearch(f: Faction, c: C<'setAutoResearch'>): CommandOutcome {
  if (typeof c.on !== 'boolean') return fail('BAD_VALUE');
  f.autoResearch = c.on;
  if (!c.on) stopAutoResearch(f);
  return OK;
}

export function applySetAutoEngineering(f: Faction, c: C<'setAutoEngineering'>): CommandOutcome {
  if (typeof c.on !== 'boolean') return fail('BAD_VALUE');
  f.autoEngineering = c.on;
  return OK;
}

/** On: the HQ takes the directive back at once (a manual directive in force stops pausing it). */
export function applySetAutoCommand(f: Faction, c: C<'setAutoCommand'>): CommandOutcome {
  if (typeof c.on !== 'boolean') return fail('BAD_VALUE');
  f.autoCommand = c.on;
  if (c.on && f.directive.manual) f.directive = { ...f.directive, manual: false, forced: false };
  return OK;
}
