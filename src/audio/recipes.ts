import { alloc, bandpass, finish, highpass, loopSeal, lowpass, noiseBurst, partial, rng, rumble, sweep, TAU } from './dsp';

/**
 * Sound recipes: each returns a mono Float32Array at sample rate `sr`.
 * `v` is the variant index (different deterministic seed / small timing changes).
 */
export type Recipe = (sr: number, v: number) => Float32Array;

/** A single rifle report: sharp crack + short body + a bit of field echo. */
function crack(buf: Float32Array, sr: number, r: () => number, t: number, amp: number, bright: number): void {
  noiseBurst(buf, sr, r, t, amp * bright, 0.004);
  noiseBurst(buf, sr, r, t + 0.002, amp * 0.5, 0.03);
  sweep(buf, sr, t, 190, 90, 0.04, amp * 0.6, 0.035);
  noiseBurst(buf, sr, r, t + 0.05 + r() * 0.04, amp * 0.12, 0.12, 0.02);
}

const rifleVolley: Recipe = (sr, v) => {
  const r = rng(101 + v * 17);
  const b = alloc(sr, 0.9);
  const n = 3 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) crack(b, sr, r, 0.005 + r() * 0.42, 0.45 + r() * 0.55, 1.3);
  highpass(b, sr, 140);
  return finish(b, 0.8);
};

const mgBurst: Recipe = (sr, v) => {
  const r = rng(202 + v * 31);
  const b = alloc(sr, 1.0);
  const n = 6 + Math.floor(r() * 4);
  const rate = 0.072 + r() * 0.012;
  for (let i = 0; i < n; i++) crack(b, sr, r, 0.004 + i * rate + r() * 0.006, 0.8 + r() * 0.2, 1.0);
  highpass(b, sr, 120);
  return finish(b, 0.85);
};

/** Big gun: transient + falling thump + noisy body + long rumble. */
function boom(b: Float32Array, sr: number, r: () => number, f0: number, f1: number, body: number, tail: number): void {
  noiseBurst(b, sr, r, 0, 1.2, 0.006);
  sweep(b, sr, 0, f0, f1, 0.25, 1.1, body * 0.6);
  const n = alloc(sr, b.length / sr);
  noiseBurst(n, sr, r, 0, 1, body, 0.002);
  lowpass(n, sr, 900);
  for (let i = 0; i < b.length; i++) b[i] += n[i] * 0.9;
  rumble(b, sr, r, 0.02, 2.2, tail, 0.05);
}

const tankCannon: Recipe = (sr, v) => {
  const r = rng(303 + v * 7);
  const b = alloc(sr, 1.8);
  boom(b, sr, r, 120 - v * 15, 45, 0.22, 0.5);
  return finish(lowpass(b, sr, 5200), 0.9);
};

const atGun: Recipe = (sr, v) => {
  const r = rng(404 + v * 9);
  const b = alloc(sr, 1.3);
  noiseBurst(b, sr, r, 0, 1.0, 0.01);
  boom(b, sr, r, 170, 70, 0.14, 0.32);
  return finish(lowpass(b, sr, 7000), 0.9);
};

const mortarLaunch: Recipe = (sr, v) => {
  const r = rng(505 + v);
  const b = alloc(sr, 0.7);
  sweep(b, sr, 0, 240, 95, 0.06, 1.0, 0.06);
  const n = alloc(sr, 0.7);
  noiseBurst(n, sr, r, 0, 1, 0.07, 0.003);
  bandpass(n, sr, 420, 1.2);
  for (let i = 0; i < b.length; i++) b[i] += n[i] * 1.4;
  rumble(b, sr, r, 0.01, 0.8, 0.15);
  return finish(b, 0.8);
};

const howitzerLaunch: Recipe = (sr, v) => {
  const r = rng(606 + v * 13);
  const b = alloc(sr, 3.2);
  boom(b, sr, r, 85, 32, 0.35, 0.9);
  return finish(lowpass(b, sr, 3200), 0.95);
};

