// Challenge strategy registry: add a module here to make it available to --strategy / --all.
import type { Strategy } from '../types';
import { aiOnly } from './aiOnly';
import { armourRaid } from './armourRaid';
import { backdoor } from './backdoor';
import { doctrineAttrition, doctrineBlitz, doctrineBuilder, doctrineManeuver } from './doctrine';
import { econWar } from './econWar';
import { feint } from './feint';
import { humanLike } from './humanLike';
import { lateBlitz } from './lateBlitz';
import { raid } from './raid';
import { rush } from './rush';
import { rushMicro } from './rushMicro';
import { shadowStrike } from './shadowStrike';
import { siege } from './siege';
import { turtle } from './turtle';
import { twoAxis } from './twoAxis';

export const STRATEGIES: readonly Strategy[] = [rush, turtle, twoAxis, raid, lateBlitz, humanLike, rushMicro, armourRaid, shadowStrike, backdoor, feint, econWar, siege, aiOnly,
  doctrineBuilder, doctrineBlitz, doctrineAttrition, doctrineManeuver];

/** Strategies that take `--variant` values, and the variants `--suite diversity` runs. */
export const SUITE_VARIANTS: Readonly<Record<string, readonly string[]>> = { armour_raid: ['15-direct', '15-flank', '25-direct', '25-flank'] };

export function strategyById(id: string): Strategy {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy "${id}" (have: ${STRATEGIES.map((x) => x.id).join(', ')})`);
  return s;
}
