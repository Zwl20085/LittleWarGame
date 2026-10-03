/**
 * Musical material for the score (pure data, no Web Audio): chord progressions written as
 * lead-sheet symbols, the hand-written themes and the rhythmic patterns. Everything is in
 * D minor / D Aeolian, with D major (and a Lydian E/D) reserved for victory.
 */

/** [beat from phrase start, length in beats, midi]. */
export type Mel = readonly [beat: number, len: number, midi: number];

export interface ChordInfo {
  readonly sym: string;
  readonly root: number;
  /** Pitch class in the bass (differs from root for slash chords). */
  readonly bass: number;
  readonly tones: readonly number[];
  readonly third: number;
  /** Pitch class of the seventh, or -1. */
  readonly seventh: number;
}

export type ThemeId =
  | 'main' | 'mainB' | 'interlude' | 'tension' | 'tensionB' | 'battleA' | 'battle'
  | 'lament' | 'hymn' | 'fill' | 'victory' | 'defeat' | 'capital';

export interface Theme {
  readonly id: ThemeId;
  readonly bpm: number;
  /** One entry per 4/4 bar; a bar with two chords splits it in halves. */
  readonly bars: readonly (readonly ChordInfo[])[];
  readonly melody: readonly Mel[];
}

const PC: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const QUALITY: Record<string, readonly number[]> = { '': [0, 4, 7], m: [0, 3, 7], sus: [0, 5, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11] };