/** Incoming shell: falling whistle that grows louder, cut just before impact. */
function whistle(sr: number, v: number, dur: number, f0: number, f1: number): Float32Array {
  const r = rng(707 + v * 3);
  const b = alloc(sr, dur);
  const m = Math.pow(f1 / f0, 1 / b.length);
  let f = f0;
  let ph = 0;
  for (let i = 0; i < b.length; i++) {
    const x = i / b.length;
    f *= m;
    ph += (TAU * f * (1 + 0.004 * Math.sin(TAU * 7 * i / sr))) / sr;
    const env = x * Math.sqrt(x) * (x > 0.97 ? (1 - x) / 0.03 : 1);
    b[i] = (Math.sin(ph) * 0.8 + Math.sin(ph * 2) * 0.08) * env + (r() * 2 - 1) * 0.06 * env;
  }
  return finish(b, 0.6);
}
const shellWhistle: Recipe = (sr, v) => whistle(sr, v, 1.25, 1500 - v * 120, 620);
const bombWhistle: Recipe = (sr, v) => whistle(sr, v, 2.0, 1000 - v * 80, 330);

/** Debris: scattered small clicks of falling earth / fragments. */
function debris(b: Float32Array, sr: number, r: () => number, t0: number, span: number, n: number, amp: number): void {
  for (let i = 0; i < n; i++) noiseBurst(b, sr, r, t0 + r() * span, amp * (0.3 + r() * 0.7), 0.004 + r() * 0.01);
}

const explosionSmall: Recipe = (sr, v) => {
  const r = rng(808 + v * 19);
  const b = alloc(sr, 1.6);
  noiseBurst(b, sr, r, 0, 1.0, 0.012);
  sweep(b, sr, 0, 110, 45, 0.18, 1.0, 0.16);
  const n = alloc(sr, 1.6);
  noiseBurst(n, sr, r, 0, 1, 0.18, 0.002);
  lowpass(n, sr, 1400);
  for (let i = 0; i < b.length; i++) b[i] += n[i] * 1.1;
  rumble(b, sr, r, 0.03, 1.4, 0.35);
  debris(b, sr, r, 0.15, 0.6, 14, 0.12);
  return finish(b, 0.9);
};

const explosionBig: Recipe = (sr, v) => {
  const r = rng(909 + v * 23);
  const b = alloc(sr, 3.4);
  boom(b, sr, r, 70, 28, 0.45, 0.9);
  debris(b, sr, r, 0.3, 1.4, 26, 0.1);
  return finish(lowpass(b, sr, 3800), 0.95);
};

const apHit: Recipe = (sr, v) => {
  const r = rng(1010 + v * 5);
  const b = alloc(sr, 0.8);
  const base = 480 + v * 70;
  const ratios = [1, 2.41, 3.83, 5.27, 6.9];
  ratios.forEach((k, i) => partial(b, sr, 0, base * k * (1 + (r() - 0.5) * 0.02), 0.5 / (i + 1), 0.25 / (1 + i * 0.6)));
  noiseBurst(b, sr, r, 0, 0.8, 0.01);
  sweep(b, sr, 0, 140, 60, 0.05, 0.7, 0.06);
  return finish(b, 0.8);
};

const ricochet: Recipe = (sr, v) => {
  const r = rng(1111 + v * 11);
  const b = alloc(sr, 0.55);
  noiseBurst(b, sr, r, 0, 0.6, 0.003);
  let ph = 0;
  let f = 2900 + v * 300;
  const m = Math.pow(0.42, 1 / (0.5 * sr));
  let e = 0.5;
  const k = Math.exp(-1 / (0.16 * sr));
  for (let i = 0; i < b.length; i++) {
    f *= m;
    ph += (TAU * f * (1 + 0.03 * Math.sin(TAU * 31 * i / sr))) / sr;
    b[i] += Math.sin(ph) * e * Math.min(1, i / (0.01 * sr));
    e *= k;
  }
  return finish(b, 0.55);
};

const flak: Recipe = (sr, v) => {
  const r = rng(1212 + v);
  const b = alloc(sr, 1.0);
  for (let i = 0; i < 2; i++) {
    const t = i * 0.16 + r() * 0.02;
    noiseBurst(b, sr, r, t, 0.9, 0.008);
    sweep(b, sr, t, 150, 70, 0.05, 0.8, 0.07);
  }
  rumble(b, sr, r, 0.02, 0.8, 0.22);
  return finish(b, 0.8);
};

