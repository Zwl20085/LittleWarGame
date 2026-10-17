/**
 * Four-part voice leading for the string choir (bass + tenor / alto / soprano) and the
 * scale helpers the composer uses for passing tones and ornaments.
 *
 * Rules (common-practice voice leading, Rimsky-Korsakov spacing):
 * - keep common tones, move every voice by the smallest interval;
 * - no parallel fifths / octaves between any pair of voices;
 * - the leading tone of a dominant rises to the new root, a chordal seventh falls by step;
 * - wide intervals at the bottom, close at the top (no muddy thirds below C3);
 * - adjacent upper voices within an octave, complete triads, no doubled bass third.
 */
import type { ChordInfo } from './themes';

/** String voicing ranges (tenor, alto, soprano); the melody sits above. */
const RANGES: readonly (readonly [number, number])[] = [[48, 62], [53, 67], [57, 71]];
const BASE_SCALE = [2, 4, 5, 7, 9, 10, 0];
const pcOf = (n: number): number => ((n % 12) + 12) % 12;

export function scaleFor(ch: ChordInfo | undefined): number[] {
  const s = BASE_SCALE.slice();
  if (!ch) return s;
  for (const pc of ch.tones) {
    if (s.includes(pc)) continue;
    const i = s.findIndex((x) => (x + 1) % 12 === pc || (x + 11) % 12 === pc);
    if (i >= 0) s[i] = pc;
  }
  return s;
}

export const inScale = (n: number, scale: readonly number[]): boolean => scale.includes(pcOf(n));

export function stepFrom(n: number, dir: 1 | -1, scale: readonly number[]): number {
  let m = n + dir;
  while (!inScale(m, scale)) m += dir;
  return m;
}

/** Fit a pitch class into [lo, hi], nearest to `near`. */
export function place(pc: number, lo: number, hi: number, near: number): number {
  let best = -1;
  for (let n = lo; n <= hi; n++) if (pcOf(n) === pc && (best < 0 || Math.abs(n - near) < Math.abs(best - near))) best = n;
  return best < 0 ? lo + pcOf(pc - lo) : best;
}

/** Count parallel fifths / octaves between any pair of voices. */
export function parallels(p: readonly number[], n: readonly number[]): number {
  let k = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    const pi = pcOf(p[j] - p[i]);
    const ni = pcOf(n[j] - n[i]);
    if ((pi === 7 || pi === 0) && pi === ni && n[i] !== p[i] && Math.sign(n[i] - p[i]) === Math.sign(n[j] - p[j])) k++;
  }
  return k;
}

export class Voicer {
  private prev: number[] = [38, 53, 57, 62];
  private prevChord: ChordInfo | null = null;

  /** Last voicing [bass, tenor, alto, soprano]. */
  get last(): readonly number[] {
    return this.prev;
  }

  /** Voice-lead the upper three string voices and the bass onto a chord. */
  voice(ch: ChordInfo, r: () => number): number[] {
    const [pb, pt, pa, ps] = this.prev;
    const bass = place(ch.bass, 36, 50, pb);
    const cands = RANGES.map(([lo, hi]) => {
      const xs: number[] = [];
      for (let n = lo; n <= hi; n++) if (ch.tones.includes(n % 12)) xs.push(n);
      return xs;
    });
    let best: number[] = [];
    let bestCost = Infinity;
    for (const t of cands[0]) for (const a of cands[1]) {
      if (a <= t) continue;
      for (const s of cands[2]) {
        if (s <= a) continue;
        const cost = this.cost(ch, bass, t, a, s, [pb, pt, pa, ps]) + r() * 0.6; // tie-break variety
        if (cost < bestCost) {
          bestCost = cost;
          best = [bass, t, a, s];
        }
      }
    }
    if (!best.length) best = [bass, place(ch.root, 48, 60, pt), place(ch.third, 53, 65, pa), place(ch.tones[2], 57, 70, ps)];
    this.prev = best;
    this.prevChord = ch;
    return best;
  }

  private cost(ch: ChordInfo, bass: number, t: number, a: number, s: number, prev: readonly number[]): number {
    const pcs = new Set([t % 12, a % 12, s % 12]);
    if (!pcs.has(ch.third)) return Infinity;
    if (ch.seventh >= 0 && !pcs.has(ch.seventh)) return Infinity;
    const [pb, pt, pa, ps] = prev;
    let cost = Math.abs(t - pt) + Math.abs(a - pa) + Math.abs(s - ps);
    if (pcs.size < Math.min(3, ch.tones.length)) cost += 4;
    if (s - a > 9) cost += 4;
    if (a - t > 10) cost += 3;
    if (bass % 12 === ch.third) cost += [t, a, s].filter((n) => n % 12 === ch.third).length * 5;
    // Spacing: wide at the bottom (no tenor crowding a low bass), no low close thirds.
    if (bass < 48 && t - bass < 7) cost += 2;
    if (t < 52 && a - t <= 4) cost += 1.5;
    cost += parallels([pb, pt, pa, ps], [bass, t, a, s]) * 12;
    cost += this.resolution(ch, [pt, pa, ps], [t, a, s]);
    return cost;
  }

  /** Tendency tones: leading tone of a dominant rises, a chordal seventh falls by step. */
  private resolution(ch: ChordInfo, from: readonly number[], to: readonly number[]): number {
    const pc = this.prevChord;
    if (!pc) return 0;
    let cost = 0;
    const dominant = pcOf(pc.root - ch.root) === 7;
    const lead = pcOf(ch.root - 1);
    for (let i = 0; i < 3; i++) {
      const p = from[i];
      const d = to[i] - p;
      if (dominant && pcOf(p) === lead && pc.tones.includes(lead) && d !== 1) cost += i === 2 ? 4 : 2;
      if (pc.seventh >= 0 && pcOf(p) === pc.seventh && d !== -1 && d !== -2 && d !== 0) cost += 2;
    }
    return cost;
  }
}
