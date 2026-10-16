/**
 * The composer: turns game state (mode, battle intensity, retreat, outcome) plus the
 * director's situation events and the doctrine colour into one bar of note events at a
 * time. Pure logic, no Web Audio, so the same score drives the live player (music.ts) and
 * the offline preview (scripts/music-preview.ts).
 *
 * Structure: 8-bar phrases (4+4, half cadence / full cadence), themes chosen per tier,
 * voice-led string harmony (voicing.ts), orchestration per section (arrange.ts),
 * percussion (percussion.ts), seeded per-phrase variation. Every decision is taken at a
 * bar boundary (nextBar); phrase changes that are not urgent wait for a half-phrase.
 */
import { harmony, melody } from './arrange';
import { Director, type CueId, type MusicEventKind, type Situation } from './director';
import { asDoctrine, DOCTRINES, type DoctrineColour, type DoctrineId } from './doctrines';
import { rng } from './dsp';
import { LAYERS, type BarCtx, type Layer, type NoteEv, type Phrase, type Style, type Variation } from './notes';
import type { InstId } from './orchestra';
import { percussion } from './percussion';
import { SNARE_PATTERNS, STABS, THEMES, type ChordInfo, type Mel, type Theme, type ThemeId } from './themes';
import { scaleFor, stepFrom, Voicer } from './voicing';

export { LAYERS, type Layer, type NoteEv } from './notes';
export type MusicMode = 'title' | 'battle' | 'aftermath';
export type Outcome = 'victory' | 'defeat' | null;
/** One-shot cue phrases (legacy name; see director.ts). */
export type Stinger = CueId;

export interface BarPlan {
  readonly bpm: number;
  readonly beats: number;
  readonly events: readonly NoteEv[];
  readonly theme: ThemeId;
  readonly bar: number;
  readonly tier: number;
  readonly situation: Situation;
}

export interface ScoreState {
  readonly mode: MusicMode;
  readonly intensity: number;
  readonly retreat: boolean;
  readonly outcome: Outcome;
}

/** Up / down intensity thresholds between tiers (hysteresis). */
const UP = [0.22, 0.46, 0.72];
const DOWN = [0.12, 0.32, 0.58];
/** Phrase dynamic arc per bar: grow to bar 7, relax into the cadence. */
const ARC = [0.86, 0.88, 0.93, 0.9, 0.92, 1, 1.06, 0.92];
const arcFor = (style: Style, bar: number): number => (style === 'stinger' ? 1 : ARC[bar % 8]);

const STINGER_EVENT: Record<CueId, MusicEventKind> = {
  victory: 'victory', defeat: 'defeat', capital: 'capitalTaken', threat: 'homeThreatened', offensive: 'offensiveLaunched', fall: 'capitalLost',
};

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Layer bus gain targets (0–1) for a smoothed intensity and the current situation: the
 * vertical crossfade between sections (the live player glides to them, never jumps).
 */
export function layerTargets(x: number, mode: MusicMode, retreat: boolean, sit: Situation = 'normal'): Record<Layer, number> {
  const sombre = retreat || mode === 'aftermath' || sit === 'falling';
  const threat = sit === 'threat' ? 1 : 0;
  const push = sit === 'offensive' || sit === 'triumph' ? 1 : 0;
  const t: Record<Layer, number> = {
    strings: sombre ? 1 : 0.95 - 0.2 * x,
    bass: 0.9,
    winds: sombre ? 0.9 : 1 - 0.45 * x - 0.25 * threat,
    horns: 0.55 + 0.45 * smooth(0.15, 0.5, x) + 0.1 * push,
    brass: (0.35 + 0.65 * smooth(0.45, 0.85, x) + 0.15 * push) * (sombre ? 0.7 : 1),
    lowbrass: 0.3 + 0.7 * smooth(0.35, 0.8, x) + 0.2 * threat,
    ostinato: 0.45 + 0.55 * smooth(0.2, 0.6, x) + 0.2 * threat,
    trem: 0.4 + 0.6 * smooth(0.5, 0.85, x) + 0.2 * threat,
    perc: (0.32 + 0.2 * smooth(0.2, 0.75, x) + 0.06 * push) * (sombre ? 0.85 : 1),
    lead: 1,
  };
  for (const l of LAYERS) t[l] = Math.min(1, t[l]);
  return t;
}

