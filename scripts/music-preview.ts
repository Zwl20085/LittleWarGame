/**
 * Offline preview of the adaptive score: runs the same Conductor and sampled orchestra as
 * the game (src/audio/score.ts + orchestra.ts) and renders each scenario to a WAV file in
 * media/stats/music/. The Web Audio graph (section buses, brightness filters, panning,
 * hall reverb) is approximated in plain JS. Levels are the music stem at full music
 * volume, before the mixer's master glue compressor / limiter (not emulated).
 *
 *   npx vite-node scripts/music-preview.ts [seconds=80] [seed=7]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSample, sampleId, sampleKeys, sampleRoot, type MusicSample } from '../src/audio/orchestra';
import { brightness, Conductor, LAYER_BUS, LAYERS, layerTargets, type Layer, type MusicMode, type NoteEv, type Outcome, type Stinger } from '../src/audio/score';

const SR = 44100;
const FPS = 60;
const LOOKAHEAD = 0.35;
const SCORE_TRIM = 0.8;
const MAX_NOTES = 48;
const QUIET_VEL = 0.12;
/** Music bus gain at full slider (engine.applyVolumes: vol² · 0.9). */
const MUSIC_BUS = 0.9;
const REVERB_WET = 0.55;
const OUT_DIR = 'media/stats/music';

interface Frame {
  readonly mode: MusicMode;
  readonly intensity: number;
  readonly retreat: boolean;
  readonly outcome: Outcome;
  readonly stinger: Stinger | null;
}

interface Scenario {
  readonly name: string;
  readonly seconds: number;
  at(t: number): Frame;
}

interface Placed {
  readonly t: number;
  readonly spb: number;
  readonly e: NoteEv;
}

const frame = (mode: MusicMode, intensity: number, retreat = false, outcome: Outcome = null, stinger: Stinger | null = null): Frame => ({ mode, intensity, retreat, outcome, stinger });

function scenarios(secs: number): Scenario[] {
  return [
    { name: 'title', seconds: secs, at: () => frame('title', 0.12) },
    { name: 'calm', seconds: secs, at: () => frame('battle', 0.06) },
    { name: 'tension', seconds: secs, at: () => frame('battle', 0.38) },
    { name: 'battle', seconds: secs, at: () => frame('battle', 0.62) },
    { name: 'battle-full', seconds: secs, at: () => frame('battle', 0.92) },
    { name: 'retreat', seconds: secs, at: () => frame('battle', 0.4, true) },
    { name: 'victory', seconds: secs, at: (t) => (t < 20 ? frame('battle', 0.85) : frame('aftermath', 0, false, 'victory')) },
    { name: 'defeat', seconds: secs, at: (t) => (t < 20 ? frame('battle', 0.6, true) : frame('aftermath', 0, false, 'defeat')) },
    {
      name: 'journey',
      seconds: 180,
      at: (t) => {
        // Calm → build-up → battle (with an enemy capital falling) → losses → calm again.
        const x = t < 35 ? 0.05 : t < 70 ? 0.38 : t < 115 ? 0.9 : t < 150 ? 0.45 : 0.08;
        return frame('battle', x, t >= 115 && t < 150, null, t >= 95 && t < 95 + 1 / FPS ? 'capital' : null);
      },
    },
  ];
}

/** Rough sounding length of a note (sustained: duration + release; one-shot: sample length). */
const ONE_SHOT: Partial<Record<string, number>> = { spic: 0.4, timp: 2.4, snare: 0.32, bdrum: 1.6, cymbal: 3.2 };
const estLen = (e: NoteEv, spb: number): number => ONE_SHOT[e.inst] ?? e.dur * spb + e.rel * 1.25;

