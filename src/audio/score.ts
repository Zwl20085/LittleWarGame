/**
 * The composer: turns game state (mode, battle intensity, retreat, outcome, stingers) into
 * one bar of note events at a time. Pure logic, no Web Audio, so the same score drives the
 * live player (music.ts) and the offline preview (scripts/music-preview.ts).
 *
 * Structure: 8-bar phrases (4+4, half cadence / full cadence), themes chosen per tier,
 * voice-led string harmony, a bass line, and seeded per-phrase variation (lead instrument,
 * ornaments, octave, counter-melody, ostinato / snare / stab patterns).
 */
import { rng } from './dsp';
import { SWELL_PEAK, type InstId } from './orchestra';
import { BATTLE_OST16, BATTLE_OST8, SNARE_FILL, SNARE_PATTERNS, STABS, TENSION_OST, THEMES, type ChordInfo, type Mel, type Theme, type ThemeId } from './themes';

export type MusicMode = 'title' | 'battle' | 'aftermath';
export type Outcome = 'victory' | 'defeat' | null;
export type Stinger = 'victory' | 'defeat' | 'capital';

export const LAYERS = ['strings', 'bass', 'winds', 'horns', 'brass', 'ostinato', 'trem', 'perc', 'lead'] as const;
export type Layer = (typeof LAYERS)[number];

export interface NoteEv {
  /** Beat offset from the bar start (may be fractional). */
  readonly beat: number;
  readonly dur: number;
  readonly inst: InstId;
  readonly midi: number;
  readonly vel: number;
  readonly layer: Layer;
  readonly v: number;
  /** Attack / release in seconds (sustained instruments only). */
  readonly atk: number;
  readonly rel: number;
}

export interface BarPlan {
  readonly bpm: number;
  readonly beats: number;
  readonly events: readonly NoteEv[];
  readonly theme: ThemeId;
  readonly bar: number;
  readonly tier: number;
}

export interface ScoreState {
  readonly mode: MusicMode;
  readonly intensity: number;
  readonly retreat: boolean;
  readonly outcome: Outcome;
}

type Style = 'calm' | 'tension' | 'battle' | 'lament' | 'hymn' | 'fill' | 'stinger';

interface Variation {
  readonly lead: InstId;
  readonly leadOct: number;
  readonly counter: boolean;
  readonly walk: boolean;
  readonly ost: number;
  readonly snare: number;
  readonly stab: number;
  readonly double: boolean;
}

interface Phrase {
  readonly theme: Theme;
  readonly style: Style;
  readonly tier: number;
  /** First bar carries the decaying tail of a battle that just ended (no hard cut). */
  readonly bridge: boolean;
  readonly melody: readonly Mel[];
  readonly vary: Variation;
}

/** Up / down intensity thresholds between tiers (hysteresis). */
const UP = [0.22, 0.46, 0.72];
const DOWN = [0.12, 0.32, 0.58];
/** Phrase dynamic arc per bar: grow to bar 7, relax into the cadence. */
const ARC = [0.86, 0.88, 0.93, 0.9, 0.92, 1, 1.06, 0.92];
/** String voicing ranges (tenor, alto, soprano); the melody sits above. */
const RANGES: readonly (readonly [number, number])[] = [[48, 62], [53, 67], [57, 71]];
const BASE_SCALE = [2, 4, 5, 7, 9, 10, 0];

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Layer bus gain targets (0–1) for a smoothed intensity: the crossfade between sections. */
export function layerTargets(x: number, mode: MusicMode, retreat: boolean): Record<Layer, number> {
  const sombre = retreat || mode === 'aftermath';
  return {
    strings: 0.95 - 0.2 * x,
    bass: 0.9,
    winds: sombre ? 0.9 : 1 - 0.45 * x,
    horns: 0.55 + 0.45 * smooth(0.15, 0.5, x),
    brass: 0.35 + 0.65 * smooth(0.45, 0.85, x),
    ostinato: 0.45 + 0.55 * smooth(0.2, 0.6, x),
    trem: 0.4 + 0.6 * smooth(0.5, 0.85, x),
    perc: 0.32 + 0.2 * smooth(0.2, 0.75, x),
    lead: 1,
  };
}

