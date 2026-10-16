/**
 * Scoring-stage impulse response for the music reverb: a short pre-delay, discrete early
 * reflections (different per ear for width), then a diffuse tail that darkens as it
 * decays (air absorption). Deterministic; built once in the bank worker.
 * The total energy matches the plain decaying-noise IR of 2.x so wet levels carry over.
 */
import { rng } from './dsp';
import { impulse } from './recipes';

/** Early reflections: [seconds, gain] for the left ear; the right ear is offset and stretched. */
export const EARLY: readonly (readonly [number, number])[] = [
  [0.013, 0.55], [0.019, 0.42], [0.027, 0.38], [0.034, 0.3], [0.043, 0.27], [0.052, 0.22], [0.061, 0.2], [0.071, 0.16],
];
export const PRE_DELAY = 0.012;
const TAIL_START = 0.03;
const TAIL_FADE = 0.06;

export function hallImpulse(sr: number, seconds = 2.9, seed = 77): [Float32Array, Float32Array] {
  const n = Math.max(1, Math.ceil(sr * seconds));
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  out.forEach((ch, c) => {
    const r = rng(seed + c * 977);
    for (const [t, g] of EARLY) {
      const at = Math.floor((PRE_DELAY + t * (c ? 1.07 : 1) + (c ? 0.0021 : 0)) * sr);
      if (at < n) ch[at] += g * (r() < 0.5 ? -1 : 1);
    }
    // Diffuse tail: -60 dB at the end, with a lowpass that closes from ~7 kHz to ~1.4 kHz.
    const k = Math.exp(-6.9 / (n - TAIL_START * sr));
    const t0 = Math.floor(TAIL_START * sr);
    const fade = TAIL_FADE * sr;
    let e = 0.5;
    let y = 0;
    for (let i = t0; i < n; i++) {
      const u = (i - t0) / (n - t0);
      const fc = 7000 * Math.pow(0.2, u);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      y += a * ((r() * 2 - 1) - y);
      ch[i] += y * e * Math.min(1, (i - t0) / fade);
      e *= k;
    }
  });
  matchEnergy(out, sr);
  return out;
}

/** Scale to the energy of the 2.x music IR (impulse(sr, 3.2, 77, 2400)). */
function matchEnergy(ir: [Float32Array, Float32Array], sr: number): void {
  const ref = impulse(sr, 3.2, 77, 2400);
  const energy = (chs: readonly Float32Array[]): number => {
    let s = 0;
    for (const ch of chs) for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
    return s;
  };
  const g = Math.sqrt(energy(ref) / Math.max(1e-12, energy(ir)));
  for (const ch of ir) for (let i = 0; i < ch.length; i++) ch[i] *= g;
}
