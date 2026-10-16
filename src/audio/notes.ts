/**
 * Shared vocabulary of the composer (score.ts, arrange.ts, percussion.ts): layers, note
 * events, phrase / bar context. Pure data, no Web Audio.
 */
import type { DoctrineColour } from './doctrines';
import { dynLayer, type InstId } from './orchestra';
import type { ChordInfo, Mel, Theme } from './themes';

/**
 * Section buses, each with its own gain (crossfaded with intensity / situation), pan,
 * reverb send and optional brightness filter. Seating follows a film-score stage:
 * violins left, celli / basses right, horns left-centre, trumpets and trombones right.
 */
export const LAYERS = ['strings', 'bass', 'winds', 'horns', 'brass', 'lowbrass', 'ostinato', 'trem', 'perc', 'lead'] as const;
export type Layer = (typeof LAYERS)[number];

export interface NoteEv {
  /** Beat offset from the bar start (may be fractional). */
  readonly beat: number;
  readonly dur: number;
  readonly inst: InstId;
  readonly midi: number;
  readonly vel: number;
  readonly layer: Layer;
  /** Sample variant: the dynamic layer (sustained brass) or the hit variant (percussion). */
  readonly v: number;
  /** Attack / release in seconds (sustained instruments only). */
  readonly atk: number;
  readonly rel: number;
}

export type Style = 'calm' | 'tension' | 'battle' | 'lament' | 'hymn' | 'fill' | 'stinger';

export interface Variation {
  readonly lead: InstId;
  readonly leadOct: number;
  readonly counter: boolean;
  readonly walk: boolean;
  readonly ost: number;
  readonly snare: number;
  readonly stab: number;
  readonly double: boolean;
  /** Calm: the reeds hold the alto voice as a woodwind colour. */
  readonly windPad: boolean;
  /** The flutes double the tune an octave up (second half of calm phrases, tutti in battle). */
  readonly flute: boolean;
}

export interface Phrase {
  readonly theme: Theme;
  readonly style: Style;
  readonly tier: number;
  /** First bar carries the decaying tail of a battle that just ended (no hard cut). */
  readonly bridge: boolean;
  /** Voicing of an interrupted phrase, released over the first beat (crossfade). */
  readonly tail: readonly number[] | null;
  readonly melody: readonly Mel[];
  readonly vary: Variation;
  /** Doctrine colour of battle / tension phrases (null = default score). */
  readonly colour: DoctrineColour | null;
}

export interface BarCtx {
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
  readonly r: () => number;
}

/** A note event; sustained brass picks its dynamic layer from the velocity unless `v` is given. */
export function note(beat: number, dur: number, inst: InstId, midi: number, vel: number, layer: Layer, atk: number, rel: number, v?: number): NoteEv {
  return { beat, dur, inst, midi, vel, layer, v: v ?? dynLayer(inst, vel), atk, rel };
}