const vehicleDeath: Recipe = (sr, v) => {
  const r = rng(1313 + v * 29);
  const b = alloc(sr, 3.8);
  boom(b, sr, r, 75, 30, 0.4, 0.8);
  // Metal clatter and ammunition cook-off pops.
  for (let i = 0; i < 4; i++) partial(b, sr, 0.05 + r() * 0.2, 300 + r() * 900, 0.15, 0.2);
  for (let i = 0; i < 5; i++) {
    const t = 0.6 + r() * 2.2;
    noiseBurst(b, sr, r, t, 0.35 + r() * 0.3, 0.02);
    sweep(b, sr, t, 160, 80, 0.04, 0.25, 0.05);
  }
  return finish(lowpass(b, sr, 4500), 0.95);
};

/** Radial-engine drone loop: harmonic stack with blade-rate beating, sealed for looping. */
const engineLoop: Recipe = (sr, v) => {
  const r = rng(1414 + v);
  const dur = 2.2;
  const b = alloc(sr, dur);
  const f = 52 + v * 6;
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    let s = 0;
    for (let k = 1; k <= 5; k++) s += Math.sin(TAU * f * k * t + k * 1.3) / (k * 0.9);
    const am = 0.7 + 0.3 * Math.sin(TAU * 3.6 * t);
    b[i] = s * am * 0.3 + (r() * 2 - 1) * 0.15;
  }
  lowpass(b, sr, 900);
  return finish(loopSeal(b, sr, 0.3), 0.7);
};

const rumbleLoop: Recipe = (sr, v) => {
  const r = rng(1515 + v);
  const b = alloc(sr, 6.5);
  rumble(b, sr, r, 0, 3, 1e9, 0.0001);
  lowpass(b, sr, 160);
  return finish(loopSeal(b, sr, 1.0), 0.8);
};

const uiClick: Recipe = (sr, v) => {
  const r = rng(1616 + v);
  const b = alloc(sr, 0.06);
  noiseBurst(b, sr, r, 0, 0.6, 0.0015);
  partial(b, sr, 0.001, 1850 + v * 250, 0.35, 0.012);
  partial(b, sr, 0.001, 620, 0.25, 0.01);
  return finish(b, 0.5);
};

/** Brass hand-bell (inharmonic bell partials). */
function bell(sr: number, freq: number, dur: number, seed: number): Float32Array {
  const r = rng(seed);
  const b = alloc(sr, dur);
  const ratios = [0.5, 1, 1.19, 1.56, 2, 2.51, 2.66, 3.01, 4.1];
  ratios.forEach((k, i) => partial(b, sr, 0, freq * k * (1 + (r() - 0.5) * 0.003), (i === 1 ? 0.6 : 0.3) / (1 + i * 0.35), dur * 0.35 / (1 + i * 0.25)));
  noiseBurst(b, sr, r, 0, 0.15, 0.003);
  return finish(b, 0.7);
}
const bellChime: Recipe = (sr) => bell(sr, 784, 2.6, 1717);
const bellToll: Recipe = (sr) => bell(sr, 196, 5.0, 1818);

/** Field-telephone alarm: soft two-tone warble, three times. */
const alarm: Recipe = (sr) => {
  const b = alloc(sr, 1.6);
  for (let k = 0; k < 3; k++) {
    for (let h = 0; h < 2; h++) {
      const t0 = k * 0.5 + h * 0.22;
      const f = h === 0 ? 660 : 495;
      const s0 = Math.floor(t0 * sr);
      const len = Math.floor(0.2 * sr);
      for (let i = 0; i < len && s0 + i < b.length; i++) {
        const t = i / sr;
        const env = Math.min(1, t / 0.01) * Math.min(1, (0.2 - t) / 0.03);
        const ph = TAU * f * t;
        b[s0 + i] += (Math.sin(ph) + Math.sin(ph * 3) * 0.2 + Math.sin(ph * 2.01) * 0.15) * env * 0.5;
      }
    }
  }
  return finish(lowpass(b, sr, 2600), 0.6);
};

