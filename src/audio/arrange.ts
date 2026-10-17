/**
 * Orchestration of one bar: which section plays which voice of the chord, with what
 * doubling, in what register. Follows the orchestration reference used for 3.0:
 * strings are the foundation (violas / second / first violins on the three upper voices,
 * first violins divisi an octave up for brilliance, celli with basses an octave below
 * for weight); horns bridge strings and brass (inner-voice chorale, heroic unison on the
 * tune at the climax); trumpets take the top of the stabs, trombones the open bottom;
 * woodwinds add colour (reed pad, flute an octave above the tune). Sustained lines are
 * contrasted with articulated ones (spiccato ostinato under held chords).
 */
import type { OstKind } from './doctrines';
import type { InstId } from './orchestra';
import { note, type BarCtx } from './notes';
import { BATTLE_OST16, BATTLE_OST8, MARCH_OST, STABS, TENSION_OST, TRIPLET_OST, type ChordInfo } from './themes';
import { place, scaleFor, stepFrom } from './voicing';

type OstUse = OstKind | 'tension' | 'lament' | 'fill';

/** Strings, bass, horns, brass and ostinato for the bar. */
export function harmony(c: BarCtx): void {
  const { ph, voicings, seg, ev } = c;
  if (ph.bridge && c.bar === 0) bridge(c);
  if (ph.tail && c.bar === 0) {
    // Crossfade from an interrupted phrase: its chord lets go over the first beat.
    for (let i = 1; i < 4; i++) ev.push(note(0, 0.5, 'strings', ph.tail[i], 0.15, 'strings', 0.01, 1.6));
  }
  voicings.forEach((v, k) => {
    const b0 = k * seg;
    strings(c, v, b0);
    bassLine(c, v[0], b0, k);
    if (ph.style === 'stinger') cueHarmony(c, v, b0);
    else sections(c, v, b0);
  });
}

function strings(c: BarCtx, v: readonly number[], b0: number): void {
  const { ph, seg, arc, ev } = c;
  const st = ph.style;
  const t = ph.tier;
  const sVel = (st === 'battle' ? 0.24 : st === 'tension' ? 0.26 : st === 'lament' ? 0.25 : 0.27) * arc;
  const sAtk = st === 'battle' ? 0.12 : st === 'lament' ? 1.0 : st === 'fill' ? 2.0 : st === 'stinger' ? 0.2 : 0.55;
  for (let i = 1; i < 4; i++) ev.push(note(b0, seg, 'strings', v[i], sVel, 'strings', sAtk, 1.2));
  // First violins divisi: the soprano an octave up for brilliance at climaxes.
  const divisi = (st === 'battle' && t >= 3) || st === 'hymn' || (st === 'stinger' && ph.theme.id !== 'defeat' && ph.theme.id !== 'threat');
  if (divisi && v[3] + 12 <= 88) ev.push(note(b0, seg, 'strings', v[3] + 12, sVel * 0.6, 'strings', sAtk, 1.2));
}

/** Bridge out of a battle: a held tremolo + horn chord and a dying timpani roll. */
function bridge(c: BarCtx): void {
  const v = c.voicings[0];
  c.ev.push(
    note(0, 2, 'trem', v[2] + 12, 0.2, 'trem', 0.02, 3), note(0, 2, 'trem', v[3] + 12, 0.2, 'trem', 0.02, 3),
    note(0, 2, 'horn', v[1], 0.22, 'horns', 0.05, 3), note(0, 2, 'horn', v[2], 0.2, 'horns', 0.05, 3),
  );
  for (let b = 0; b < 3; b += 0.25) c.ev.push(note(b, 0.25, 'timp', v[0] < 38 ? v[0] + 12 : v[0], 0.16 * (1 - b / 3), 'perc', 0, 0));
}

