// Deterministic synthesized SFX kit (no downloads): drone bed, artillery boom, whoosh.
import { writeFileSync } from 'node:fs';
const SR = 44100;
function wav(path, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let peak = 0; for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const k = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * k)) * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;

// Drone: detuned low sines + slow swell + filtered rumble, 40 s.
{
  const n = SR * 40; const out = new Float32Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const swell = 0.55 + 0.45 * Math.sin(t * 0.35);
    const tone = Math.sin(2 * Math.PI * 55 * t) * 0.5 + Math.sin(2 * Math.PI * 55.6 * t) * 0.4 + Math.sin(2 * Math.PI * 82.4 * t) * 0.18 + Math.sin(2 * Math.PI * 110.3 * t) * 0.08;
    lp += (rnd() - lp) * 0.012; // low rumble
    const fadeIn = Math.min(1, t / 2.5); const fadeOut = Math.min(1, (40 - t) / 3);
    out[i] = (tone * swell + lp * 1.6) * fadeIn * fadeOut;
  }
  wav('public/sfx/drone.wav', out);
}
// Boom: pitch-dropping sine thump + noise burst with long decay.
{
  const n = Math.round(SR * 2.4); const out = new Float32Array(n); let lp = 0; let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 35 + 85 * Math.exp(-t * 9);
    ph += (2 * Math.PI * f) / SR;
    lp += (rnd() - lp) * (0.25 * Math.exp(-t * 3) + 0.02);
    out[i] = Math.sin(ph) * Math.exp(-t * 2.2) + lp * 1.4 * Math.exp(-t * 2.8);
  }
  wav('public/sfx/boom.wav', out);
}
// Whoosh: noise through a sweeping one-pole lowpass with a swell envelope.
{
  const n = Math.round(SR * 0.7); const out = new Float32Array(n); let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const env = Math.sin(Math.PI * Math.pow(x, 0.7)) ** 2;
    const cut = 0.02 + 0.25 * env;
    lp += (rnd() - lp) * cut;
    out[i] = lp * env;
  }
  wav('public/sfx/whoosh.wav', out);
}
console.log('sfx written');
