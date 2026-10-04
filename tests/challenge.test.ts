import { describe, expect, it } from 'vitest';
import { runChallengeMatch } from '../scripts/challenge/match';
import { STRATEGIES } from '../scripts/challenge/strategies';

/** Challenge lab smoke test (scripts/challenge.ts, docs/CHALLENGE_LAB.md): a short scripted rush runs through the command API. */
describe('challenge lab', () => {
  it('runs a 2-minute rush on seed 7 and produces a report', () => {
    const r = runChallengeMatch({ strategy: 'rush', seed: 7, minutes: 2, params: { rushAt: 60 } });
    expect(r.strategy).toBe('rush');
    expect(r.minutes).toBeCloseTo(2, 1);
    expect(r.attackS).toBe(60);
    expect(r.attackTarget).toBeGreaterThan(0);
    expect(r.ai).toHaveLength(3);
    expect(r.ai.map((a) => a.id)).not.toContain(0);
    expect(r.commandsIssued).toBeGreaterThan(0);
    // Every order the strategy gave went through the real validation.
    expect(Object.keys(r.commandsFailed)).toEqual([]);
    expect(r.held[0].byFaction).toHaveLength(4);
  }, 120_000);

  it('registers every strategy once', () => {
    const ids = STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['rush', 'turtle', 'two_axis', 'raid', 'late_blitz', 'human_like', 'rush_micro']);
  });
});
