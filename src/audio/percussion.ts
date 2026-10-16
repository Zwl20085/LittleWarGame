/**
 * Percussion of one bar: timpani on tonic / dominant (rolls into cadences), field snare,
 * gran cassa and suspended cymbal. Restraint first — a single crash on a phrase head
 * outweighs constant activity. Doctrine colours scale the snare and the bass drum.
 */
import { SWELL_PEAK, type InstId } from './orchestra';
import { note, type BarCtx } from './notes';
import { SNARE_FILL, SNARE_PATTERNS } from './themes';

const timpNote = (bass: number): number => {
  let n = bass;
  while (n < 38) n += 12;
  while (n > 50) n -= 12;
  return n;
};

/** Even roll (or measured strokes) from `from` to `to` beats with a velocity ramp. */
function roll(c: BarCtx, from: number, to: number, inst: InstId, midi: number, v0: number, v1: number, step: number): void {
  for (let b = from; b < to - 1e-6; b += step) {
    const k = (b - from) / (to - from);
    c.ev.push(note(b, step, inst, midi, v0 + (v1 - v0) * k, 'perc', 0, 0, inst === 'snare' ? Math.floor(c.r() * 4) : 0));
  }
}

export function percussion(c: BarCtx): void {
  const st = c.ph.style;
  if (st === 'calm' || st === 'hymn' || st === 'lament') quiet(c);
  else if (st === 'tension') tension(c);
  else if (st === 'fill') fill(c);
  else if (st === 'stinger') cue(c);
  else battle(c);
}

function swellBeat(c: BarCtx): number {
  return 4 - (SWELL_PEAK * c.bpm) / 60;
}

function quiet(c: BarCtx): void {
  const { ph, bar, nBars, ev, voicings } = c;
  const st = ph.style;
  const tn = timpNote(voicings[0][0]);
  if (bar === 0) ev.push(note(0, 1, 'timp', tn, st === 'hymn' ? 0.3 : 0.2, 'perc', 0, 0));
  if (bar === 4) ev.push(note(0, 1, 'timp', tn, 0.14, 'perc', 0, 0));
  if (bar === nBars - 1 && ph.vary.walk && st !== 'lament') roll(c, 2, 4, 'timp', tn, 0.03, 0.1, 0.25);
  if (st === 'lament' && ph.tier >= 1) {
    ev.push(note(0, 0.33, 'timp', tn, 0.16, 'perc', 0, 0), note(0.33, 1, 'timp', tn, 0.24, 'perc', 0, 0));
    if (bar >= nBars - 2) roll(c, 0, 4, 'snare', 60, bar === nBars - 2 ? 0.02 : 0.07, bar === nBars - 2 ? 0.07 : 0.12, 0.125);
  }
}

function tension(c: BarCtx): void {
  const { ph, bar, nBars, ev, voicings } = c;
  const tn = timpNote(voicings[0][0]);
  if (bar < nBars - 2) ev.push(note(0, 0.33, 'timp', tn, 0.2, 'perc', 0, 0), note(0.33, 1, 'timp', tn, 0.32, 'perc', 0, 0));
  else roll(c, 0, 4, 'timp', tn, bar === nBars - 2 ? 0.03 : 0.09, bar === nBars - 2 ? 0.09 : 0.18, 0.25);
  const snare = ph.colour?.snare ?? 1;
  const swellA = ph.vary.snare % 2 === 0 && (bar === 2 || bar === 3);
  if (snare > 0.5 && (swellA || bar === 6 || bar === 7)) {
    const first = bar % 2 === 0;
    roll(c, 0, 4, 'snare', 60, first ? 0.02 : 0.1, first ? 0.1 : 0.22, 0.125);
  }
  const sb = swellBeat(c);
  if (bar === nBars - 1 && sb >= 0) ev.push(note(sb, 4 - sb, 'cymbal', 60, 0.22, 'perc', 0, 0, 0));
}

function fill(c: BarCtx): void {
  roll(c, 0, 4, 'timp', 45, 0.05, 0.24, 0.25);
  roll(c, 0, 4, 'snare', 60, 0.04, 0.3, 0.125);
  const sb = swellBeat(c);
  if (sb >= 0) c.ev.push(note(sb, 4 - sb, 'cymbal', 60, 0.42, 'perc', 0, 0, 0));
}

