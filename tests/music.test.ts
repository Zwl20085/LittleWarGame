import { describe, expect, it } from 'vitest';
import { INSTRUMENTS, renderSample, sampleRoot } from '../src/audio/orchestra';
import { Conductor, type BarPlan, type ScoreState } from '../src/audio/score';
import { parseChord, THEMES } from '../src/audio/themes';

const run = (seed: number, bars: number, state: (i: number) => ScoreState): BarPlan[] => {
  const c = new Conductor(seed);
  return Array.from({ length: bars }, (_, i) => c.nextBar(state(i)));
};
const battle = (intensity: number, retreat = false): ScoreState => ({ mode: 'battle', intensity, retreat, outcome: null });

describe('music themes', () => {
  it('parses lead-sheet chords', () => {
    expect(parseChord('Dm').tones).toEqual([2, 5, 9]);
    expect(parseChord('Gm/Bb').bass).toBe(10);
    expect(parseChord('E/D').tones).toEqual([4, 8, 11]);
    expect(() => parseChord('H7')).toThrow();
  });

  it('keeps every melody inside its phrase', () => {
    for (const t of Object.values(THEMES)) for (const [b, len] of t.melody) expect(b + len).toBeLessThanOrEqual(t.bars.length * 4 + 1e-9);
  });
});

describe('Conductor', () => {
  it('is deterministic for a seed and varies between seeds', () => {
    const a = run(3, 40, () => battle(0.05));
    const b = run(3, 40, () => battle(0.05));
    const c = run(4, 40, () => battle(0.05));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('emits valid notes in every state', () => {
    const states: ScoreState[] = [battle(0.05), battle(0.4), battle(0.95), battle(0.5, true), { mode: 'title', intensity: 0.3, retreat: false, outcome: null }];
    for (const s of states) {
      for (const p of run(9, 48, () => s)) {
        expect(p.bpm).toBeGreaterThan(40);
        expect(p.bpm).toBeLessThan(130);
        for (const e of p.events) {
          expect(e.beat).toBeGreaterThanOrEqual(0);
          expect(e.beat).toBeLessThan(4);
          expect(e.vel).toBeGreaterThan(0);
          expect(e.vel).toBeLessThan(1);
          expect(Number.isFinite(e.midi)).toBe(true);
        }
      }
    }
  });

  it('escalates through a fill into the battle theme and calms down again', () => {
    const plans = run(1, 60, (i) => battle(i < 12 ? 0.05 : i < 40 ? 0.95 : 0.0));
    const themes = plans.map((p) => p.theme);
    const fill = themes.indexOf('fill');
    expect(fill).toBeGreaterThan(0);
    expect(themes[fill + 1]).toMatch(/^battle/);
    expect(themes.slice(50)).not.toContain('battle');
  });

  it('plays the victory stinger then the hymn when the match is won', () => {
    const plans = run(2, 24, (i) => (i < 6 ? battle(0.6) : { mode: 'aftermath', intensity: 0, retreat: false, outcome: 'victory' }));
    const themes = plans.map((p) => p.theme);
    const v = themes.indexOf('victory');
    expect(v).toBe(6);
    expect(themes.slice(v + 3)).toContain('hymn');
  });

  it('voice-leads the strings without parallel fifths or octaves against the bass', () => {
    let moves = 0;
    let bad = 0;
    let prev: number[] | null = null;
    for (const p of run(5, 160, () => battle(0.05))) {
      // Chord changes fall on beat 0 or (for two-chord bars) beat 2.
      for (const b0 of [0, 2]) {
        const heads = p.events.filter((e) => e.beat === b0 && (e.layer === 'strings' || e.layer === 'bass') && e.inst === 'strings' && e.atk > 0.2);
        const bass = heads.find((e) => e.layer === 'bass');
        const upper = heads.filter((e) => e.layer === 'strings').map((e) => e.midi);
        if (!bass || upper.length !== 3) continue;
        const cur = [bass.midi, ...upper];
        if (prev) {
          moves++;
          for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
            const a = (((prev[j] - prev[i]) % 12) + 12) % 12;
            const b = (((cur[j] - cur[i]) % 12) + 12) % 12;
            if ((a === 7 || a === 0) && a === b && prev[i] !== cur[i] && Math.sign(cur[i] - prev[i]) === Math.sign(cur[j] - prev[j])) bad++;
          }
        }
        prev = cur;
      }
    }
    expect(moves).toBeGreaterThan(50);
    expect(bad / moves).toBeLessThan(0.03);
  });
});

describe('orchestra', () => {
  it('maps every note to a sampled root within range', () => {
    expect(sampleRoot('strings', 10)).toBe(INSTRUMENTS.strings.lo);
    expect(sampleRoot('strings', 200)).toBeLessThanOrEqual(INSTRUMENTS.strings.hi);
    expect(sampleRoot('horn', 62) % 1).toBe(0);
  });

  it('renders finite, sealed, non-clipping samples', () => {
    for (const inst of ['strings', 'brass', 'timp', 'snare'] as const) {
      const s = renderSample({ inst, root: INSTRUMENTS[inst].lo, v: 0 });
      let peak = 0;
      for (const x of s.data) {
        expect(Number.isFinite(x)).toBe(true);
        peak = Math.max(peak, Math.abs(x));
      }
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(1);
      if (s.loopEnd > 0) {
        expect(s.loopStart).toBeLessThan(s.loopEnd);
        expect(s.loopEnd).toBeCloseTo(s.data.length / s.rate, 6);
      }
    }
  });
});
