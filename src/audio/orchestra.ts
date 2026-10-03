/**
 * Sampled orchestra for the score, synthesised in plain JS (no Web Audio) so it can be built
 * in a worker and rendered offline. Sustained instruments get a baked attack and a sealed
 * loop region (played with AudioBufferSourceNode.loop); percussion is one-shot.
 * Pitched instruments are sampled every few semitones and resampled at playback.
 */
import { rng, TAU } from './dsp';

export type InstId = 'strings' | 'trem' | 'horn' | 'brass' | 'reed' | 'spic' | 'timp' | 'snare' | 'bdrum' | 'cymbal';

export interface MusicSample {
  readonly inst: InstId;
  readonly root: number;
  readonly v: number;
  readonly rate: number;
  readonly data: Float32Array;
  /** Loop region in seconds; loopEnd 0 means one-shot. */
  readonly loopStart: number;
  readonly loopEnd: number;
}

export interface SampleKey {
  readonly inst: InstId;
  readonly root: number;
  readonly v: number;
}

interface Rendered {
  readonly data: Float32Array;
  readonly loopStart: number;
  readonly loopEnd: number;
}

interface Spec {
  readonly lo: number;
  readonly hi: number;
  readonly step: number;
  readonly variants: number;
  readonly rate: number;
  render(sr: number, midi: number, v: number): Rendered;
}

const TONAL_RATE = 24000;
const PERC_RATE = 32000;
/** Seconds from the start of a cymbal swell (variant 0) to its peak. */
export const SWELL_PEAK = 1.9;

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const CENT = Math.log(2) / 1200;

// ---- Building blocks --------------------------------------------------------------------

function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Band-limited (PolyBLEP) sawtooth / square oscillator. */
class Osc {
  private ph: number;
  constructor(phase: number, private readonly square = false) {
    this.ph = phase;
  }
  next(dt: number): number {
    let p = this.ph + dt;
    if (p >= 1) p -= 1;
    this.ph = p;
    const saw = 2 * p - 1 - blep(p, dt);
    if (!this.square) return saw;
    let q = p + 0.5;
    if (q >= 1) q -= 1;
    return 0.5 * (saw - (2 * q - 1 - blep(q, dt)));
  }
}

/** Zero-delay-feedback state-variable filter (stable under modulation). */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  set(fc: number, sr: number, q: number): void {
    const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
    const k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  /** Returns lowpass; bandpass is available via `bp` after the call. */
  bp = 0;
  lp(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    return v2;
  }
}

/** Equal-power crossfade of the loop tail into the audio just before the loop start. */
function sealLoop(buf: Float32Array, sr: number, l0: number, l1: number, fade: number): Float32Array {
  const n = Math.min(Math.floor(fade * sr), l0, Math.floor((l1 - l0) / 2));
  const out = buf.slice(0, l1);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * (Math.PI / 2);
    const idx = l1 - n + i;
    out[idx] = buf[idx] * Math.cos(a) + buf[l0 - n + i] * Math.sin(a);
  }
  return out;
}

function normRms(buf: Float32Array, from: number, target: number): void {
  let s = 0;
  for (let i = from; i < buf.length; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / Math.max(1, buf.length - from));
  if (rms <= 0) return;
  const g = target / rms;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
}

