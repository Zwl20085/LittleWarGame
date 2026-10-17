// ai_only: no scripted player. All four factions are the normal AI (spectate mode), so the lab can
// measure the player-experience metrics (pacing, one-sidedness, engagement health) of a plain AI war.
import type { Strategy } from '../types';

export const aiOnly: Strategy = {
  id: 'ai_only',
  summary: '4-FFA AI-only war (no scripted player): the pacing / one-sidedness baseline',
  aiOnly: true,
  setup() { /* nothing: no challenger */ },
  tick() { /* nothing */ },
};