/** Static seating per layer: pan, reverb send, and whether brightness follows intensity. */
export const LAYER_BUS: Record<Layer, { readonly pan: number; readonly send: number; readonly bright: boolean }> = {
  strings: { pan: -0.2, send: 0.45, bright: true },
  bass: { pan: 0.25, send: 0.25, bright: false },
  winds: { pan: -0.1, send: 0.5, bright: false },
  horns: { pan: -0.3, send: 0.6, bright: true },
  brass: { pan: 0.3, send: 0.42, bright: true },
  ostinato: { pan: 0.2, send: 0.22, bright: false },
  trem: { pan: -0.35, send: 0.4, bright: true },
  perc: { pan: 0.08, send: 0.32, bright: false },
  lead: { pan: 0, send: 0.55, bright: false },
};

/** Lowpass cutoff (Hz) for `bright` layers: darker when calm, open in battle. */
export const brightness = (x: number): number => 2200 + 7000 * x * x;

function scaleFor(ch: ChordInfo | undefined): number[] {
  const s = BASE_SCALE.slice();
  if (!ch) return s;
  for (const pc of ch.tones) {
    if (s.includes(pc)) continue;
    const i = s.findIndex((x) => (x + 1) % 12 === pc || (x + 11) % 12 === pc);
    if (i >= 0) s[i] = pc;
  }
  return s;
}

const inScale = (n: number, scale: readonly number[]): boolean => scale.includes(((n % 12) + 12) % 12);

function stepFrom(n: number, dir: 1 | -1, scale: readonly number[]): number {
  let m = n + dir;
  while (!inScale(m, scale)) m += dir;
  return m;
}

/** Fit a pitch class into [lo, hi], nearest to `near`. */
function place(pc: number, lo: number, hi: number, near: number): number {
  let best = -1;
  for (let n = lo; n <= hi; n++) if (((n % 12) + 12) % 12 === pc && (best < 0 || Math.abs(n - near) < Math.abs(best - near))) best = n;
  return best < 0 ? lo + (((pc - lo) % 12) + 12) % 12 : best;
}

export class Conductor {
  private readonly r: () => number;
  private phrase: Phrase | null = null;
  private bar = 0;
  private tier = 0;
  private want = 0;
  private bpm = 66;
  private prev: number[] = [38, 53, 57, 62];
  private readonly counters: Record<string, number> = {};
  private readonly queue: Stinger[] = [];
  private lastMode: MusicMode | null = null;
  private lastOutcome: Outcome = null;
  private lastRetreat = false;
  private lastLead: InstId = 'horn';

  constructor(seed: number) {
    this.r = rng(seed);
  }

  /** Current orchestration tier 0–3 (debug / stats). */
  get level(): number {
    return this.tier;
  }

  stinger(s: Stinger): void {
    if (this.queue.length < 2 && !this.queue.includes(s)) this.queue.push(s);
  }

  nextBar(s: ScoreState): BarPlan {
    this.updateWant(s);
    if (s.outcome !== this.lastOutcome) {
      if (s.outcome) this.queue.unshift(s.outcome);
      this.lastOutcome = s.outcome;
    }
    const modeChanged = this.lastMode !== null && s.mode !== this.lastMode;
    const retreatChanged = s.retreat !== this.lastRetreat;
    this.lastMode = s.mode;
    this.lastRetreat = s.retreat;
    const ph = this.phrase;
    const atHalf = this.bar % 4 === 0;
    const inStinger = ph?.style === 'stinger' || ph?.style === 'fill';
    if (!ph || this.bar >= ph.theme.bars.length) this.startPhrase(s);
    else if (this.queue.length && !inStinger) this.startPhrase(s);
    else if (!inStinger && (modeChanged || (retreatChanged && atHalf))) this.startPhrase(s);
    else if (!inStinger && this.want > this.tier && (atHalf || (this.want >= 2 && this.tier <= 1))) this.startPhrase(s);
    return this.compose(s);
  }

  private updateWant(s: ScoreState): void {
    const cap = s.mode === 'title' ? 2 : 3;
    const x = s.mode === 'title' ? s.intensity * 0.85 : s.mode === 'aftermath' ? 0 : s.intensity;
    if (this.want < cap && x > UP[this.want]) this.want++;
    else if (this.want > 0 && x < DOWN[this.want - 1]) this.want--;
    this.want = Math.min(this.want, cap);
  }