/** Static seating per layer: pan, reverb send, and whether brightness follows intensity. */
export const LAYER_BUS: Record<Layer, { readonly pan: number; readonly send: number; readonly bright: boolean }> = {
  strings: { pan: -0.25, send: 0.42, bright: true },
  bass: { pan: 0.3, send: 0.22, bright: false },
  winds: { pan: -0.05, send: 0.5, bright: false },
  horns: { pan: -0.35, send: 0.6, bright: true },
  brass: { pan: 0.3, send: 0.38, bright: true },
  lowbrass: { pan: 0.4, send: 0.34, bright: true },
  ostinato: { pan: 0.2, send: 0.2, bright: false },
  trem: { pan: -0.4, send: 0.38, bright: true },
  perc: { pan: 0.08, send: 0.3, bright: false },
  lead: { pan: 0, send: 0.5, bright: false },
};

/** Lowpass cutoff (Hz) for `bright` layers: darker when calm, open in battle. */
export const brightness = (x: number): number => 2200 + 7000 * x * x;

export class Conductor {
  private readonly r: () => number;
  private readonly voicer = new Voicer();
  private readonly director = new Director();
  private doctrine: DoctrineId | null = null;
  private phrase: Phrase | null = null;
  private bar = 0;
  private tier = 0;
  private want = 0;
  private bpm = 66;
  private targetBpm = 66;
  private prevStyle: Style | null = null;
  private readonly counters: Record<string, number> = {};
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

  get situation(): Situation {
    return this.director.situation;
  }

  get doctrineId(): DoctrineId | null {
    return this.doctrine;
  }

  /** Situation event; applied at the next bar boundary (see director.ts). */
  event(kind: MusicEventKind): void {
    this.director.post(kind);
  }

  /** Doctrine colour for tension / battle phrases; unknown ids select the default score. */
  setDoctrine(id: unknown): void {
    this.doctrine = asDoctrine(id);
  }

  /** Legacy one-shot cue entry point (FortuneWatch): routed through the director. */
  stinger(s: Stinger): void {
    this.director.post(STINGER_EVENT[s]);
  }

  /** Intensity the layers follow: the battle intensity raised to the situation's floor. */
  effectiveIntensity(x: number): number {
    return Math.max(x, this.director.floor);
  }

  /** Whether the score is in a sombre colour (retreat, capital falling, defeat). */
  sombre(retreat: boolean): boolean {
    return retreat || this.director.sombre;
  }

  nextBar(s: ScoreState): BarPlan {
    if (s.outcome !== this.lastOutcome) {
      if (s.outcome) this.director.post(s.outcome);
      this.lastOutcome = s.outcome;
    }
    this.director.tick();
    const e = this.effective(s);
    this.updateWant(e);
    const modeChanged = this.lastMode !== null && e.mode !== this.lastMode;
    const retreatChanged = e.retreat !== this.lastRetreat;
    this.lastMode = e.mode;
    this.lastRetreat = e.retreat;
    const ph = this.phrase;
    const ended = !ph || this.bar >= ph.theme.bars.length;
    const atHalf = ended || this.bar % 4 === 0;
    const inCue = !ended && (ph.style === 'stinger' || ph.style === 'fill');
    const cue = this.director.takeCue(atHalf, inCue);
    if (cue) this.startCue(cue, !ended);
    else if (ended) this.startPhrase(e, false);
    else if (!inCue && (modeChanged || (retreatChanged && atHalf))) this.startPhrase(e, true);
    else if (!inCue && this.want > this.tier && (atHalf || (this.want >= 2 && this.tier <= 1))) this.startPhrase(e, true);
    return this.compose();
  }