function normPeak(buf: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  if (m > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / m;
  const fade = Math.min(buf.length, 128);
  for (let i = 0; i < fade; i++) buf[buf.length - 1 - i] *= i / fade;
  return buf;
}

/** Cheap one-pole highpass (DC / rumble removal). */
function dcBlock(buf: Float32Array, sr: number, fc: number): void {
  const k = 1 - Math.exp((-TAU * fc) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += k * (buf[i] - y);
    buf[i] -= y;
  }
}

// ---- Sustained ensembles -----------------------------------------------------------------

interface Ensemble {
  readonly voices: number;
  /** Total detune spread across the section (cents). */
  readonly spread: number;
  readonly square: boolean;
  readonly attack: number;
  readonly vibRate: number;
  readonly vibCents: number;
  readonly vibDelay: number;
  /** Filter cutoff (Hz) at time t (s) for fundamental f. */
  cutoff(f: number, t: number): number;
  readonly q: number;
  readonly drive: number;
  /** Per-voice tremolo rate (0 = none). */
  readonly trem: number;
  readonly breath: number;
}

const SUSTAIN_LEN = 2.0;
const LOOP_START = 0.55;
const LOOP_FADE = 0.35;

function ensemble(sr: number, midi: number, seed: number, e: Ensemble): Rendered {
  const r = rng(seed);
  const n = Math.ceil(SUSTAIN_LEN * sr);
  const buf = new Float32Array(n);
  const f = mtof(midi);
  for (let k = 0; k < e.voices; k++) {
    const osc = new Osc(r(), e.square);
    const det = e.voices > 1 ? (k / (e.voices - 1) - 0.5) * e.spread + (r() - 0.5) * 3 : 0;
    const base = f * Math.exp(det * CENT);
    const vibW = (TAU * (e.vibRate * (0.92 + r() * 0.16))) / sr;
    let vibPh = r() * TAU;
    const driftW = (TAU * (0.13 + r() * 0.2)) / sr;
    let driftPh = r() * TAU;
    const tremW = (TAU * e.trem * (0.9 + r() * 0.2)) / sr;
    let tremPh = r() * TAU;
    const lag = r() * 0.03 * sr;
    const amp = (0.8 + r() * 0.4) / Math.sqrt(e.voices);
    let dt = base / sr;
    for (let i = 0; i < n; i++) {
      // Pitch modulation at control rate (every 16 samples) keeps the render cheap.
      if ((i & 15) === 0) {
        const t = i / sr;
        const vd = Math.min(1, Math.max(0, (t - e.vibDelay) / 0.4));
        const cents = Math.sin(vibPh) * e.vibCents * vd + Math.sin(driftPh) * 2.5;
        vibPh += vibW * 16;
        driftPh += driftW * 16;
        dt = (base * (1 + cents * CENT)) / sr;
      }
      let a = amp;
      if (e.trem > 0) {
        const s = 0.5 + 0.5 * Math.sin(tremPh);
        a *= 0.35 + 0.65 * s * s;
        tremPh += tremW;
      }
      const on = Math.min(1, Math.max(0, (i - lag) / (e.attack * sr)));
      buf[i] += osc.next(dt) * a * on * on * (3 - 2 * on);
    }
  }
  if (e.breath > 0) {
    const bf = new Svf();
    bf.set(Math.min(sr * 0.4, f * 2.5), sr, 1.5);
    for (let i = 0; i < n; i++) {
      bf.lp(r() * 2 - 1);
      const t = i / sr;
      buf[i] += bf.bp * e.breath * (1 + 2 * Math.exp(-t / 0.06));
    }
  }
  const flt = new Svf();
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) flt.set(e.cutoff(f, i / sr), sr, e.q);
    const y = flt.lp(buf[i]);
    buf[i] = e.drive > 0 ? Math.tanh(y * e.drive) / e.drive : y;
  }
  dcBlock(buf, sr, 40);
  const l0 = Math.floor(LOOP_START * sr);
  const out = sealLoop(buf, sr, l0, n, LOOP_FADE);
  normRms(out, l0, 0.22);
  return { data: out, loopStart: LOOP_START, loopEnd: out.length / sr };
}

const STRINGS: Ensemble = {
  voices: 6, spread: 18, square: false, attack: 0.22, vibRate: 5.3, vibCents: 7, vibDelay: 0.2,
  cutoff: (f) => Math.min(5200, 750 + f * 5), q: 0.62, drive: 0, trem: 0, breath: 0.012,
};
const TREM: Ensemble = { ...STRINGS, voices: 5, attack: 0.05, cutoff: (f) => Math.min(6500, 1100 + f * 6), trem: 12, vibCents: 4 };
const HORN: Ensemble = {
  voices: 3, spread: 8, square: false, attack: 0.07, vibRate: 4.6, vibCents: 5, vibDelay: 0.35,
  cutoff: (f, t) => Math.min(2800, 280 + f * 3) * (1 + 1.1 * Math.exp(-t / 0.09)), q: 0.85, drive: 1.3, trem: 0, breath: 0.006,
};
const BRASS: Ensemble = {
  voices: 3, spread: 10, square: false, attack: 0.03, vibRate: 5.5, vibCents: 6, vibDelay: 0.45,
  cutoff: (f, t) => Math.min(6500, 500 + f * 6) * (t < 0.04 ? 0.35 + (t / 0.04) * 1.15 : 1 + 0.5 * Math.exp(-(t - 0.04) / 0.12)),
  q: 1.0, drive: 2.2, trem: 0, breath: 0.004,
};
const REED: Ensemble = {
  voices: 1, spread: 0, square: true, attack: 0.05, vibRate: 5.0, vibCents: 5, vibDelay: 0.3,
  cutoff: (f) => Math.min(3600, f * 5), q: 0.75, drive: 0, trem: 0, breath: 0.02,
};

