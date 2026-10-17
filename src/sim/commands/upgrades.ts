import { cancelResearch, startResearch } from '../upgrades';
import type { Command, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import type { Faction } from '../types';
import { OK, fail } from './shared';

export function applyResearch(match: Match, f: Faction, c: Extract<Command, { type: 'research' }>): CommandOutcome {
  const r = startResearch(match.world, f, c.upgradeId);
  return r === null ? OK : fail(r);
}

export function applyCancelResearch(match: Match, f: Faction): CommandOutcome {
  return cancelResearch(match.world, f) ? OK : fail('NO_RESEARCH');
}
