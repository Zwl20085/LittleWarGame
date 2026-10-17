import { describe, expect, it } from 'vitest';
import { bandHigh, bandLow, cheapWins, evaluateMatch, gini, oneSidedness, pacing, warnings, type ExpSample, type ExperienceLog } from '../scripts/challenge/experience';
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
    // 3.0: the experience log is sampled every 30 s.
    expect(r.experience?.samples.length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it('registers every strategy once', () => {
    const ids = STRATEGIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['rush', 'turtle', 'two_axis', 'raid', 'late_blitz', 'human_like', 'rush_micro', 'armour_raid', 'shadow_strike', 'backdoor', 'feint', 'econ_war', 'siege', 'ai_only',
      'doctrine_builder', 'doctrine_blitz', 'doctrine_attrition', 'doctrine_maneuver']);
  });
});

const sample = (t: number, army: number[], terr = [5, 5, 5, 5]): ExpSample => ({ t, army, terr, alive: army.map(() => true) });

describe('player-experience metrics (synthetic series)', () => {
  it('gini: equal = 0, one holder -> (n-1)/n', () => {
    expect(gini([5, 5, 5, 5])).toBeCloseTo(0, 6);
    expect(gini([0, 0, 0, 10])).toBeCloseTo(0.75, 6);
    expect(gini([])).toBe(0);
  });

  it('one-sidedness: dominated share, lead changes, overturned deficit, Gini at 15 min', () => {
    const s = [
      sample(0, [100, 100, 100, 100]),
      sample(30, [100, 300, 100, 100]),
      sample(60, [50, 800, 50, 50]),
      sample(90, [400, 300, 300, 300]),
      sample(900, [10, 10, 10, 10], [0, 0, 0, 20]),
    ];
    const o = oneSidedness(s);
    expect(o.dominatedShare).toBeCloseTo(1 / 5, 6);
    expect(o.leadChanges).toBe(2);
    expect(o.largestComeback).toBeCloseTo(750 / 950, 6);
    expect(o.gini[0].g).toBeCloseTo(0.75, 6);
    expect(Number.isNaN(o.gini[1].g)).toBe(true);
  });

  it('cheap-win index flags < 20 % of the attacker army and a 3:1 outnumbered force', () => {
    const c = cheapWins([
      { capital: 1, by: 0, t: 900, force: 500, attArmy: 5000, defArmy: 600 },
      { capital: 2, by: 0, t: 1000, force: 4000, attArmy: 5000, defArmy: 12500 },
      { capital: 3, by: 0, t: 1100, force: 4000, attArmy: 5000, defArmy: 3000 },
    ]);
    expect(c.map((x) => x.flagged)).toEqual([true, true, false]);
    expect(c[0].shareOfArmy).toBeCloseTo(0.1, 6);
    expect(c[1].defenderOver).toBeCloseTo(3.125, 6);
  });

  it('warning time: sighting to arrival, never seen, capital taken', () => {
    const w = warnings(
      [
        { attacker: 0, defender: 1, t: 600, force: 900, attArmy: 5000, firstSightS: 540, alarmS: 560, defenderArrivalS: 620 },
        { attacker: 0, defender: 2, t: 700, force: 900, attArmy: 5000, firstSightS: -1, alarmS: -1, defenderArrivalS: -1 },
      ],
      [{ capital: 2, by: 0, t: 760, force: 900, attArmy: 5000, defArmy: 800 }],
    );
    expect(w[0].warnS).toBe(60);
    expect(w[0].reactionS).toBe(20);
    expect(w[0].defenderArrivalS).toBe(80);
    expect(w[0].tookCapital).toBe(false);
    expect(w[1].seen).toBe(false);
    expect(Number.isNaN(w[1].warnS)).toBe(true);
    expect(w[1].tookCapital).toBe(true);
  });

  it('pacing and bands', () => {
    const p = pacing({ firstContactS: 200, firstTownLostS: 500, falls: [{ capital: 1, by: 0, t: 1800, force: 1, attArmy: 1, defArmy: 1 }], minutes: 40, decided: false });
    expect(p.firstCapitalLostS).toBe(1800);
    expect(p.eliminationsPerHour).toBeCloseTo(1.5, 6);
    expect(p.undecided).toBe(true);
    expect(bandLow(0.3, 0.4, 0.6)).toBe('pass');
    expect(bandLow(0.5, 0.4, 0.6)).toBe('warn');
    expect(bandLow(0.7, 0.4, 0.6)).toBe('fail');
    expect(bandHigh(50, 90, 45)).toBe('warn');
  });

  it('a one-sided cheap-win match scores FAIL; a balanced quiet one scores PASS', () => {
    const base: ExperienceLog = {
      samples: [sample(0, [100, 100, 100, 100]), sample(900, [120, 100, 90, 100]), sample(1800, [110, 100, 105, 95]), sample(2700, [100, 100, 100, 100])],
      health: [{ t: 30, units: 100, idleFar: 5, stuck: 1, starved: 5 }], falls: [], arrivals: [], firstContactS: 300, firstTownLostS: 900, minutes: 45, decided: false,
    };
    expect(evaluateMatch(base).verdict).toBe('PASS');
    const bad: ExperienceLog = {
      ...base,
      samples: [sample(0, [900, 20, 20, 20], [14, 2, 2, 2]), sample(900, [900, 20, 20, 20], [14, 2, 2, 2]), sample(1800, [900, 20, 20, 20], [18, 1, 1, 0])],
      falls: [{ capital: 1, by: 0, t: 400, force: 50, attArmy: 900, defArmy: 400 }],
      arrivals: [{ attacker: 0, defender: 1, t: 390, force: 50, attArmy: 900, firstSightS: -1, alarmS: -1, defenderArrivalS: -1 }],
      firstContactS: 60,
    };
    const ev = evaluateMatch(bad);
    expect(ev.cheap[0].flagged).toBe(true);
    expect(ev.verdict).toBe('FAIL');
    expect(ev.score).toBeLessThan(50);
  });
});