function sections(c: BarCtx, v: readonly number[], b0: number): void {
  const { ph, seg, arc, ev, bar } = c;
  const st = ph.style;
  const t = ph.tier;
  const low = ph.colour?.lowBrass ?? 1;
  if (st === 'tension' || (st === 'calm' && t >= 1)) {
    // Horns hold the inner voices, swelling in; trombones darken the second half.
    ev.push(note(b0, seg, 'horn', v[1], 0.17 * arc, 'horns', 1.0, 1.0), note(b0, seg, 'horn', v[2], 0.15 * arc, 'horns', 1.0, 1.0));
    if (st === 'tension' && bar >= 4) ev.push(note(b0, seg, 'tbn', v[0] + 12, 0.13 * arc * low, 'lowbrass', 0.8, 1.0));
  }
  if (st === 'calm' && ph.vary.windPad && t === 0) ev.push(note(b0, seg, 'reed', v[2], 0.12 * arc, 'winds', 0.6, 1.0));
  if (st === 'hymn') ev.push(note(b0, seg, 'tbn', v[0] + 12, 0.14 * arc, 'lowbrass', 0.5, 1.2), note(b0, seg, 'tbn', v[1], 0.12 * arc, 'lowbrass', 0.5, 1.2));
  if (st === 'battle' || st === 'fill') {
    const tv = st === 'fill' ? 0.2 : 0.16 + 0.06 * Math.min(t, 3);
    ev.push(note(b0, seg, 'trem', v[2] + 12, tv * arc, 'trem', 0.06, 0.6), note(b0, seg, 'trem', v[3] + 12, tv * arc, 'trem', 0.06, 0.6));
  }
  if (st === 'battle') {
    // Horn pads on the upper voices under the stabs (tier 3: the horns move to the tune).
    if (t < 3) ev.push(note(b0, seg, 'horn', v[2], 0.18 * arc, 'horns', 0.25, 0.6), note(b0, seg, 'horn', v[3], 0.16 * arc, 'horns', 0.25, 0.6));
    stabs(c, v, b0);
  }
  if (st === 'fill') {
    ev.push(note(0, 4, 'brass', v[2] + 12, 0.24, 'brass', 2.0, 0.3), note(0, 4, 'brass', v[3], 0.24, 'brass', 2.0, 0.3));
    ev.push(note(0, 4, 'tbn', v[0] + 12, 0.26 * low, 'lowbrass', 2.0, 0.3), note(0, 4, 'tbn', v[1], 0.24 * low, 'lowbrass', 2.0, 0.3));
  }
  if (st === 'lament' && t >= 1) ostinato(c, v[0], b0, seg, 'lament');
  if (st === 'tension' || (st === 'calm' && t >= 1)) ostinato(c, v[0], b0, seg, 'tension');
  if (st === 'battle' || st === 'fill') ostinato(c, v[0], b0, seg, st === 'fill' ? 'fill' : battleOst(c));
}

function battleOst(c: BarCtx): OstUse {
  const col = c.ph.colour;
  if (col) return col.ost[c.ph.tier >= 3 ? 1 : 0];
  return c.ph.tier >= 3 ? 'b16' : 'b8';
}

/** Cue phrases: threat (stopped horns, low tremolo, trombone pedal), offensive, fall, stingers. */
function cueHarmony(c: BarCtx, v: readonly number[], b0: number): void {
  const { ph, seg, ev, bar } = c;
  const id = ph.theme.id;
  if (id === 'threat') {
    ev.push(note(b0, seg, 'trem', v[1], 0.2, 'trem', 0.3, 1.5), note(b0, seg, 'trem', v[2], 0.18, 'trem', 0.3, 1.5));
    ev.push(note(b0, seg, 'tbn', v[0], 0.2, 'lowbrass', 0.6, 1.5), note(b0, seg, 'tbn', v[0] + 7 > 55 ? v[0] - 5 : v[0] + 7, 0.14, 'lowbrass', 0.6, 1.5));
    ostinato(c, v[0], b0, seg, 'tension');
    return;
  }
  if (id === 'fall') {
    // Brass chorale: trombones on the open bottom, horns inside.
    ev.push(note(b0, seg, 'tbn', v[0] + 12, 0.2, 'lowbrass', 0.3, 2.0), note(b0, seg, 'tbn', v[1], 0.17, 'lowbrass', 0.3, 2.0));
    ev.push(note(b0, seg, 'horn', v[2], 0.16, 'horns', 0.3, 2.0));
    return;
  }
  if (id === 'offensive') {
    ev.push(note(b0, seg, 'horn', v[1], 0.26, 'horns', 0.1, 0.8), note(b0, seg, 'horn', v[2], 0.26, 'horns', 0.1, 0.8));
    ev.push(note(b0, seg, 'tbn', v[0] + 12, 0.28, 'lowbrass', 0.08, 0.6));
    ev.push(note(b0, seg, 'trem', v[2] + 12, 0.2, 'trem', 0.05, 0.6), note(b0, seg, 'trem', v[3] + 12, 0.2, 'trem', 0.05, 0.6));
    ostinato(c, v[0], b0, seg, bar === 0 ? 'b8' : 'b16');
    return;
  }
  const soft = id === 'defeat';
  if (!soft) ev.push(note(b0, seg, 'trem', v[2] + 12, 0.2, 'trem', 0.06, 0.6), note(b0, seg, 'trem', v[3] + 12, 0.2, 'trem', 0.06, 0.6));
  const hv = soft ? 0.16 : 0.24;
  ev.push(note(b0, seg, 'horn', v[1], hv, 'horns', 0.15, 2.0), note(b0, seg, 'horn', v[2], hv, 'horns', 0.15, 2.0));
  ev.push(note(b0, seg, 'tbn', v[0] + 12, soft ? 0.14 : 0.24, 'lowbrass', 0.15, 2.0));
}