  private cycle(key: string, list: readonly ThemeId[]): ThemeId {
    const i = this.counters[key] ?? 0;
    // Occasionally skip ahead so long sessions do not fall into a fixed loop (never on the
    // opening statement, never into a back-to-back repeat).
    let k = i;
    if (i > 0 && list.length > 2 && this.r() < 0.2 && list[(i + 1) % list.length] !== this.phrase?.theme.id) k = i + 1;
    this.counters[key] = k + 1;
    return list[k % list.length];
  }

  private startPhrase(s: ScoreState): void {
    this.bar = 0;
    const stinger = this.queue.shift();
    if (stinger) {
      this.setPhrase(THEMES[stinger], 'stinger', this.tier);
      return;
    }
    const prevTier = this.tier;
    const prevStyle = this.phrase?.style;
    this.tier = this.want;
    if (s.mode === 'aftermath') {
      const id = s.outcome === 'victory' ? this.cycle('hymn', ['hymn', 'interlude', 'main']) : this.cycle('lament', ['lament', 'interlude']);
      this.setPhrase(THEMES[id], s.outcome === 'victory' ? (id === 'hymn' ? 'hymn' : 'calm') : 'lament', 0);
      return;
    }
    if (s.mode === 'battle' && s.retreat) {
      this.setPhrase(THEMES[this.cycle('retreat', ['lament', 'tensionB', 'lament', 'interlude'])], 'lament', Math.min(this.tier, 1));
      return;
    }
    // Escalation into battle gets a one-bar dominant build (rolls + cymbal swell).
    if (this.tier >= 2 && prevTier <= 1 && prevStyle !== 'fill' && s.mode === 'battle') {
      this.setPhrase(THEMES.fill, 'fill', this.tier);
      return;
    }
    const title = s.mode === 'title';
    if (this.tier === 0) {
      const id = this.cycle(title ? 'title0' : 'calm', title ? ['main', 'mainB', 'interlude'] : ['main', 'interlude', 'mainB', 'interlude']);
      this.setPhrase(THEMES[id], 'calm', 0);
    } else if (this.tier === 1) {
      const id = this.cycle(title ? 'title1' : 'tension', title ? ['main', 'tension', 'mainB', 'tensionB'] : ['tension', 'tensionB']);
      this.setPhrase(THEMES[id], id.startsWith('main') ? 'calm' : 'tension', 1);
    } else {
      const id = this.cycle(title ? 'title2' : 'battle', title ? ['main', 'mainB'] : ['battleA', 'battle', 'battleA', 'battle', 'main', 'mainB']);
      this.setPhrase(THEMES[id], 'battle', this.tier);
    }
  }

  private setPhrase(theme: Theme, style: Style, tier: number): void {
    const r = this.r;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    let lead: InstId;
    let leadOct = 0;
    if (style === 'battle') lead = tier >= 3 ? 'brass' : 'horn';
    else if (style === 'tension') lead = r() < 0.75 ? 'horn' : 'reed';
    else if (style === 'hymn') lead = 'strings';
    else if (style === 'stinger') lead = theme.id === 'defeat' ? 'horn' : 'brass';
    else {
      // Rotate the calm lead so consecutive statements change colour.
      const opts = (['reed', 'horn', 'strings'] as const).filter((x) => x !== this.lastLead);
      lead = pick(opts);
    }
    if (lead === 'strings' && style !== 'battle') leadOct = 12;
    if (style === 'lament' && lead === 'horn' && r() < 0.5) leadOct = -12;
    if (style === 'stinger' && theme.id === 'defeat') leadOct = 0;
    this.lastLead = lead;
    const vary: Variation = {
      lead, leadOct,
      counter: style === 'calm' || style === 'hymn' ? r() < 0.55 : false,
      walk: r() < 0.6,
      ost: Math.floor(r() * 3),
      snare: Math.floor(r() * SNARE_PATTERNS.length),
      stab: Math.floor(r() * STABS.length),
      double: r() < 0.5,
    };
    const orn = style === 'calm' || style === 'lament' || style === 'hymn' ? 0.12 + r() * 0.3 : style === 'tension' ? 0.1 : 0;
    const bridge = this.phrase?.style === 'battle' && style !== 'battle' && style !== 'stinger';
    this.phrase = { theme, style, tier, bridge, melody: this.ornament(theme, orn), vary };
    if (style === 'lament') this.targetBpm = tier === 0 ? 52 : 58;
    else this.targetBpm = theme.bpm + (style === 'battle' && tier >= 3 ? 6 : 0) + (style === 'battle' && theme.id.startsWith('main') ? 34 : 0);
  }

