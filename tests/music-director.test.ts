import { describe, expect, it } from 'vitest';
import { Director, isMusicEvent, MUSIC_EVENTS, RULES } from '../src/audio/director';
import { asDoctrine, DOCTRINE_IDS, DOCTRINES } from '../src/audio/doctrines';
import { MUSIC_DUCK_MAX, musicDuckGain } from '../src/audio/mixer';
import { Conductor, layerTargets, type BarPlan, type ScoreState } from '../src/audio/score';
import { THEMES } from '../src/audio/themes';

const battle = (intensity: number, retreat = false): ScoreState => ({ mode: 'battle', intensity, retreat, outcome: null });

describe('Director (situation state machine)', () => {
  it('applies events only at the next bar boundary', () => {
    const d = new Director();
    d.post('homeThreatened');
    expect(d.situation).toBe('normal');
    expect(d.pending).toEqual([]);
    d.tick();
    expect(d.situation).toBe('threat');
    expect(d.floor).toBe(RULES.homeThreatened.floor);
    expect(d.pending).toEqual(['threat']);
  });

  it('starts urgent cues at once and holds others for a half-phrase boundary', () => {
    const d = new Director();
    d.post('offensiveLaunched');
    d.tick();
    expect(d.takeCue(false, false)).toBeNull();
    expect(d.takeCue(true, false)).toBe('offensive');
    d.post('capitalLost');
    d.tick();
    expect(d.takeCue(false, false)).toBe('fall');
  });

  it('expires situations after their bars and relaxes on quiet', () => {
    const d = new Director();
    d.post('capitalTaken');
    d.tick();
    expect(d.situation).toBe('triumph');
    for (let i = 0; i < RULES.capitalTaken.bars; i++) d.tick();
    expect(d.situation).toBe('normal');
    d.post('homeThreatened');
    d.tick();
    d.post('quiet');
    d.tick();
    expect(d.situation).toBe('normal');
    expect(d.pending).toEqual([]);
    expect(d.floor).toBe(0);
  });

  it('never lets a lower-ranked event override a running higher one', () => {
    const d = new Director();
    d.post('capitalLost');
    d.tick();
    d.post('offensiveLaunched');
    d.tick();
    expect(d.situation).toBe('falling');
    expect(d.sombre).toBe(true);
    expect(d.pending).toEqual(['fall']);
  });

  it('treats victory and defeat as terminal and lets them cut through a cue', () => {
    const d = new Director();
    d.post('homeThreatened');
    d.post('victory');
    d.tick();
    expect(d.situation).toBe('won');
    expect(d.outcome).toBe('victory');
    expect(d.pending).toEqual(['victory']);
    expect(d.takeCue(false, true)).toBe('victory');
    d.post('quiet');
    d.post('defeat');
    d.tick();
    expect(d.situation).toBe('won');
  });

  it('does not replay a cue when the same situation is refreshed soon after', () => {
    const d = new Director();
    d.post('homeThreatened');
    d.tick();
    expect(d.takeCue(false, false)).toBe('threat');
    d.tick();
    d.post('homeThreatened');
    d.tick();
    expect(d.pending).toEqual([]);
    expect(d.barsLeft).toBe(RULES.homeThreatened.bars);
  });

  it('validates event and doctrine ids from outside', () => {
    for (const k of MUSIC_EVENTS) expect(isMusicEvent(k)).toBe(true);
    expect(isMusicEvent('nuke')).toBe(false);
    expect(asDoctrine('blitz')).toBe('blitz');
    expect(asDoctrine('unknown')).toBeNull();
    expect(asDoctrine(42)).toBeNull();
  });
});

