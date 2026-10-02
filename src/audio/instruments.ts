/**
 * Live-synthesised orchestral-ish instruments for the procedural score. Each call schedules
 * one note at audio time `t` into `out`. Notes are a handful per second, never per frame.
 */

export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

function env(g: GainNode, t: number, peak: number, attack: number, hold: number, release: number): number {
  const p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setValueAtTime(peak, t + attack + hold);
  p.linearRampToValueAtTime(0, t + attack + hold + release);
  return t + attack + hold + release + 0.05;
}

/** Warm string pad: two detuned saws through a soft lowpass, slow bow. */
export function pad(c: AudioContext, out: AudioNode, t: number, note: number, dur: number, vel: number, bright: number): void {
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(500 + 900 * bright, t);
  f.Q.value = 0.4;
  const g = c.createGain();
  f.connect(g).connect(out);
  const end = env(g, t, vel, Math.min(1.6, dur * 0.35), Math.max(0, dur - Math.min(1.6, dur * 0.35)), 1.8);
  for (const det of [-7, 7]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(note);
    o.detune.value = det;
    o.connect(f);
    o.start(t);
    o.stop(end);
  }
}

/** Low string spiccato (cello/bass ostinato). */
export function lowString(c: AudioContext, out: AudioNode, t: number, note: number, vel: number): void {
  const o = c.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = mtof(note);
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(320, t + 0.18);
  const g = c.createGain();
  o.connect(f).connect(g).connect(out);
  const end = env(g, t, vel, 0.012, 0.06, 0.22);
  o.start(t);
  o.stop(end);
}

/** Brass swell: detuned saws with an opening filter (horn section chord tone). */
export function brass(c: AudioContext, out: AudioNode, t: number, note: number, dur: number, vel: number): void {
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(220, t);
  f.frequency.linearRampToValueAtTime(1500, t + dur * 0.4);
  f.frequency.linearRampToValueAtTime(600, t + dur);
  const g = c.createGain();
  f.connect(g).connect(out);
  const end = env(g, t, vel, dur * 0.4, dur * 0.3, dur * 0.3 + 0.6);
  for (const det of [-5, 4]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(note);
    o.detune.value = det;
    o.connect(f);
    o.start(t);
    o.stop(end);
  }
}

/** French-horn-like lead: triangle + soft sine, gentle vibrato, slow tongue. */
export function horn(c: AudioContext, out: AudioNode, t: number, note: number, dur: number, vel: number): void {
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1300;
  const g = c.createGain();
  f.connect(g).connect(out);
  const end = env(g, t, vel, 0.12, Math.max(0.05, dur - 0.2), 0.5);
  const lfo = c.createOscillator();
  lfo.frequency.value = 4.8;
  const depth = c.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(6, t + Math.min(0.6, dur));
  lfo.connect(depth);
  for (const [type, mul, lvl] of [['triangle', 1, 1], ['sine', 0.5, 0.5]] as const) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = mtof(note) * mul;
    depth.connect(o.detune);
    const og = c.createGain();
    og.gain.value = lvl;
    o.connect(og).connect(f);
    o.start(t);
    o.stop(end);
  }
  lfo.start(t);
  lfo.stop(end);
}

/** Timpani: tuned sine with a small pitch drop plus a felt-mallet thump. */
export function timpani(c: AudioContext, out: AudioNode, t: number, note: number, vel: number): void {
  const o = c.createOscillator();
  o.type = 'sine';
  const fr = mtof(note);
  o.frequency.setValueAtTime(fr * 1.04, t);
  o.frequency.exponentialRampToValueAtTime(fr, t + 0.12);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 1.4);
  const o2 = c.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = fr * 1.5;
  const g2 = c.createGain();
  g2.gain.setValueAtTime(vel * 0.35, t);
  g2.gain.exponentialRampToValueAtTime(0.0005, t + 0.5);
  o.connect(g).connect(out);
  o2.connect(g2).connect(out);
  o.start(t);
  o2.start(t);
  o.stop(t + 1.5);
  o2.stop(t + 0.6);
}

/** Field snare: band-passed noise (shared buffer) plus a short shell tone. */
export function snare(c: AudioContext, out: AudioNode, noise: AudioBuffer | null, t: number, vel: number): void {
  if (noise) {
    const s = c.createBufferSource();
    s.buffer = noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
    s.connect(bp).connect(g).connect(out);
    s.start(t, Math.random() * 0.2);
    s.stop(t + 0.18);
  }
  const o = c.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(210, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
  const g = c.createGain();
  g.gain.setValueAtTime(vel * 0.6, t);
  g.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.08);
}