/** Teleprinter: a quick run of key strikes. */
const teleprinter: Recipe = (sr, v) => {
  const r = rng(1919 + v * 37);
  const b = alloc(sr, 0.7);
  const n = 8 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const t = 0.01 + i * 0.042 + r() * 0.01;
    noiseBurst(b, sr, r, t, 0.6, 0.002);
    partial(b, sr, t, 1300 + r() * 500, 0.25, 0.01);
    partial(b, sr, t, 380, 0.2, 0.012);
  }
  partial(b, sr, n * 0.042 + 0.03, 2093, 0.25, 0.08); // carriage bell
  return finish(b, 0.5);
};

/** Radio: squelch, a burst of syllable-like band-limited noise, squelch tail. */
const radio: Recipe = (sr, v) => {
  const r = rng(2020 + v * 41);
  const b = alloc(sr, 1.3);
  noiseBurst(b, sr, r, 0, 0.5, 0.05, 0.005);
  const s0 = Math.floor(0.08 * sr);
  const syl = 4.5 + r() * 2;
  for (let i = s0; i < Math.floor(1.0 * sr); i++) {
    const t = i / sr - 0.08;
    const am = Math.max(0, Math.sin(TAU * syl * t + Math.sin(TAU * 1.3 * t) * 2)) ** 1.5;
    b[i] += (r() * 2 - 1) * am * 0.6;
  }
  noiseBurst(b, sr, r, 1.0, 0.5, 0.06, 0.005);
  bandpass(b, sr, 1400, 1.6);
  return finish(b, 0.45);
};

const snareNoise: Recipe = (sr, v) => {
  const r = rng(2121 + v);
  const b = alloc(sr, 0.4);
  for (let i = 0; i < b.length; i++) b[i] = r() * 2 - 1;
  return b;
};

export const RECIPES = {
  rifle: { make: rifleVolley, variants: 4 },
  mg: { make: mgBurst, variants: 3 },
  cannon: { make: tankCannon, variants: 3 },
  at: { make: atGun, variants: 2 },
  mortar: { make: mortarLaunch, variants: 2 },
  howitzer: { make: howitzerLaunch, variants: 2 },
  whistle: { make: shellWhistle, variants: 2 },
  bombWhistle: { make: bombWhistle, variants: 1 },
  expSmall: { make: explosionSmall, variants: 3 },
  expBig: { make: explosionBig, variants: 2 },
  apHit: { make: apHit, variants: 2 },
  ricochet: { make: ricochet, variants: 3 },
  flak: { make: flak, variants: 2 },
  vehicleDeath: { make: vehicleDeath, variants: 2 },
  engine: { make: engineLoop, variants: 2 },
  rumble: { make: rumbleLoop, variants: 1 },
  click: { make: uiClick, variants: 2 },
  chime: { make: bellChime, variants: 1 },
  toll: { make: bellToll, variants: 1 },
  alarm: { make: alarm, variants: 1 },
  teleprinter: { make: teleprinter, variants: 2 },
  radio: { make: radio, variants: 2 },
  noise: { make: snareNoise, variants: 1 },
} as const;

export type SoundId = keyof typeof RECIPES;
export const SOUND_IDS = Object.keys(RECIPES) as SoundId[];

/** Stereo impulse response for the reverb (deterministic decaying noise). */
export function impulse(sr: number, seconds: number, seed: number, damp: number): [Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array] = [alloc(sr, seconds), alloc(sr, seconds)];
  out.forEach((ch, c) => {
    const r = rng(seed + c * 977);
    // Exponential decay reaching -60 dB at the end; short fade-in avoids a click.
    const k = Math.exp(-6.9 / ch.length);
    const fade = sr * 0.008;
    let e = 1;
    for (let i = 0; i < ch.length; i++) {
      ch[i] = (r() * 2 - 1) * e * (i < fade ? i / fade : 1);
      e *= k;
    }
    lowpass(ch, sr, damp);
  });
  return out;
}
