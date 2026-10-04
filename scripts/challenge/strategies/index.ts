// Challenge strategy registry: add a module here to make it available to --strategy / --all.
import type { Strategy } from '../types';
import { humanLike } from './humanLike';
import { lateBlitz } from './lateBlitz';
import { raid } from './raid';
import { rush } from './rush';
import { rushMicro } from './rushMicro';
import { turtle } from './turtle';
import { twoAxis } from './twoAxis';

export const STRATEGIES: readonly Strategy[] = [rush, turtle, twoAxis, raid, lateBlitz, humanLike, rushMicro];

export function strategyById(id: string): Strategy {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy "${id}" (have: ${STRATEGIES.map((x) => x.id).join(', ')})`);
  return s;
}