/** Celli on the bass line, basses an octave below for weight (never below E1). */
function bassLine(c: BarCtx, bass: number, b0: number, k: number): void {
  const { ph, seg, ev, next, chords, arc } = c;
  const st = ph.style;
  const vel = (st === 'battle' ? 0.3 : 0.34) * arc;
  const contra = (st !== 'calm' && st !== 'hymn') || ph.tier >= 1 || c.bar >= 4;
  const dbl = (n: number, b: number, len: number, atk: number): void => {
    if (contra && n - 12 >= 28) ev.push(note(b, len, 'basses', n - 12, vel * 0.55, 'bass', atk, 1.0));
  };
  const last = k === chords.length - 1;
  if (ph.vary.walk && last && next && seg >= 2 && (st === 'calm' || st === 'lament' || st === 'hymn')) {
    const target = place(next.bass, 36, 50, bass);
    const gap = target - bass;
    if (Math.abs(gap) >= 3 && Math.abs(gap) <= 5) {
      const pass = stepFrom(bass, gap > 0 ? 1 : -1, scaleFor(next));
      ev.push(note(b0, seg - 1, 'basses', bass, vel, 'bass', 0.3, 0.5), note(b0 + seg - 1, 1, 'basses', pass, vel * 0.85, 'bass', 0.12, 0.5));
      dbl(bass, b0, seg, 0.3);
      return;
    }
  }
  const atk = st === 'battle' ? 0.08 : 0.35;
  ev.push(note(b0, seg, 'basses', bass, vel, 'bass', atk, 1.0));
  dbl(bass, b0, seg, atk);
  // Tier 3: the tuba / bass trombone reinforces the bass line (power from the bottom).
  if (st === 'battle' && ph.tier >= 3) ev.push(note(b0, seg, 'tbn', bass, 0.16 * arc * (ph.colour?.lowBrass ?? 1), 'lowbrass', 0.15, 0.5));
}

function ostPattern(kind: OstUse, i: number): string {
  switch (kind) {
    case 'tension': return TENSION_OST[i % TENSION_OST.length];
    case 'b8': return BATTLE_OST8[i % BATTLE_OST8.length];
    case 'b16': return BATTLE_OST16[i % BATTLE_OST16.length];
    case 'triplet': return TRIPLET_OST[i % TRIPLET_OST.length];
    case 'march': return MARCH_OST[i % MARCH_OST.length];
    case 'lament': return 'R---R---';
    case 'fill': return 'RRRRRRRRRRRRRRRR';
  }
}

/** Spiccato celli / basses: the articulated line under the sustained harmony. */
export function ostinato(c: BarCtx, bass: number, b0: number, seg: number, kind: OstUse): void {
  const { ph, ev, arc } = c;
  const root = bass < 38 ? bass + 12 : bass;
  const pat = ostPattern(kind, ph.vary.ost);
  const steps = pat.length;
  const stepLen = 4 / steps;
  const beatSteps = steps / 4;
  const base = kind === 'tension' ? 0.3 : kind === 'lament' ? 0.22 : kind === 'march' ? 0.4 : 0.36;
  for (let i = 0; i < steps; i++) {
    const b = i * stepLen;
    if (b < b0 || b >= b0 + seg) continue;
    const ch = pat[i];
    if (ch === '-') continue;
    const off = ch === '8' ? 12 : ch === '5' ? 7 : 0;
    const acc = i % (steps / 2) === 0 ? 1 : i % beatSteps === 0 ? 0.8 : 0.62;
    const cresc = kind === 'fill' ? 0.5 + (b / 4) * 0.7 : 1;
    ev.push(note(b, stepLen, 'spic', root + off, base * acc * arc * cresc, 'ostinato', 0, 0));
  }
}