  private targetBpm = 66;
  private prevStyle: Style | null = null;

  /** Seeded ornamentation: passing tones across thirds, upper-neighbour appoggiaturas. */
  private ornament(theme: Theme, amount: number): Mel[] {
    const mel = theme.melody;
    if (amount <= 0) return mel.slice();
    const out: Mel[] = [];
    const chordAt = (beat: number): ChordInfo | undefined => {
      const bar = theme.bars[Math.floor(beat / 4)];
      return bar ? bar[Math.min(bar.length - 1, Math.floor(((beat % 4) / 4) * bar.length))] : undefined;
    };
    for (let i = 0; i < mel.length; i++) {
      const [b, len, n] = mel[i];
      const next = mel[i + 1];
      const scale = scaleFor(chordAt(b));
      const gap = next ? next[2] - n : 0;
      if (next && len >= 1 && Math.abs(gap) >= 3 && Math.abs(gap) <= 4 && next[0] === b + len && this.r() < amount * 2) {
        const mid = stepFrom(n, gap > 0 ? 1 : -1, scaleFor(chordAt(b + len)));
        out.push([b, len - 0.5, n], [b + len - 0.5, 0.5, mid]);
      } else if (len >= 2 && this.r() < amount) {
        out.push([b, 0.5, stepFrom(n, 1, scale)], [b + 0.5, len - 0.5, n]);
      } else out.push(mel[i]);
    }
    return out;
  }

  /** Voice-lead the upper three string voices and the bass onto a chord. */
  private voice(ch: ChordInfo): number[] {
    const [pb, pt, pa, ps] = this.prev;
    const bass = place(ch.bass, 36, 50, pb);
    const cands = RANGES.map(([lo, hi]) => {
      const xs: number[] = [];
      for (let n = lo; n <= hi; n++) if (ch.tones.includes(n % 12)) xs.push(n);
      return xs;
    });
    let best: number[] = [];
    let bestCost = Infinity;
    for (const t of cands[0]) for (const a of cands[1]) {
      if (a <= t) continue;
      for (const s of cands[2]) {
        if (s <= a) continue;
        const pcs = new Set([t % 12, a % 12, s % 12]);
        if (!pcs.has(ch.third)) continue;
        if (ch.seventh >= 0 && !pcs.has(ch.seventh)) continue;
        let cost = Math.abs(t - pt) + Math.abs(a - pa) + Math.abs(s - ps);
        if (pcs.size < Math.min(3, ch.tones.length)) cost += 4;
        if (s - a > 9) cost += 4;
        if (a - t > 10) cost += 3;
        if (bass % 12 === ch.third) cost += [t, a, s].filter((n) => n % 12 === ch.third).length * 5;
        cost += this.parallels([pb, pt, pa, ps], [bass, t, a, s]) * 12;
        cost += this.r() * 0.6; // tie-break variety between equally smooth voicings
        if (cost < bestCost) {
          bestCost = cost;
          best = [bass, t, a, s];
        }
      }
    }
    if (!best.length) best = [bass, place(ch.root, 48, 60, pt), place(ch.third, 53, 65, pa), place(ch.tones[2], 57, 70, ps)];
    this.prev = best;
    return best;
  }