export function parseChord(sym: string): ChordInfo {
  const m = /^([A-G][b#]?)(m7|maj7|m|sus|7)?(?:\/([A-G][b#]?))?$/.exec(sym);
  if (!m) throw new Error(`bad chord symbol: ${sym}`);
  const root = PC[m[1]];
  const iv = QUALITY[m[2] ?? ''];
  const tones = iv.map((i) => (root + i) % 12);
  return { sym, root, bass: m[3] ? PC[m[3]] : root, tones, third: tones[1], seventh: iv.length > 3 ? tones[3] : -1 };
}

const prog = (s: string): ChordInfo[][] => s.split('|').map((bar) => bar.trim().split(/\s+/).map(parseChord));

// ---- Melodies ---------------------------------------------------------------------------

/** Main theme: rising fifth, sighing fall, climb to the high F and home through C#. */
const MAIN_MEL: readonly Mel[] = [
  [0, 1.5, 62], [1.5, 0.5, 64], [2, 2, 69],
  [4, 1, 70], [5, 1, 69], [6, 2, 65],
  [8, 1.5, 67], [9.5, 0.5, 69], [10, 1, 72], [11, 1, 70],
  [12, 4, 69],
  [16, 1.5, 62], [17.5, 0.5, 64], [18, 2, 69],
  [20, 1, 70], [21, 1, 72], [22, 2, 74],
  [24, 1.5, 77], [25.5, 0.5, 76], [26, 2, 73],
  [28, 4, 74],
];

/** Interlude: the opening cell answered in sequence, sparse, ending on the leading tone. */
const INTERLUDE_MEL: readonly Mel[] = [
  [0, 1.5, 62], [1.5, 0.5, 64], [2, 2, 69],
  [4, 1.5, 65], [5.5, 0.5, 67], [6, 2, 72],
  [8, 1.5, 67], [9.5, 0.5, 69], [10, 2, 74],
  [12, 4, 69],
  [16, 2, 74], [18, 1, 72], [19, 1, 70],
  [20, 4, 69],
  [24, 1, 70], [25, 1, 69], [26, 2, 67],
  [28, 2, 64], [30, 2, 61],
];

/** Tension motif: a four-note climb that keeps restarting a step higher, left on the dominant. */
const TENSION_MEL: readonly Mel[] = [
  [0, 1, 57], [1, 1, 62], [2, 1, 64], [3, 5, 65],
  [8, 1, 58], [9, 1, 62], [10, 1, 65], [11, 3, 67], [14, 2, 65],
  [16, 1, 62], [17, 1, 67], [18, 1, 69], [19, 1, 70], [20, 3, 70], [23, 1, 67],
  [24, 4, 69], [28, 2, 76], [30, 2, 73],
];

/** Battle theme (consequent, full cadence): dotted bugle figures, brass range. */
const BATTLE_MEL: readonly Mel[] = [
  [0, 0.75, 62], [0.75, 0.25, 62], [1, 2, 69], [3, 0.75, 65], [3.75, 0.25, 64],
  [4, 1.5, 64], [5.5, 0.5, 67], [6, 2, 72],
  [8, 0.75, 70], [8.75, 0.25, 69], [9, 1, 70], [10, 1, 74], [11, 1, 72],
  [12, 2, 69], [14, 1, 73], [15, 1, 76],
  [16, 0.75, 74], [16.75, 0.25, 74], [17, 2, 77], [19, 0.75, 76], [19.75, 0.25, 74],
  [20, 1.5, 72], [21.5, 0.5, 69], [22, 2, 65],
  [24, 1, 67], [25, 1, 70], [26, 1, 69], [27, 1, 73],
  [28, 3, 74],
];

/** Battle theme antecedent: same first six bars, ends open on the dominant. */
const BATTLE_A_MEL: readonly Mel[] = [
  ...BATTLE_MEL.filter(([b]) => b < 24),
  [24, 1, 67], [25, 1, 70], [26, 2, 74],
  [28, 2, 73], [30, 1, 76], [31, 1, 73],
];

const VICTORY_MEL: readonly Mel[] = [
  [0, 0.5, 57], [0.5, 0.5, 62], [1, 1, 66], [2, 2, 69],
  [4, 2, 71], [6, 1, 68], [7, 1, 71],
  [8, 4, 74],
];

const DEFEAT_MEL: readonly Mel[] = [
  [0, 2, 57], [2, 1, 58], [3, 1, 57],
  [4, 2, 58], [6, 2, 55],
  [8, 4, 57],
];

const CAPITAL_MEL: readonly Mel[] = [
  [0, 0.5, 57], [0.5, 0.5, 62], [1, 1.5, 66], [2.5, 0.5, 66], [3, 1, 69],
  [4, 4, 74],
];

const theme = (id: ThemeId, bpm: number, chords: string, melody: readonly Mel[]): Theme => ({ id, bpm, bars: prog(chords), melody });

export const THEMES: Record<ThemeId, Theme> = {
  main: theme('main', 66, 'Dm | Bb | C | A | Dm | Gm | Bb A | Dm', MAIN_MEL),
  // Reharmonised restatement: descending lament bass D-C-Bb-A under the second half.
  mainB: theme('mainB', 66, 'Dm | Gm | C | A | Dm Dm/C | Gm/Bb | Bb A | Dm', MAIN_MEL),
  interlude: theme('interlude', 64, 'Dm | F | Gm | Dm | Bb | F | Gm | A', INTERLUDE_MEL),
  tension: theme('tension', 76, 'Dm | Dm | Bb | Bb | Gm | Eb | A | A', TENSION_MEL),
  tensionB: theme('tensionB', 78, 'Dm | Dm/C | Gm/Bb | Bb | Gm | Eb | Asus | A', TENSION_MEL),
  battleA: theme('battleA', 100, 'Dm | C | Bb | A | Dm | F | Gm | A', BATTLE_A_MEL),
  battle: theme('battle', 100, 'Dm | C | Bb | A | Dm | F | Gm A | Dm', BATTLE_MEL),
  lament: theme('lament', 56, 'Dm | Gm | C | A | Dm Dm/C | Gm/Bb | Gm A | Dm', MAIN_MEL),
  // Victory hymn: the main theme with a Picardy D major and modal-mixture Gm.
  hymn: theme('hymn', 60, 'D | Bb | C | A | D | Gm | Bb A | D', MAIN_MEL),
  fill: theme('fill', 92, 'A', []),
  // Lydian lift: E major over a D pedal before landing on D major.
  victory: theme('victory', 72, 'D | E/D | D', VICTORY_MEL),
  defeat: theme('defeat', 50, 'Dm | Bb/D Gm/D | Dm', DEFEAT_MEL),
  capital: theme('capital', 84, 'D | D', CAPITAL_MEL),
};

// ---- Rhythm patterns ----------------------------------------------------------------------

/** Field-snare bars on 16ths: F flam, X accent, x tap, . rest. */
export const SNARE_PATTERNS: readonly string[] = ['F..xX.x.X..xX.xx', 'X.xxX.x.X.xxXxx.', 'F...x.x.X...xxXx'];
export const SNARE_FILL = 'X.xxX.xxxxxxXXXX';

/** Low-string ostinati: R root, 5 fifth, 8 octave, - rest. */
export const TENSION_OST: readonly string[] = ['RRRRRRRR', 'R-RRR-RR'];
export const BATTLE_OST8: readonly string[] = ['RR8R5R8R', 'RRR8RR58', 'R8R8R5R8'];
export const BATTLE_OST16: readonly string[] = ['RRRRRR8RRRRR5R8R', 'R-RRR-R8R-RRR-58'];

/** Brass chord stabs: [beat, length] pairs within a bar. */
export const STABS: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0.75], [2.5, 0.5], [3, 1]],
  [[0, 1.5], [1.5, 0.5], [2, 2]],
  [[0, 0.5], [0.75, 0.25], [1, 1], [3, 0.5]],
];