  /** The game state as the score hears it once the director's situation is applied. */
  private effective(s: ScoreState): ScoreState {
    const outcome = s.outcome ?? (s.mode === 'title' ? null : this.director.outcome);
    const mode: MusicMode = outcome && s.mode === 'battle' ? 'aftermath' : s.mode;
    return { mode, outcome, intensity: this.effectiveIntensity(s.intensity), retreat: this.sombre(s.retreat) };
  }

  private updateWant(s: ScoreState): void {
    const cap = s.mode === 'title' ? 2 : 3;
    const x = s.mode === 'title' ? s.intensity * 0.85 : s.mode === 'aftermath' ? 0 : s.intensity;
    if (this.want < cap && x > UP[this.want]) this.want++;
    else if (this.want > 0 && x < DOWN[this.want - 1]) this.want--;
    this.want = Math.min(this.want, cap);
  }

  private cycle(key: string, list: readonly ThemeId[]): ThemeId {
    const k0 = `${key}:${this.doctrine ?? '-'}`;
    const i = this.counters[k0] ?? 0;
    // Occasionally skip ahead so long sessions do not fall into a fixed loop (never on the
    // opening statement, never into a back-to-back repeat).
    let k = i;
    if (i > 0 && list.length > 2 && this.r() < 0.2 && list[(i + 1) % list.length] !== this.phrase?.theme.id) k = i + 1;
    this.counters[k0] = k + 1;
    return list[k % list.length];
  }

  private startCue(cue: CueId, interrupted: boolean): void {
    const tail = interrupted && this.phrase?.style !== 'stinger' ? this.voicer.last.slice() : null;
    this.bar = 0;
    this.setPhrase(THEMES[cue], 'stinger', this.tier, null, tail);
  }

  private startPhrase(s: ScoreState, interrupted: boolean): void {
    const tail = interrupted && this.phrase && this.phrase.style !== 'stinger' && this.phrase.style !== 'fill' ? this.voicer.last.slice() : null;
    this.bar = 0;
    const prevTier = this.tier;
    const prevStyle = this.phrase?.style;
    this.tier = this.want;
    const colour = this.doctrine ? DOCTRINES[this.doctrine] : null;
    const d = colour?.theme;
    const sit = this.director.situation;
    if (s.mode === 'aftermath') {
      const won = s.outcome === 'victory';
      const id = won ? this.cycle('hymn', ['hymn', 'interlude', 'main']) : this.cycle('lament', ['lament', 'interlude']);
      this.setPhrase(THEMES[id], won ? (id === 'hymn' ? 'hymn' : 'calm') : 'lament', 0, null, tail);
      return;
    }
    if (s.mode === 'battle' && s.retreat) {
      this.setPhrase(THEMES[this.cycle('retreat', ['lament', 'tensionB', 'lament', 'interlude'])], 'lament', Math.min(this.tier, 1), null, tail);
      return;
    }
    // Escalation into battle gets a one-bar dominant build (rolls + cymbal swell).
    if (this.tier >= 2 && prevTier <= 1 && prevStyle !== 'fill' && prevStyle !== 'stinger' && s.mode === 'battle') {
      this.setPhrase(THEMES.fill, 'fill', this.tier, colour, null);
      return;
    }
    const title = s.mode === 'title';
    if (this.tier === 0) {
      const id = this.cycle(title ? 'title0' : 'calm', title ? ['title', 'main', 'interlude', 'mainB'] : ['main', 'interlude', 'mainB', 'interlude']);
      this.setPhrase(THEMES[id], 'calm', 0, null, tail);
    } else if (this.tier === 1) {
      const list: readonly ThemeId[] = title ? ['main', 'tension', 'mainB', 'tensionB'] : d ? [d, 'tension', d, 'tensionB'] : ['tension', 'tensionB'];
      const id = this.cycle(title ? 'title1' : 'tension', list);
      this.setPhrase(THEMES[id], id.startsWith('main') ? 'calm' : 'tension', 1, title ? null : colour, tail);
    } else {
      let list: readonly ThemeId[];
      if (title) list = ['title', 'main', 'mainB'];
      else if (sit === 'triumph') list = ['main', 'battle', 'mainB'];
      else if (sit === 'offensive') list = d ? [d, 'battle'] : ['battle', 'battleA'];
      else list = d ? [d, 'battleA', d, 'battle'] : ['battleA', 'battle', 'battleA', 'battle', 'main', 'mainB'];
      const id = this.cycle(title ? 'title2' : `battle:${sit}`, list);
      this.setPhrase(THEMES[id], 'battle', this.tier, title ? null : colour, tail);
    }
  }