  /** Count parallel fifths / octaves between any pair of voices. */
  private parallels(p: readonly number[], n: readonly number[]): number {
    let k = 0;
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      const pi = (((p[j] - p[i]) % 12) + 12) % 12;
      const ni = (((n[j] - n[i]) % 12) + 12) % 12;
      if ((pi === 7 || pi === 0) && pi === ni && n[i] !== p[i] && Math.sign(n[i] - p[i]) === Math.sign(n[j] - p[j])) k++;
    }
    return k;
  }

  private compose(s: ScoreState): BarPlan {
    const ph = this.phrase!;
    const bar = this.bar;
    const theme = ph.theme;
    const chords = theme.bars[bar];
    const nBars = theme.bars.length;
    // Tempo: a new cue (style change) starts at its own tempo; within a style it glides
    // (e.g. tier 2 -> 3); stingers keep their own tempo; calm cadences breathe (ritardando).
    let bpm: number;
    if (ph.style === 'stinger') bpm = theme.bpm;
    else {
      const gap = this.targetBpm - this.bpm;
      const snap = bar === 0 && ph.style !== this.prevStyle;
      const maxStep = snap || ph.style === 'fill' ? 60 : 5;
      this.bpm += Math.max(-maxStep, Math.min(maxStep, gap));
      bpm = this.bpm;
    }
    if (bar === 0) this.prevStyle = ph.style;
    if (bar === nBars - 1 && (ph.style === 'calm' || ph.style === 'lament' || ph.style === 'hymn')) bpm *= 0.93;
    const ev: NoteEv[] = [];
    const arc = ph.style === 'stinger' ? 1 : ARC[bar % 8];
    const seg = 4 / chords.length;
    const voicings = chords.map((c) => this.voice(c));
    const next = theme.bars[bar + 1]?.[0];
    const ctx: BarCtx = { ev, ph, bar, nBars, arc, seg, chords, voicings, next, bpm, s };
    this.harmony(ctx);
    this.melody(ctx);
    this.percussion(ctx);
    this.bar++;
    return { bpm, beats: 4, events: ev, theme: theme.id, bar, tier: ph.tier };
  }

  private harmony(c: BarCtx): void {
    const { ph, voicings, seg, arc, ev } = c;
    const st = ph.style;
    const t = ph.tier;
    const sVel = (st === 'battle' ? 0.24 : st === 'tension' ? 0.26 : st === 'lament' ? 0.25 : 0.27) * arc;
    const sAtk = st === 'battle' ? 0.12 : st === 'lament' ? 1.0 : st === 'fill' ? 2.0 : 0.55;
    if (ph.bridge && c.bar === 0) {
      const v = voicings[0];
      ev.push(
        note(0, 2, 'trem', v[2] + 12, 0.2, 'trem', 0.02, 3), note(0, 2, 'trem', v[3] + 12, 0.2, 'trem', 0.02, 3),
        note(0, 2, 'horn', v[1], 0.22, 'horns', 0.05, 3), note(0, 2, 'horn', v[2], 0.2, 'horns', 0.05, 3),
      );
      for (let b = 0; b < 3; b += 0.25) ev.push(note(b, 0.25, 'timp', v[0] < 38 ? v[0] + 12 : v[0], 0.16 * (1 - b / 3), 'perc', 0, 0));
    }
    voicings.forEach((v, k) => {
      const b0 = k * seg;
      for (let i = 1; i < 4; i++) ev.push(note(b0, seg, 'strings', v[i], sVel, 'strings', sAtk, 1.2));
      this.bassLine(c, v[0], b0, k);
      if (st === 'tension' || (st === 'calm' && t >= 1)) {
        // Horns hold the inner voices, swelling in.
        ev.push(note(b0, seg, 'horn', v[1], 0.17 * arc, 'horns', 1.0, 1.0), note(b0, seg, 'horn', v[2], 0.15 * arc, 'horns', 1.0, 1.0));
      }
      if (st === 'battle' || st === 'fill' || (st === 'stinger' && ph.theme.id !== 'defeat')) {
        const tv = st === 'fill' ? 0.2 : 0.16 + 0.06 * Math.min(t, 3);
        ev.push(note(b0, seg, 'trem', v[2] + 12, tv * arc, 'trem', 0.06, 0.6), note(b0, seg, 'trem', v[3] + 12, tv * arc, 'trem', 0.06, 0.6));
      }
      if (st === 'battle') this.stabs(c, v, b0);
      if (st === 'fill') for (let i = 1; i < 4; i++) ev.push(note(0, 4, 'brass', v[i], 0.24, 'brass', 2.0, 0.3));
      if (st === 'stinger') {
        const hv = ph.theme.id === 'defeat' ? 0.16 : 0.24;
        ev.push(note(b0, seg, 'horn', v[1], hv, 'horns', 0.15, 2.0), note(b0, seg, 'horn', v[2], hv, 'horns', 0.15, 2.0));
      }
      if (st === 'lament' && ph.tier >= 1) this.ostinato(c, v[0], b0, seg, 'lament');
      if (st === 'tension') this.ostinato(c, v[0], b0, seg, 'tension');
      if (st === 'calm' && t >= 1) this.ostinato(c, v[0], b0, seg, 'tension');
      if (st === 'battle' || st === 'fill') this.ostinato(c, v[0], b0, seg, st === 'fill' ? 'fill' : t >= 3 ? 'b16' : 'b8');
    });
  }

  private bassLine(c: BarCtx, bass: number, b0: number, k: number): void {
    const { ph, seg, ev, next, chords, arc } = c;
    const vel = (ph.style === 'battle' ? 0.3 : 0.34) * arc;
    const last = k === chords.length - 1;
    if (ph.vary.walk && last && next && seg >= 2 && (ph.style === 'calm' || ph.style === 'lament' || ph.style === 'hymn')) {
      const target = place(next.bass, 36, 50, bass);
      const gap = target - bass;
      if (Math.abs(gap) >= 3 && Math.abs(gap) <= 5) {
        const pass = stepFrom(bass, gap > 0 ? 1 : -1, scaleFor(next));
        ev.push(note(b0, seg - 1, 'strings', bass, vel, 'bass', 0.3, 0.5), note(b0 + seg - 1, 1, 'strings', pass, vel * 0.85, 'bass', 0.12, 0.5));
        return;
      }
    }
    ev.push(note(b0, seg, 'strings', bass, vel, 'bass', ph.style === 'battle' ? 0.08 : 0.35, 1.0));
    if (ph.style === 'battle' && ph.tier >= 3) ev.push(note(b0, seg, 'brass', bass + 12, 0.12 * arc, 'brass', 0.4, 0.5));
  }

  private ostinato(c: BarCtx, bass: number, b0: number, seg: number, kind: 'tension' | 'lament' | 'b8' | 'b16' | 'fill'): void {
    const { ph, ev, arc } = c;
    const root = bass < 38 ? bass + 12 : bass;
    const pat = kind === 'tension' ? TENSION_OST[ph.vary.ost % TENSION_OST.length] : kind === 'b8' ? BATTLE_OST8[ph.vary.ost % BATTLE_OST8.length] : kind === 'lament' ? 'R---R---' : 'RRRRRRRRRRRRRRRR';
    const pat16 = kind === 'b16' ? BATTLE_OST16[ph.vary.ost % BATTLE_OST16.length] : pat;
    const steps = pat16.length;
    const stepLen = 4 / steps;
    const base = kind === 'tension' ? 0.3 : kind === 'lament' ? 0.22 : 0.36;
    for (let i = 0; i < steps; i++) {
      const b = i * stepLen;
      if (b < b0 || b >= b0 + seg) continue;
      const ch = pat16[i];
      if (ch === '-') continue;
      const off = ch === '8' ? 12 : ch === '5' ? 7 : 0;
      const acc = i % (steps / 2) === 0 ? 1 : i % (steps / 4) === 0 ? 0.8 : 0.62;
      const cresc = kind === 'fill' ? 0.5 + (b / 4) * 0.7 : 1;
      ev.push(note(b, stepLen, 'spic', root + off, base * acc * arc * cresc, 'ostinato', 0, 0));
    }
  }

  private stabs(c: BarCtx, v: readonly number[], b0: number): void {
    const { ph, ev, seg, arc, bar } = c;
    if (bar % 2 === 1 && ph.tier < 3) return;
    const vel = (ph.tier >= 3 ? 0.3 : 0.26) * arc;
    for (const [b, len] of STABS[ph.vary.stab]) {
      if (b < b0 || b >= b0 + seg) continue;
      for (let i = 1; i < 4; i++) ev.push(note(b, len, 'brass', v[i], vel, 'brass', 0.02, 0.25));
    }
  }

  private melody(c: BarCtx): void {
    const { ph, bar, ev, arc, chords, seg } = c;
    const from = bar * 4;
    const st = ph.style;
    const vary = ph.vary;
    // Calm phrases: every other statement of the interlude leaves the line to a solo reed.
    const leadVel = (vary.lead === 'reed' ? 0.42 : vary.lead === 'strings' ? 0.36 : vary.lead === 'brass' ? 0.4 : 0.38) * (st === 'battle' ? 1.35 : 1);
    const atk = vary.lead === 'strings' ? 0.18 : vary.lead === 'reed' ? 0.05 : 0.06;
    for (const [b, len, n] of ph.melody) {
      if (b < from || b >= from + 4) continue;
      const beat = b - from;
      const m = n + vary.leadOct;
      ev.push(note(beat, len, vary.lead, m, leadVel * arc, 'lead', atk, len >= 2 ? 0.9 : 0.4));
      if (st === 'battle' && ph.tier >= 3) ev.push(note(beat, len, 'horn', m - 12, 0.34 * arc, 'horns', 0.05, 0.4));
      else if (st === 'battle' && vary.double) ev.push(note(beat, len, 'strings', m + 12, 0.24 * arc, 'strings', 0.08, 0.5));
      if (st === 'hymn') ev.push(note(beat, len, 'horn', m - 12, 0.22 * arc, 'horns', 0.1, 0.8));
      if (vary.counter && len >= 2) {
        const ch = chords[Math.min(chords.length - 1, Math.floor(beat / seg))];
        const below = this.counterNote(ch, n);
        if (below > 0) ev.push(note(beat, len, vary.lead === 'reed' ? 'horn' : 'reed', below, 0.24 * arc, 'winds', 0.15, 0.8));
      }
    }
  }

  /** Chord tone a third-to-sixth below the melody note (for the counter line). */
  private counterNote(ch: ChordInfo, n: number): number {
    for (let d = 3; d <= 9; d++) if (ch.tones.includes((n - d) % 12)) return n - d >= 45 ? n - d : -1;
    return -1;
  }

  private percussion(c: BarCtx): void {
    const { ph, bar, nBars, ev, voicings, bpm } = c;
    const st = ph.style;
    const t = ph.tier;
    const timpNote = (bass: number): number => {
      let n = bass;
      while (n < 38) n += 12;
      while (n > 50) n -= 12;
      return n;
    };
    const tn = timpNote(voicings[0][0]);
    const last = bar === nBars - 1;
    const swellBeat = 4 - (SWELL_PEAK * bpm) / 60;
    const roll = (from: number, to: number, inst: InstId, midi: number, v0: number, v1: number, step: number): void => {
      for (let b = from; b < to - 1e-6; b += step) {
        const k = (b - from) / (to - from);
        ev.push(note(b, step, inst, midi, v0 + (v1 - v0) * k, 'perc', 0, 0, inst === 'snare' ? Math.floor(this.r() * 4) : 0));
      }
    };
    if (st === 'calm' || st === 'hymn' || st === 'lament') {
      if (bar === 0) ev.push(note(0, 1, 'timp', tn, st === 'hymn' ? 0.3 : 0.2, 'perc', 0, 0));
      if (bar === 4) ev.push(note(0, 1, 'timp', tn, 0.14, 'perc', 0, 0));
      if (last && ph.vary.walk && st !== 'lament') roll(2, 4, 'timp', tn, 0.03, 0.1, 0.25);
      if (st === 'lament' && t >= 1) {
        ev.push(note(0, 0.33, 'timp', tn, 0.16, 'perc', 0, 0), note(0.33, 1, 'timp', tn, 0.24, 'perc', 0, 0));
        if (bar >= nBars - 2) roll(0, 4, 'snare', 60, bar === nBars - 2 ? 0.02 : 0.07, bar === nBars - 2 ? 0.07 : 0.12, 0.125);
      }
      return;
    }
    if (st === 'tension') {
      if (bar < nBars - 2) ev.push(note(0, 0.33, 'timp', tn, 0.2, 'perc', 0, 0), note(0.33, 1, 'timp', tn, 0.32, 'perc', 0, 0));
      else roll(0, 4, 'timp', tn, bar === nBars - 2 ? 0.03 : 0.09, bar === nBars - 2 ? 0.09 : 0.18, 0.25);
      const swellA = ph.vary.snare % 2 === 0 && (bar === 2 || bar === 3);
      if (swellA || bar === 6 || bar === 7) {
        const first = bar % 2 === 0;
        roll(0, 4, 'snare', 60, first ? 0.02 : 0.1, first ? 0.1 : 0.22, 0.125);
      }
      if (last && swellBeat >= 0) ev.push(note(swellBeat, 4 - swellBeat, 'cymbal', 60, 0.22, 'perc', 0, 0, 0));
      return;
    }
    if (st === 'fill') {
      roll(0, 4, 'timp', 45, 0.05, 0.24, 0.25);
      roll(0, 4, 'snare', 60, 0.04, 0.3, 0.125);
      if (swellBeat >= 0) ev.push(note(swellBeat, 4 - swellBeat, 'cymbal', 60, 0.42, 'perc', 0, 0, 0));
      return;
    }
    if (st === 'stinger') {
      const id = ph.theme.id;
      if (bar === 0) {
        ev.push(note(0, 1, 'timp', tn, id === 'defeat' ? 0.3 : 0.75, 'perc', 0, 0));
        if (id !== 'defeat') ev.push(note(0, 1, 'cymbal', 60, 0.45, 'perc', 0, 0, 1), note(0, 1, 'bdrum', 60, 0.5, 'perc', 0, 0));
      }
      if (bar === nBars - 2) roll(0, 4, 'timp', tn, 0.04, id === 'defeat' ? 0.12 : 0.24, 0.25);
      if (last && bar > 0) {
        ev.push(note(0, 1, 'timp', tn, id === 'defeat' ? 0.32 : 0.7, 'perc', 0, 0), note(0, 1, 'bdrum', 60, id === 'defeat' ? 0.3 : 0.45, 'perc', 0, 0));
        if (id === 'victory') ev.push(note(0, 1, 'cymbal', 60, 0.5, 'perc', 0, 0, 1));
      }
      return;
    }
    // Battle: march snare, timpani on the strong beats, gran cassa and crash on phrase heads.
    const snareGain = t >= 3 ? 0.36 : 0.26;
    const pat = last ? SNARE_FILL : SNARE_PATTERNS[(ph.vary.snare + (bar % 4 === 3 ? 1 : 0)) % SNARE_PATTERNS.length];
    for (let i = 0; i < 16; i++) {
      const ch = pat[i];
      const b = i / 4;
      if (ch === '.') {
        if (t >= 3 && this.r() < 0.2) ev.push(note(b, 0.25, 'snare', 60, 0.05, 'perc', 0, 0, 2));
        continue;
      }
      const vel = (ch === 'x' ? 0.42 : 1) * snareGain * (last ? 0.6 + 0.5 * (i / 16) : 1);
      if (ch === 'F') ev.push(note(b - 0.06 < 0 ? 0 : b - 0.06, 0.06, 'snare', 60, vel * 0.35, 'perc', 0, 0, 3));
      ev.push(note(b, 0.25, 'snare', 60, vel, 'perc', 0, 0, i % 4));
    }
    const fifth = tn + 7 > 52 ? tn - 5 : tn + 7;
    ev.push(note(0, 1, 'timp', tn, 0.55, 'perc', 0, 0), note(2, 1, 'timp', bar % 2 ? fifth : tn, 0.4, 'perc', 0, 0));
    if (t >= 3) ev.push(note(3.5, 0.5, 'timp', tn, 0.3, 'perc', 0, 0), note(0, 1, 'bdrum', 60, 0.42, 'perc', 0, 0), note(2, 1, 'bdrum', 60, 0.3, 'perc', 0, 0));
    if (bar === 0) ev.push(note(0, 1, 'cymbal', 60, t >= 3 ? 0.4 : 0.3, 'perc', 0, 0, 1));
    if (last) {
      roll(3, 4, 'timp', tn, 0.1, 0.2, 0.25);
      if (swellBeat >= 0) ev.push(note(swellBeat, 4 - swellBeat, 'cymbal', 60, 0.3, 'perc', 0, 0, 0));
    }
  }
}

interface BarCtx {
  readonly ev: NoteEv[];
  readonly ph: Phrase;
  readonly bar: number;
  readonly nBars: number;
  readonly arc: number;
  readonly seg: number;
  readonly chords: readonly ChordInfo[];
  readonly voicings: readonly (readonly number[])[];
  readonly next: ChordInfo | undefined;
  readonly bpm: number;
  readonly s: ScoreState;
}

function note(beat: number, dur: number, inst: InstId, midi: number, vel: number, layer: Layer, atk: number, rel: number, v = 0): NoteEv {
  return { beat, dur, inst, midi, vel, layer, v, atk, rel };
}