// ---- Short strings and percussion --------------------------------------------------------

/** Celli/basses spiccato: bright bite, fast exponential decay. */
function spiccato(sr: number, midi: number, seed: number): Rendered {
  const r = rng(seed);
  const n = Math.ceil(0.4 * sr);
  const buf = new Float32Array(n);
  const f = mtof(midi);
  for (let k = 0; k < 4; k++) {
    const osc = new Osc(r());
    const dt = (f * Math.exp(((k / 3 - 0.5) * 16 + (r() - 0.5) * 4) * CENT)) / sr;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.006) * Math.exp(-t / 0.13);
      buf[i] += osc.next(dt) * env * 0.5;
    }
  }
  const flt = new Svf();
  for (let i = 0; i < n; i++) {
    if ((i & 15) === 0) flt.set(Math.min(sr * 0.4, f * (2.5 + 9 * Math.exp(-i / sr / 0.05)) + 200), sr, 0.8);
    buf[i] = flt.lp(buf[i] + (i < sr * 0.012 ? (r() * 2 - 1) * 0.15 : 0));
  }
  dcBlock(buf, sr, 30);
  return { data: normPeak(buf, 0.8), loopStart: 0, loopEnd: 0 };
}

/** Timpani: inharmonic membrane modes, a small pitch drop and a felt-mallet thump. */
function timpani(sr: number, midi: number, seed: number): Rendered {
  const r = rng(seed);
  const n = Math.ceil(2.4 * sr);
  const buf = new Float32Array(n);
  const f = mtof(midi);
  const modes: readonly (readonly [number, number, number])[] = [[1, 1, 2.6], [1.5, 0.45, 1.3], [1.98, 0.3, 0.9], [2.44, 0.16, 0.6], [2.96, 0.08, 0.4]];
  for (const [ratio, amp, decay] of modes) {
    let ph = r() * TAU;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const fr = f * ratio * (1 + 0.035 * Math.exp(-t / 0.07));
      ph += (TAU * fr) / sr;
      buf[i] += Math.sin(ph) * amp * Math.exp(-t / decay) * Math.min(1, t / 0.002);
    }
  }
  const thump = new Svf();
  thump.set(380, sr, 0.7);
  for (let i = 0; i < Math.min(n, sr * 0.12); i++) buf[i] += thump.lp(r() * 2 - 1) * 0.9 * Math.exp(-i / sr / 0.025);
  return { data: normPeak(buf, 0.9), loopStart: 0, loopEnd: 0 };
}

/** Military field snare: wires (band noise), shell modes and a stick click. */
function snareDrum(sr: number, v: number): Rendered {
  const r = rng(700 + v * 13);
  const n = Math.ceil(0.32 * sr);
  const buf = new Float32Array(n);
  const wires = new Svf();
  wires.set(3800 + v * 350, sr, 0.7);
  const decay = 0.11 + v * 0.015;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    wires.lp(r() * 2 - 1);
    buf[i] = wires.bp * 1.1 * Math.exp(-t / decay) * Math.min(1, t / 0.0015);
  }
  for (const [fr, amp, dec] of [[185 + v * 6, 0.55, 0.05], [330 + v * 9, 0.3, 0.035]] as const) {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      ph += (TAU * fr * (1 + 0.15 * Math.exp(-i / sr / 0.01))) / sr;
      buf[i] += Math.sin(ph) * amp * Math.exp(-i / sr / dec);
    }
  }
  for (let i = 0; i < sr * 0.003; i++) buf[i] += (r() * 2 - 1) * 0.6;
  dcBlock(buf, sr, 120);
  return { data: normPeak(buf, 0.9), loopStart: 0, loopEnd: 0 };
}

/** Gran cassa: low membrane with pitch drop and a soft beater. */
function bassDrum(sr: number): Rendered {
  const r = rng(911);
  const n = Math.ceil(1.6 * sr);
  const buf = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (TAU * 46 * (1 + 0.5 * Math.exp(-t / 0.05))) / sr;
    buf[i] = Math.sin(ph) * Math.exp(-t / 0.55) + Math.sin(ph * 1.6) * 0.25 * Math.exp(-t / 0.2);
  }
  const lp = new Svf();
  lp.set(260, sr, 0.7);
  for (let i = 0; i < sr * 0.15; i++) buf[i] += lp.lp(r() * 2 - 1) * 0.8 * Math.exp(-i / sr / 0.04);
  return { data: normPeak(buf, 0.9), loopStart: 0, loopEnd: 0 };
}