  private pickLead(theme: Theme, style: Style, tier: number, colour: DoctrineColour | null): InstId {
    const r = this.r;
    if (style === 'battle') return colour && tier >= 2 ? colour.lead : tier >= 3 ? 'brass' : 'horn';
    if (style === 'tension') return r() < 0.75 ? 'horn' : 'reed';
    if (style === 'hymn') return 'strings';
    if (style === 'stinger') return theme.id === 'defeat' || theme.id === 'threat' ? 'horn' : theme.id === 'fall' ? 'strings' : 'brass';
    if (theme.id === 'title') return 'horn';
    // Rotate the calm lead so consecutive statements change colour.
    const opts = (['reed', 'horn', 'strings', 'flute'] as const).filter((x) => x !== this.lastLead);
    return opts[Math.floor(r() * opts.length)];
  }

  private setPhrase(theme: Theme, style: Style, tier: number, colour: DoctrineColour | null, tail: readonly number[] | null): void {
    const r = this.r;
    const lead = this.pickLead(theme, style, tier, colour);
    let leadOct = 0;
    if (lead === 'strings' && style !== 'battle' && style !== 'stinger') leadOct = 12;
    if (style === 'lament' && lead === 'horn' && r() < 0.5) leadOct = -12;
    this.lastLead = lead;
    const vary: Variation = {
      lead, leadOct,
      counter: style === 'calm' || style === 'hymn' ? r() < 0.55 : false,
      walk: r() < 0.6,
      ost: Math.floor(r() * 3),
      snare: Math.floor(r() * SNARE_PATTERNS.length),
      stab: Math.floor(r() * STABS.length),
      double: r() < 0.5,
      windPad: style === 'calm' && r() < 0.4,
      flute: style === 'calm' ? r() < 0.4 : style === 'battle' ? colour?.id === 'builder' || r() < 0.6 : false,
    };
    const orn = style === 'calm' || style === 'lament' || style === 'hymn' ? 0.12 + r() * 0.3 : style === 'tension' ? 0.1 : 0;
    const bridge = this.phrase?.style === 'battle' && style !== 'battle' && style !== 'stinger';
    this.phrase = { theme, style, tier, bridge, tail: bridge ? null : tail, melody: this.ornament(theme, orn), vary, colour };
    this.targetBpm = this.tempoFor(theme, style, tier, colour);
  }

  private tempoFor(theme: Theme, style: Style, tier: number, colour: DoctrineColour | null): number {
    if (style === 'lament') return tier === 0 ? 52 : 58;
    if (style === 'stinger' || style === 'fill') return theme.bpm;
    const own = colour?.theme === theme.id;
    if (style === 'tension' && own) return Math.round(theme.bpm * 0.8);
    let bpm = theme.bpm;
    if (style === 'battle' && tier >= 3) bpm += 6;
    if (style === 'battle' && (theme.id.startsWith('main') || theme.id === 'title')) bpm += 34;
    if (colour && !own && (style === 'battle' || style === 'tension')) bpm += colour.bpm;
    return bpm;
  }

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

  private compose(): BarPlan {
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
    const seg = 4 / chords.length;
    const voicings = chords.map((c) => this.voicer.voice(c, this.r));
    const ctx: BarCtx = { ev, ph, bar, nBars, arc: arcFor(ph.style, bar), seg, chords, voicings, next: theme.bars[bar + 1]?.[0], bpm, r: this.r };
    harmony(ctx);
    melody(ctx);
    percussion(ctx);
    this.bar++;
    return { bpm, beats: 4, events: ev, theme: theme.id, bar, tier: ph.tier, situation: this.director.situation };
  }
}
