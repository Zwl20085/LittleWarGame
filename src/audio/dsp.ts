/**
 * Tiny deterministic DSP toolkit used to synthesise every sound effect into plain
 * Float32Arrays (no assets, no downloads). Everything here runs once, off the hot path.
 */

/** Deterministic PRNG (mulberry32) so every build of the sound bank is identical. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TAU = Math.PI * 2;

export function alloc(sr: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.ceil(sr * seconds)));
}

/** One-pole lowpass in place (cutoff Hz). */
export function lowpass(buf: Float32Array, sr: number, cutoff: number): Float32Array {
  const k = 1 - Math.exp((-TAU * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += k * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

/** One-pole highpass in place. */
export function highpass(buf: Float32Array, sr: number, cutoff: number): Float32Array {
  const k = 1 - Math.exp((-TAU * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += k * (buf[i] - y);
    buf[i] -= y;
  }
  return buf;
}

/** Resonant state-variable bandpass in place. */
export function bandpass(buf: Float32Array, sr: number, centre: number, q: number): Float32Array {
  const f = 2 * Math.sin((Math.PI * Math.min(centre, sr * 0.2)) / sr);
  const damp = 1 / Math.max(0.3, q);
  let low = 0;
  let band = 0;
  for (let i = 0; i < buf.length; i++) {
    const high = buf[i] - low - damp * band;
    band += f * high;
    low += f * band;
    buf[i] = band;
  }
  return buf;
}

/** Add white noise with an exponential envelope starting at `start` seconds. */
export function noiseBurst(buf: Float32Array, sr: number, r: () => number, start: number, amp: number, decay: number, attack = 0.001): void {
  const s0 = Math.floor(start * sr);
  const len = Math.min(buf.length - s0, Math.ceil(decay * 7 * sr));
  const atk = Math.max(1, attack * sr);
  const k = Math.exp(-1 / (decay * sr));
  let e = amp;
  for (let i = 0; i < len; i++) {
    buf[s0 + i] += (r() * 2 - 1) * e * (i < atk ? i / atk : 1);
    e *= k;
  }
}

/** Add a sine whose frequency glides exponentially from f0 to f1 over `glide` seconds. */
export function sweep(buf: Float32Array, sr: number, start: number, f0: number, f1: number, glide: number, amp: number, decay: number, attack = 0.002): void {
  const s0 = Math.floor(start * sr);
  const len = Math.min(buf.length - s0, Math.ceil(decay * 7 * sr));
  const gl = Math.max(1, glide * sr);
  const m = Math.pow(f1 / f0, 1 / gl);
  const atk = Math.max(1, attack * sr);
  const k = Math.exp(-1 / (decay * sr));
  let f = f0;
  let e = amp;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    if (i < gl) f *= m;
    ph += (TAU * f) / sr;
    buf[s0 + i] += Math.sin(ph) * e * (i < atk ? i / atk : 1);
    e *= k;
  }
}

/** Add a decaying partial (bells / metal) using a rotating phasor (no per-sample trig). */
export function partial(buf: Float32Array, sr: number, start: number, freq: number, amp: number, decay: number): void {
  const s0 = Math.floor(start * sr);
  const len = Math.min(buf.length - s0, Math.ceil(decay * 7 * sr));
  const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const atk = sr * 0.0015;
  const k = Math.exp(-1 / (decay * sr));
  let re = 1;
  let im = 0;
  let e = amp;
  for (let i = 0; i < len; i++) {
    buf[s0 + i] += im * e * (i < atk ? i / atk : 1);
    const nr = re * cw - im * sw;
    im = re * sw + im * cw;
    re = nr;
    e *= k;
  }
}

/** Brownian (red) noise bed with exponential envelope. */
export function rumble(buf: Float32Array, sr: number, r: () => number, start: number, amp: number, decay: number, attack = 0.01): void {
  const s0 = Math.floor(start * sr);
  const len = Math.min(buf.length - s0, Math.ceil(decay * 7 * sr));
  const atk = Math.max(1, attack * sr);
  const k = decay > 1e6 ? 1 : Math.exp(-1 / (decay * sr));
  let e = amp;
  let b = 0;
  for (let i = 0; i < len; i++) {
    b = b * 0.995 + (r() * 2 - 1) * 0.06;
    buf[s0 + i] += b * e * (i < atk ? i / atk : 1);
    e *= k;
  }
}

/** Soft-clip and normalise to `peak`. */
export function finish(buf: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.tanh(buf[i] * 1.2);
    m = Math.max(m, Math.abs(buf[i]));
  }
  if (m > 0) {
    const g = peak / m;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  // Short fade-out so no buffer ends on a click.
  const fade = Math.min(buf.length, 256);
  for (let i = 0; i < fade; i++) buf[buf.length - 1 - i] *= i / fade;
  return buf;
}

/** Make the end of a loop crossfade into its start so it repeats without a seam. */
export function loopSeal(buf: Float32Array, sr: number, fadeSec: number): Float32Array {
  const n = Math.min(Math.floor(fadeSec * sr), Math.floor(buf.length / 3));
  const out = new Float32Array(buf.length - n);
  out.set(buf.subarray(0, out.length));
  for (let i = 0; i < n; i++) {
    const a = i / n;
    // Head = blend of the tail (fading out) and the head (fading in).
    out[i] = buf[out.length + i] * (1 - a) + buf[i] * a;
  }
  return out;
}