/** Suspended cymbal: v0 = soft-mallet swell peaking at SWELL_PEAK, v1 = crash. */
function cymbal(sr: number, v: number): Rendered {
  const r = rng(500 + v);
  const len = v === 0 ? SWELL_PEAK + 0.5 : 3.2;
  const n = Math.ceil(len * sr);
  const buf = new Float32Array(n);
  const hp = new Svf();
  hp.set(5200, sr, 0.6);
  // Metallic partials (inharmonic) give the noise a pitched shimmer.
  const parts = [3150, 4420, 5310, 6870, 8120].map((fr) => ({ w: (TAU * fr * (0.97 + r() * 0.06)) / sr, ph: r() * TAU }));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = v === 0 ? (t < SWELL_PEAK ? Math.pow(t / SWELL_PEAK, 2.6) : Math.exp(-(t - SWELL_PEAK) / 0.12)) : Math.min(1, t / 0.003) * (0.35 * Math.exp(-t / 0.08) + 0.65 * Math.exp(-t / 1.1));
    const noise = r() * 2 - 1;
    const hi = noise - hp.lp(noise);
    let sh = 0;
    for (const p of parts) {
      p.ph += p.w;
      sh += Math.sin(p.ph);
    }
    buf[i] = (hi * 0.8 + sh * 0.05) * env;
  }
  return { data: normPeak(buf, 0.85), loopStart: 0, loopEnd: 0 };
}

// ---- Catalogue ---------------------------------------------------------------------------

const tonal = (lo: number, hi: number, e: Ensemble, salt: number): Spec => ({
  lo, hi, step: 4, variants: 1, rate: TONAL_RATE,
  render: (sr, midi) => ensemble(sr, midi, salt + midi * 31, e),
});

export const INSTRUMENTS: Record<InstId, Spec> = {
  strings: tonal(36, 88, STRINGS, 1000),
  trem: tonal(48, 84, TREM, 2000),
  horn: tonal(41, 77, HORN, 3000),
  brass: tonal(41, 81, BRASS, 4000),
  reed: tonal(45, 81, REED, 5000),
  spic: { lo: 26, hi: 62, step: 3, variants: 1, rate: TONAL_RATE, render: (sr, m) => spiccato(sr, m, 6000 + m) },
  timp: { lo: 36, hi: 52, step: 3, variants: 1, rate: PERC_RATE, render: (sr, m) => timpani(sr, m, 7000 + m) },
  snare: { lo: 60, hi: 60, step: 1, variants: 4, rate: PERC_RATE, render: (sr, _m, v) => snareDrum(sr, v) },
  bdrum: { lo: 60, hi: 60, step: 1, variants: 1, rate: PERC_RATE, render: (sr) => bassDrum(sr) },
  cymbal: { lo: 60, hi: 60, step: 1, variants: 2, rate: PERC_RATE, render: (sr, _m, v) => cymbal(sr, v) },
};

/** Render order: what the calm score needs first, battle-only instruments last. */
const ORDER: readonly InstId[] = ['strings', 'reed', 'timp', 'spic', 'horn', 'snare', 'cymbal', 'brass', 'trem', 'bdrum'];

export function sampleKeys(): SampleKey[] {
  const keys: SampleKey[] = [];
  for (const inst of ORDER) {
    const s = INSTRUMENTS[inst];
    for (let root = s.lo; root <= s.hi; root += s.step) for (let v = 0; v < s.variants; v++) keys.push({ inst, root, v });
  }
  return keys;
}

export function renderSample(k: SampleKey): MusicSample {
  const s = INSTRUMENTS[k.inst];
  const r = s.render(s.rate, k.root, k.v);
  return { inst: k.inst, root: k.root, v: k.v, rate: s.rate, data: r.data, loopStart: r.loopStart, loopEnd: r.loopEnd };
}

/** Nearest sampled root for a note on an instrument. */
export function sampleRoot(inst: InstId, midi: number): number {
  const s = INSTRUMENTS[inst];
  const last = s.lo + Math.floor((s.hi - s.lo) / s.step) * s.step;
  return Math.max(s.lo, Math.min(last, s.lo + Math.round((midi - s.lo) / s.step) * s.step));
}

export const sampleId = (inst: InstId, root: number, v: number): string => `${inst}:${root}:${v}`;
