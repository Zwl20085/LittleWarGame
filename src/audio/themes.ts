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
  | 'title' | 'main' | 'mainB' | 'interlude' | 'tension' | 'tensionB' | 'battleA' | 'battle'
  | 'lament' | 'hymn' | 'fill' | 'victory' | 'defeat' | 'capital'
  // 3.0: one theme per AI doctrine (see doctrines.ts) and the situation motifs (director.ts).
  | 'builder' | 'blitz' | 'attrition' | 'maneuver'
  | 'threat' | 'offensive' | 'fall';

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

// ---- 3.0 themes ----------------------------------------------------------------------------

/**
 * Main title: a horn call (rising fourth, then fifth) answered by the strings, climbing to
 * the high F and turning through a Neapolitan Eb onto the dominant (half cadence, so the
 * next statement of the main theme lands as the answer).
 */
const TITLE_MEL: readonly Mel[] = [
  [0, 1, 57], [1, 1, 62], [2, 2, 69],
  [4, 1.5, 70], [5.5, 0.5, 69], [6, 2, 65],
  [8, 1, 65], [9, 1, 69], [10, 2, 72],
  [12, 1, 74], [13, 1, 72], [14, 2, 67],
  [16, 1.5, 70], [17.5, 0.5, 72], [18, 2, 74],
  [20, 1, 77], [21, 1, 76], [22, 2, 74],
  [24, 2, 75], [26, 1, 74], [27, 1, 70],
  [28, 3, 73], [31, 1, 69],
];

/** Builder (优先发育): pastoral D Dorian, stepwise, the raised sixth (B natural) on G major. */
const BUILDER_MEL: readonly Mel[] = [
  [0, 1, 62], [1, 1, 64], [2, 1, 65], [3, 1, 69],
  [4, 2, 71], [6, 1, 69], [7, 1, 67],
  [8, 1.5, 65], [9.5, 0.5, 64], [10, 2, 62],
  [12, 1, 64], [13, 1, 67], [14, 2, 72],
  [16, 1.5, 72], [17.5, 0.5, 74], [18, 2, 77],
  [20, 1, 74], [21, 1, 71], [22, 2, 74],
  [24, 1, 74], [25, 1, 72], [26, 2, 70],
  [28, 4, 69],
];

/** Blitz (一波直捣黄龙): repeated-note anapests over a Phrygian bII (Eb) — a charge. */
const BLITZ_MEL: readonly Mel[] = [
  [0, 0.5, 62], [0.5, 0.25, 62], [0.75, 0.25, 62], [1, 1, 69], [2, 0.5, 69], [2.5, 0.5, 70], [3, 1, 69],
  [4, 0.5, 70], [4.5, 0.25, 70], [4.75, 0.25, 70], [5, 1, 67], [6, 2, 63],
  [8, 0.5, 62], [8.5, 0.25, 62], [8.75, 0.25, 62], [9, 1, 69], [10, 0.5, 72], [10.5, 0.5, 70], [11, 1, 69],
  [12, 1, 67], [13, 1, 70], [14, 2, 75],
  [16, 0.5, 74], [16.5, 0.25, 74], [16.75, 0.25, 74], [17, 1, 77], [18, 1, 74], [19, 1, 70],
  [20, 0.5, 72], [20.5, 0.25, 72], [20.75, 0.25, 72], [21, 1, 76], [22, 1, 72], [23, 1, 67],
  [24, 1, 67], [25, 1, 70], [26, 2, 74],
  [28, 1, 73], [29, 1, 76], [30, 2, 73],
];

/** Attrition (稳扎稳打): narrow, low, grinding march over a descending lament bass. */
const ATTRITION_MEL: readonly Mel[] = [
  [0, 2, 62], [2, 1, 62], [3, 1, 64],
  [4, 2, 65], [6, 2, 64],
  [8, 1.5, 62], [9.5, 0.5, 64], [10, 2, 62],
  [12, 2, 61], [14, 2, 57],
  [16, 2, 62], [18, 1, 65], [19, 1, 69],
  [20, 2, 70], [22, 1, 69], [23, 1, 65],
  [24, 1.5, 67], [25.5, 0.5, 65], [26, 2, 62],
  [28, 2, 64], [30, 2, 61],
];