/** Drive the Conductor exactly like Music.update() does, at 60 fps. */
function schedule(sc: Scenario, seed: number): { notes: Placed[]; xs: Float32Array; frames: Frame[]; form: string } {
  const form: string[] = [];
  const cond = new Conductor(seed);
  const notes: Placed[] = [];
  const nFrames = Math.ceil(sc.seconds * FPS);
  const xs = new Float32Array(nFrames);
  const frames: Frame[] = [];
  let smoothI = 0;
  let x = 0;
  let nextBar = 0.15;
  const ends: number[] = [];
  for (let f = 0; f < nFrames; f++) {
    const now = f / FPS;
    const fr = sc.at(now);
    frames.push(fr);
    // engine.ts smoothing: quick to rise (1.5 s), slow to settle (6 s).
    smoothI += (fr.intensity - smoothI) * Math.min(1, 1 / FPS / (fr.intensity > smoothI ? 1.5 : 6));
    x += (smoothI - x) * 0.02;
    xs[f] = x;
    if (fr.stinger) cond.stinger(fr.stinger);
    while (nextBar < now + LOOKAHEAD) {
      const plan = cond.nextBar({ mode: fr.mode, intensity: smoothI, retreat: fr.retreat, outcome: fr.outcome });
      const spb = 60 / plan.bpm;
      if (plan.bar === 0 && nextBar < sc.seconds) form.push(`${Math.round(nextBar)}s ${plan.theme}/t${plan.tier}@${Math.round(plan.bpm)}`);
      for (const e of plan.events) {
        const t = nextBar + e.beat * spb;
        if (e.vel < QUIET_VEL && ends.filter((x) => x > t).length >= MAX_NOTES) continue;
        notes.push({ t, spb, e });
        ends.push(t + estLen(e, spb));
        if (ends.length > 96) ends.shift();
      }
      nextBar += plan.beats * spb;
    }
  }
  return { notes, xs, frames, form: form.join(' > ') };
}

/** Mix one note into a mono layer buffer (sample playback + the same gain envelope). */
function renderNote(out: Float32Array, p: Placed, s: MusicSample): number {
  const { e } = p;
  const rate = Math.pow(2, (e.midi - s.root) / 12) * (s.rate / SR);
  const start = Math.floor(p.t * SR);
  const loop = s.loopEnd > 0;
  const l0 = s.loopStart * s.rate;
  const l1 = s.loopEnd * s.rate;
  const dur = Math.max(0.05, e.dur * p.spb);
  const atk = Math.min(Math.max(0.005, e.atk), dur * 0.9);
  const rel = Math.max(0.05, e.rel);
  const len = loop ? Math.ceil((dur + rel * 1.25) * SR) : Math.ceil((s.data.length / s.rate) * SR / Math.pow(2, (e.midi - s.root) / 12));
  const relK = Math.exp(-1 / ((rel / 4) * SR));
  let pos = 0;
  let relG = 1;
  const n = Math.min(len, out.length - start);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = e.vel;
    if (loop) {
      if (t < atk) g *= t / atk;
      else if (t >= dur) {
        relG *= relK;
        g *= relG;
      }
    }
    const k = Math.floor(pos);
    if (!loop && k + 1 >= s.data.length) break;
    const a = s.data[k];
    const b = s.data[k + 1 < s.data.length ? k + 1 : k];
    out[start + i] += (a + (b - a) * (pos - k)) * g;
    pos += rate;
    if (loop && pos >= l1) pos -= l1 - l0;
  }
  return n / SR;
}

/** Small stereo Schroeder/Freeverb-style hall standing in for the game's convolution IR. */
function reverb(inL: Float32Array, inR: Float32Array): [Float32Array, Float32Array] {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356];
  const aps = [556, 441];
  const run = (input: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(input.length);
    for (const c of combs) {
      const len = Math.round((c + spread) * (SR / 44100) * 1.35);
      const buf = new Float32Array(len);
      let idx = 0;
      let lp = 0;
      for (let i = 0; i < input.length; i++) {
        const y = buf[idx];
        lp = y * 0.6 + lp * 0.4;
        buf[idx] = input[i] * 0.015 + lp * 0.86;
        out[i] += y;
        if (++idx >= len) idx = 0;
      }
    }
    for (const a of aps) {
      const len = a + spread;
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < out.length; i++) {
        const b = buf[idx];
        const x = out[i];
        buf[idx] = x + b * 0.5;
        out[i] = b - x;
        if (++idx >= len) idx = 0;
      }
    }
    return out;
  };
  return [run(inL, 0), run(inR, 23)];
}