describe('Conductor transitions', () => {
  /** Bars until the cue for `kind` starts when posted after `lead` bars of a steady state. */
  const cueAfter = (kind: Parameters<Conductor['event']>[0], lead: number, cue: string, state: ScoreState): { plans: BarPlan[]; at: number } => {
    const c = new Conductor(11);
    const plans: BarPlan[] = [];
    for (let i = 0; i < lead; i++) plans.push(c.nextBar(state));
    c.event(kind);
    for (let i = 0; i < 12; i++) plans.push(c.nextBar(state));
    return { plans, at: plans.findIndex((p, i) => i >= lead && p.theme === cue && p.bar === 0) };
  };

  it('plays every plan as whole 4-beat bars', () => {
    const { plans } = cueAfter('offensiveLaunched', 6, 'offensive', battle(0.4));
    for (const p of plans) {
      expect(p.beats).toBe(4);
      for (const e of p.events) expect(e.beat).toBeLessThan(4);
    }
  });

  it('starts an urgent cue at the very next bar, even mid-phrase', () => {
    for (const lead of [1, 3, 6]) {
      const { plans, at } = cueAfter('homeThreatened', lead, 'threat', battle(0.05));
      expect(at).toBe(lead);
      expect(plans[lead - 1].theme).not.toBe('threat');
    }
  });

  it('holds a non-urgent cue for the next half-phrase boundary (at most 4 bars)', () => {
    for (const lead of [1, 2, 5, 7]) {
      const { plans, at } = cueAfter('offensiveLaunched', lead, 'offensive', battle(0.05));
      expect(at).toBeGreaterThanOrEqual(lead);
      expect(at - lead).toBeLessThanOrEqual(4);
      // The bar it interrupts is a half-phrase boundary of the previous phrase.
      const prev = plans[at - 1];
      expect(prev.bar % 4 === 3 || prev.bar === THEMES[prev.theme].bars.length - 1).toBe(true);
    }
  });

  it('crossfades out of an interrupted phrase (tail of the old chord on beat 0)', () => {
    const { plans, at } = cueAfter('capitalLost', 3, 'fall', battle(0.05));
    const first = plans[at];
    const tails = first.events.filter((e) => e.beat === 0 && e.layer === 'strings' && e.atk <= 0.01 && e.dur === 0.5);
    expect(tails.length).toBe(3);
  });

  it('raises the effective intensity to the situation floor and colours the layers', () => {
    const c = new Conductor(2);
    c.event('offensiveLaunched');
    c.nextBar(battle(0.1));
    expect(c.situation).toBe('offensive');
    expect(c.effectiveIntensity(0.1)).toBeCloseTo(RULES.offensiveLaunched.floor);
    expect(c.effectiveIntensity(0.9)).toBe(0.9);
    const calm = layerTargets(0.5, 'battle', false, 'normal');
    expect(layerTargets(0.5, 'battle', false, 'threat').ostinato).toBeGreaterThan(calm.ostinato);
    expect(layerTargets(0.5, 'battle', false, 'offensive').brass).toBeGreaterThan(calm.brass);
    for (const v of Object.values(layerTargets(1, 'battle', false, 'threat'))) expect(v).toBeLessThanOrEqual(1);
  });

  it('switches to the aftermath hymn after a victory event', () => {
    const c = new Conductor(5);
    for (let i = 0; i < 4; i++) c.nextBar(battle(0.8));
    c.event('victory');
    const themes = Array.from({ length: 16 }, () => c.nextBar(battle(0.8)).theme);
    expect(themes[0]).toBe('victory');
    expect(themes).toContain('hymn');
    expect(themes.slice(4)).not.toContain('battle');
  });

  it('plays the capital-lost cue then a lament while the capital falls', () => {
    const c = new Conductor(8);
    c.nextBar(battle(0.6));
    c.event('capitalLost');
    const themes = Array.from({ length: 12 }, () => c.nextBar(battle(0.6)).theme);
    expect(themes[0]).toBe('fall');
    expect(themes.slice(4)).toContain('lament');
  });
});

describe('doctrine themes', () => {
  it('weaves the doctrine theme into tension and battle phrases', () => {
    for (const d of DOCTRINE_IDS) {
      const c = new Conductor(3);
      c.setDoctrine(d);
      const themes = Array.from({ length: 40 }, (_, i) => c.nextBar(battle(i < 16 ? 0.38 : 0.9)).theme);
      expect(themes).toContain(DOCTRINES[d].theme);
    }
  });

  it('falls back to the default score for unknown doctrines', () => {
    const c = new Conductor(3);
    c.setDoctrine('blitz');
    c.setDoctrine('mystery');
    expect(c.doctrineId).toBeNull();
    const themes = Array.from({ length: 40 }, () => c.nextBar(battle(0.9)).theme);
    for (const d of DOCTRINE_IDS) expect(themes).not.toContain(d);
  });

  it('keeps every doctrine colour within sane tempo and voice bounds', () => {
    for (const d of DOCTRINE_IDS) {
      const c = new Conductor(4);
      c.setDoctrine(d);
      for (let i = 0; i < 48; i++) {
        const p = c.nextBar(battle(i < 12 ? 0.4 : 0.95));
        expect(p.bpm).toBeGreaterThan(40);
        expect(p.bpm).toBeLessThan(130);
        expect(p.events.length).toBeLessThan(120);
        for (const e of p.events) expect(e.vel).toBeLessThan(1);
      }
    }
  });
});

describe('music duck', () => {
  it('leaves light fire alone and ducks heavy fire by at most MUSIC_DUCK_MAX', () => {
    expect(musicDuckGain(0)).toBe(1);
    expect(musicDuckGain(0.3)).toBe(1);
    expect(musicDuckGain(1)).toBeCloseTo(1 - MUSIC_DUCK_MAX);
    expect(musicDuckGain(5)).toBeCloseTo(1 - MUSIC_DUCK_MAX);
    let prev = 1;
    for (let x = 0; x <= 1; x += 0.05) {
      const g = musicDuckGain(x);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
  });
});