/** Maneuver (寻机决战): sweeping octave leaps, a pivot through the relative major (F). */
const MANEUVER_MEL: readonly Mel[] = [
  [0, 1, 57], [1, 1, 69], [2, 2, 74],
  [4, 1, 74], [5, 1, 70], [6, 2, 65],
  [8, 1, 60], [9, 1, 72], [10, 2, 77],
  [12, 1.5, 76], [13.5, 0.5, 74], [14, 2, 72],
  [16, 1, 62], [17, 1, 69], [18, 1, 74], [19, 1, 77],
  [20, 2, 79], [22, 1, 77], [23, 1, 74],
  [24, 1, 77], [25, 1, 74], [26, 2, 70],
  [28, 2, 69], [30, 1, 73], [31, 1, 76],
];

/** Home threatened: a stopped-horn semitone (D-Eb-D, A-Bb-A) over a D pedal. */
const THREAT_MEL: readonly Mel[] = [
  [0, 1, 62], [1, 1, 63], [2, 2, 62],
  [4, 1, 69], [5, 1, 70], [6, 2, 69],
];

/** Offensive launched: a trumpet call (anapest, rising fifth to the octave), open on A. */
const OFFENSIVE_MEL: readonly Mel[] = [
  [0, 0.5, 62], [0.5, 0.25, 62], [0.75, 0.25, 62], [1, 1, 69], [2, 0.5, 69], [2.5, 0.5, 69], [3, 1, 74],
  [4, 1, 74], [5, 1, 77], [6, 2, 76],
];

/** Capital falling: a descending lament through the Neapolitan (Eb/G) onto the dominant. */
const FALL_MEL: readonly Mel[] = [
  [0, 2, 74], [2, 1, 72], [3, 1, 70],
  [4, 2, 69], [6, 2, 67],
  [8, 3, 70], [11, 1, 67],
  [12, 2, 64], [14, 2, 61],
];

const theme = (id: ThemeId, bpm: number, chords: string, melody: readonly Mel[]): Theme => ({ id, bpm, bars: prog(chords), melody });

export const THEMES: Record<ThemeId, Theme> = {
  title: theme('title', 72, 'Dm | Bb | F | C | Gm | Dm/F | Eb | A', TITLE_MEL),
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
  builder: theme('builder', 76, 'Dm | G | Dm | C | F | G | Bb | A', BUILDER_MEL),
  blitz: theme('blitz', 116, 'Dm | Eb | Dm | Eb | Bb | C | Gm | A', BLITZ_MEL),
  attrition: theme('attrition', 80, 'Dm | Dm/C | Gm/Bb | A | Dm | Bb | Gm | A', ATTRITION_MEL),
  maneuver: theme('maneuver', 96, 'Dm | Bb | F | C/E | Dm | Gm | Bb | A', MANEUVER_MEL),
  threat: theme('threat', 84, 'Dm | Eb/D', THREAT_MEL),
  offensive: theme('offensive', 104, 'Dm | Bb A', OFFENSIVE_MEL),
  fall: theme('fall', 54, 'Dm | Gm/Bb | Eb/G | A', FALL_MEL),
};

// ---- Rhythm patterns ----------------------------------------------------------------------

/** Field-snare bars on 16ths: F flam, X accent, x tap, . rest. */
export const SNARE_PATTERNS: readonly string[] = ['F..xX.x.X..xX.xx', 'X.xxX.x.X.xxXxx.', 'F...x.x.X...xxXx'];
export const SNARE_FILL = 'X.xxX.xxxxxxXXXX';

/** Low-string ostinati: R root, 5 fifth, 8 octave, - rest. */
export const TENSION_OST: readonly string[] = ['RRRRRRRR', 'R-RRR-RR'];
export const BATTLE_OST8: readonly string[] = ['RR8R5R8R', 'RRR8RR58', 'R8R8R5R8'];
export const BATTLE_OST16: readonly string[] = ['RRRRRR8RRRRR5R8R', 'R-RRR-R8R-RRR-58'];
/** Triplet (12 steps per bar) gallop for the maneuver doctrine. */
export const TRIPLET_OST: readonly string[] = ['R-RR-R8-RR-5', 'RRRRRRR8R5R8'];
/** Heavy march (attrition): root on the beat, fifth and octave pick-ups. */
export const MARCH_OST: readonly string[] = ['R--5R--5R--5R-58', 'R---R--5R---R-88'];

/** Brass chord stabs: [beat, length] pairs within a bar. */
export const STABS: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0.75], [2.5, 0.5], [3, 1]],
  [[0, 1.5], [1.5, 0.5], [2, 2]],
  [[0, 0.5], [0.75, 0.25], [1, 1], [3, 0.5]],
];