function cue(c: BarCtx): void {
  const { ph, bar, nBars, ev, voicings } = c;
  const id = ph.theme.id;
  const tn = timpNote(voicings[0][0]);
  const last = bar === nBars - 1;
  if (id === 'threat') {
    // Heartbeat on the timpani, a distant bass drum under it.
    ev.push(note(0, 0.5, 'timp', tn, 0.34, 'perc', 0, 0), note(0.6, 0.5, 'timp', tn, 0.22, 'perc', 0, 0));
    ev.push(note(2, 0.5, 'timp', tn, 0.3, 'perc', 0, 0), note(2.6, 0.5, 'timp', tn, 0.2, 'perc', 0, 0), note(0, 1, 'bdrum', 60, 0.2, 'perc', 0, 0));
    if (last) roll(c, 2, 4, 'snare', 60, 0.03, 0.14, 0.125);
    return;
  }
  if (id === 'offensive') {
    // Snare roll crescendo across the call into a crash on the next downbeat.
    roll(c, 0, 4, 'snare', 60, bar === 0 ? 0.05 : 0.16, bar === 0 ? 0.16 : 0.38, 0.125);
    ev.push(note(0, 1, 'timp', tn, 0.45, 'perc', 0, 0), note(2, 1, 'timp', tn + 7 > 52 ? tn - 5 : tn + 7, 0.35, 'perc', 0, 0));
    const sb = swellBeat(c);
    if (last && sb >= 0) ev.push(note(sb, 4 - sb, 'cymbal', 60, 0.35, 'perc', 0, 0, 0));
    return;
  }
  if (id === 'fall') {
    // A toll every bar: timpani with the gran cassa, a soft crash on the first.
    ev.push(note(0, 1, 'timp', tn, 0.42, 'perc', 0, 0), note(0, 1, 'bdrum', 60, 0.36, 'perc', 0, 0));
    if (bar === 0) ev.push(note(0, 1, 'cymbal', 60, 0.2, 'perc', 0, 0, 1));
    if (last) roll(c, 2, 4, 'timp', tn, 0.05, 0.2, 0.25);
    return;
  }
  if (bar === 0) {
    ev.push(note(0, 1, 'timp', tn, id === 'defeat' ? 0.3 : 0.75, 'perc', 0, 0));
    if (id !== 'defeat') ev.push(note(0, 1, 'cymbal', 60, 0.45, 'perc', 0, 0, 1), note(0, 1, 'bdrum', 60, 0.5, 'perc', 0, 0));
  }
  if (bar === nBars - 2) roll(c, 0, 4, 'timp', tn, 0.04, id === 'defeat' ? 0.12 : 0.24, 0.25);
  if (last && bar > 0) {
    ev.push(note(0, 1, 'timp', tn, id === 'defeat' ? 0.32 : 0.7, 'perc', 0, 0), note(0, 1, 'bdrum', 60, id === 'defeat' ? 0.3 : 0.45, 'perc', 0, 0));
    if (id === 'victory') ev.push(note(0, 1, 'cymbal', 60, 0.5, 'perc', 0, 0, 1));
  }
}

/** Battle: march snare, timpani on the strong beats, gran cassa and crash on phrase heads. */
function battle(c: BarCtx): void {
  const { ph, bar, nBars, ev, voicings, r } = c;
  const t = ph.tier;
  const col = ph.colour;
  const snareW = col?.snare ?? 1;
  const tn = timpNote(voicings[0][0]);
  const last = bar === nBars - 1;
  const snareGain = (t >= 3 ? 0.36 : 0.26) * Math.min(1.2, snareW);
  const pat = last ? SNARE_FILL : SNARE_PATTERNS[(ph.vary.snare + (bar % 4 === 3 ? 1 : 0)) % SNARE_PATTERNS.length];
  for (let i = 0; i < 16; i++) {
    const ch = pat[i];
    const b = i / 4;
    if (ch === '.') {
      if (t >= 3 && snareW >= 1 && r() < 0.2) ev.push(note(b, 0.25, 'snare', 60, 0.05, 'perc', 0, 0, 2));
      continue;
    }
    // A light snare (builder) keeps only the accents.
    if (ch === 'x' && snareW < 0.6) continue;
    const vel = (ch === 'x' ? 0.42 : 1) * snareGain * (last ? 0.6 + 0.5 * (i / 16) : 1);
    if (ch === 'F') ev.push(note(b - 0.06 < 0 ? 0 : b - 0.06, 0.06, 'snare', 60, vel * 0.35, 'perc', 0, 0, 3));
    ev.push(note(b, 0.25, 'snare', 60, vel, 'perc', 0, 0, i % 4));
  }
  const fifth = tn + 7 > 52 ? tn - 5 : tn + 7;
  ev.push(note(0, 1, 'timp', tn, 0.55, 'perc', 0, 0), note(2, 1, 'timp', bar % 2 ? fifth : tn, 0.4, 'perc', 0, 0));
  if (col?.id === 'maneuver') ev.push(note(3 + 1 / 3, 1 / 3, 'timp', tn, 0.22, 'perc', 0, 0), note(3 + 2 / 3, 1 / 3, 'timp', tn, 0.28, 'perc', 0, 0));
  const heavy = t >= 3 || col?.id === 'attrition';
  if (heavy) ev.push(note(3.5, 0.5, 'timp', tn, 0.3, 'perc', 0, 0), note(0, 1, 'bdrum', 60, 0.42, 'perc', 0, 0), note(2, 1, 'bdrum', 60, 0.3, 'perc', 0, 0));
  else if (t >= 2 && bar % 2 === 0) ev.push(note(0, 1, 'bdrum', 60, 0.22, 'perc', 0, 0));
  if (bar === 0) ev.push(note(0, 1, 'cymbal', 60, t >= 3 ? 0.4 : 0.3, 'perc', 0, 0, 1));
  if (last) {
    roll(c, 3, 4, 'timp', tn, 0.1, 0.2, 0.25);
    const sb = swellBeat(c);
    if (sb >= 0) ev.push(note(sb, 4 - sb, 'cymbal', 60, 0.3, 'perc', 0, 0, 0));
  }
}