function writeWav(path: string, l: Float32Array, r: Float32Array): void {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

function concurrency(spans: [number, number][]): [max: number, mean: number] {
  const ev: [number, number][] = [];
  for (const [a, b] of spans) ev.push([a, 1], [b, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  let area = 0;
  let last = 0;
  for (const [t, d] of ev) {
    area += cur * (t - last);
    last = t;
    max = Math.max(max, (cur += d));
  }
  return [max, area / Math.max(1e-9, last)];
}

const db = (x: number): string => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');

function renderScenario(sc: Scenario, bank: Map<string, MusicSample>, seed: number): void {
  const { notes, xs, frames, form } = schedule(sc, seed);
  const n = Math.ceil(sc.seconds * SR);
  const dryL = new Float32Array(n);
  const dryR = new Float32Array(n);
  const sendL = new Float32Array(n);
  const sendR = new Float32Array(n);
  const spans: [number, number][] = [];
  const peaks: string[] = [];
  const tauGain = 1 - Math.exp(-1 / (1.6 * SR));
  const tauBright = 1 - Math.exp(-1 / (1.5 * SR));
  for (const layer of LAYERS as readonly Layer[]) {
    const mono = new Float32Array(n);
    for (const p of notes) {
      if (p.e.layer !== layer || p.t >= sc.seconds) continue;
      const s = bank.get(sampleId(p.e.inst, sampleRoot(p.e.inst, p.e.midi), p.e.v));
      if (!s) continue;
      spans.push([p.t, p.t + renderNote(mono, p, s)]);
    }
    const cfg = LAYER_BUS[layer];
    const ang = ((cfg.pan + 1) * Math.PI) / 4;
    const pl = Math.cos(ang);
    const pr = Math.sin(ang);
    let g = 0;
    let fc = brightness(0);
    let y1 = 0;
    let y2 = 0;
    let layerPeak = 0;
    for (let i = 0; i < n; i++) {
      const f = Math.min(xs.length - 1, Math.floor((i / SR) * FPS));
      const fr = frames[f];
      if (i % 64 === 0) {
        const target = layerTargets(xs[f], fr.mode, fr.retreat)[layer];
        g += (target - g) * (1 - Math.pow(1 - tauGain, 64));
        fc += (brightness(xs[f]) - fc) * (1 - Math.pow(1 - tauBright, 64));
      }
      let v = mono[i] * g;
      if (cfg.bright) {
        // Two cascaded one-poles approximate the bus lowpass.
        const k = 1 - Math.exp((-2 * Math.PI * fc) / SR);
        y1 += k * (v - y1);
        y2 += k * (y1 - y2);
        v = y2;
      }
      layerPeak = Math.max(layerPeak, Math.abs(v));
      dryL[i] += v * pl;
      dryR[i] += v * pr;
      sendL[i] += v * pl * cfg.send;
      sendR[i] += v * pr * cfg.send;
    }
    peaks.push(`${layer} ${db(layerPeak * SCORE_TRIM * MUSIC_BUS)}`);
  }
  const [wl, wr] = reverb(sendL, sendR);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    dryL[i] = (dryL[i] * SCORE_TRIM + wl[i] * REVERB_WET * SCORE_TRIM) * MUSIC_BUS;
    dryR[i] = (dryR[i] * SCORE_TRIM + wr[i] * REVERB_WET * SCORE_TRIM) * MUSIC_BUS;
    peak = Math.max(peak, Math.abs(dryL[i]), Math.abs(dryR[i]));
    sum += dryL[i] * dryL[i] + dryR[i] * dryR[i];
  }
  const path = join(OUT_DIR, `${sc.name}.wav`);
  writeWav(path, dryL, dryR);
  const played = notes.filter((p) => p.t < sc.seconds);
  const [maxV, meanV] = concurrency(spans);
  console.log(
    `${path.padEnd(36)} ${sc.seconds}s  peak ${db(peak).padStart(6)} dBFS  rms ${db(Math.sqrt(sum / (2 * n))).padStart(6)} dBFS  ` +
      `notes/s ${(played.length / sc.seconds).toFixed(1).padStart(5)}  voices mean ${meanV.toFixed(1).padStart(4)} max ${maxV}`,
  );
  console.log(`  form: ${form}`);
  if (process.env.STEMS) console.log('  layer peaks (dBFS):', peaks.join(' | '));
}

function main(): void {
  const secs = Number(process.argv[2] ?? 80);
  const seed = Number(process.argv[3] ?? 7);
  mkdirSync(OUT_DIR, { recursive: true });
  const t0 = performance.now();
  const bank = new Map<string, MusicSample>();
  let bytes = 0;
  for (const k of sampleKeys()) {
    const s = renderSample(k);
    bank.set(sampleId(s.inst, s.root, s.v), s);
    bytes += s.data.byteLength;
  }
  console.log(`orchestra: ${bank.size} samples, ${(bytes / 1048576).toFixed(1)} MB, rendered in ${Math.round(performance.now() - t0)} ms`);
  const only = process.argv[4];
  for (const sc of scenarios(secs)) if (!only || only.split(',').includes(sc.name)) renderScenario(sc, bank, seed);
}

main();