/** Brass stabs: trumpets on the top two voices, trombones on the open bottom (root + fifth). */
function stabs(c: BarCtx, v: readonly number[], b0: number): void {
  const { ph, ev, seg, arc, bar } = c;
  if (bar % 2 === 1 && ph.tier < 3) return;
  const vel = (ph.tier >= 3 ? 0.3 : 0.26) * arc;
  const low = ph.colour?.lowBrass ?? 1;
  const fifth = place((v[0] + 7) % 12, 45, 57, v[0] + 7);
  for (const [b, len] of STABS[ph.vary.stab]) {
    if (b < b0 || b >= b0 + seg) continue;
    ev.push(note(b, len, 'brass', v[2] + 12 <= 79 ? v[2] + 12 : v[2], vel, 'brass', 0.02, 0.25));
    ev.push(note(b, len, 'brass', v[3], vel * 0.9, 'brass', 0.02, 0.25));
    if (ph.tier >= 3 && v[3] + 12 <= 82) ev.push(note(b, len, 'brass', v[3] + 12, vel * 0.8, 'brass', 0.02, 0.25));
    ev.push(note(b, len, 'tbn', v[0] + 12, vel * low, 'lowbrass', 0.03, 0.3), note(b, len, 'tbn', fifth, vel * 0.85 * low, 'lowbrass', 0.03, 0.3));
  }
}

/** The tune, its doublings (horns in unison / octave, flutes 8va, violins) and the counter-line. */
export function melody(c: BarCtx): void {
  const { ph, bar, ev, arc, chords, seg } = c;
  const from = bar * 4;
  const st = ph.style;
  const vary = ph.vary;
  const lead = vary.lead;
  const leadVel = (lead === 'reed' ? 0.42 : lead === 'strings' ? 0.36 : lead === 'brass' ? 0.4 : lead === 'flute' ? 0.4 : 0.38) * (st === 'battle' ? 1.35 : 1);
  const stopped = ph.theme.id === 'threat';
  const atk = lead === 'strings' ? 0.18 : lead === 'reed' || lead === 'flute' ? 0.05 : 0.06;
  for (const [b, len, n] of ph.melody) {
    if (b < from || b >= from + 4) continue;
    const beat = b - from;
    const m = n + vary.leadOct;
    ev.push(note(beat, len, lead, m, (stopped ? 0.26 : leadVel) * arc, 'lead', atk, len >= 2 ? 0.9 : 0.4));
    doublings(c, beat, len, m);
    if (vary.counter && len >= 2) {
      const ch = chords[Math.min(chords.length - 1, Math.floor(beat / seg))];
      const below = counterNote(ch, n);
      if (below > 0) ev.push(note(beat, len, lead === 'reed' ? 'horn' : 'reed', below, 0.24 * arc, 'winds', 0.15, 0.8));
    }
  }
}

function doublings(c: BarCtx, beat: number, len: number, m: number): void {
  const { ph, ev, arc, bar } = c;
  const st = ph.style;
  const lead: InstId = ph.vary.lead;
  if (st === 'battle' && ph.tier >= 3) {
    // Tutti melody: horns in unison (an octave down if out of range), flutes 8va.
    ev.push(note(beat, len, 'horn', m <= 77 ? m : m - 12, 0.34 * arc, 'horns', 0.05, 0.4));
    if (ph.vary.flute && m + 12 <= 96) ev.push(note(beat, len, 'flute', m + 12, 0.2 * arc, 'winds', 0.04, 0.4));
  } else if (st === 'battle' && ph.vary.double && lead !== 'strings') ev.push(note(beat, len, 'strings', m + 12 <= 88 ? m + 12 : m, 0.24 * arc, 'strings', 0.08, 0.5));
  else if (st === 'battle' && lead === 'strings') ev.push(note(beat, len, 'horn', m - 12 >= 41 ? m - 12 : m, 0.3 * arc, 'horns', 0.05, 0.4));
  if (st === 'hymn' || (st === 'stinger' && ph.theme.id === 'fall')) ev.push(note(beat, len, 'horn', m - 12, 0.22 * arc, 'horns', 0.1, 0.8));
  if (st === 'stinger' && ph.theme.id === 'offensive') ev.push(note(beat, len, 'horn', m - 12, 0.3, 'horns', 0.04, 0.4));
  // Calm: flute + violin colour over the second half of the phrase.
  if (st === 'calm' && ph.vary.flute && bar >= 4 && lead !== 'flute' && m + 12 <= 96) ev.push(note(beat, len, 'flute', m + 12, 0.16 * arc, 'winds', 0.08, 0.8));
}

/** Chord tone a third-to-sixth below the melody note (for the counter line). */
function counterNote(ch: ChordInfo, n: number): number {
  for (let d = 3; d <= 9; d++) if (ch.tones.includes((n - d) % 12)) return n - d >= 45 ? n - d : -1;
  return -1;
}
