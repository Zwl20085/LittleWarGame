import { brass, horn, lowString, mtof, pad, snare, timpani } from './instruments';
import type { Mixer } from './mixer';

/**
 * Adaptive procedural score in D minor. A look-ahead sequencer schedules notes on the audio
 * clock (no loops → no seams). Six layers crossfade by battle intensity:
 * drone · string pad · low-string ostinato · brass swells · percussion · horn melody.
 */
export type MusicMode = 'title' | 'battle' | 'aftermath';

type Chord = readonly [root: number, minor: boolean];
const PROGS: Record<string, readonly Chord[]> = {
  battleA: [[38, true], [34, false], [43, true], [45, false]],
  battleB: [[38, true], [43, true], [39, false], [45, false]],
  title: [[38, true], [41, false], [36, false], [43, true], [34, false], [41, false], [43, true], [45, false]],
  aftermath: [[38, true], [34, false], [43, true], [45, false]],
};
const BPM: Record<MusicMode, number> = { title: 60, battle: 74, aftermath: 54 };

/** Title theme: [beat from phrase start, length in beats, midi]. 16 bars, one per chord pair. */
const THEME: readonly (readonly [number, number, number])[] = [
  [0, 1, 62], [1, 1, 65], [2, 2, 69], [4, 1, 67], [5, 1, 65], [6, 2, 64],
  [8, 2, 65], [10, 1, 69], [11, 1, 72], [12, 3, 72], [15, 1, 69],
  [16, 2, 67], [18, 1, 64], [19, 1, 67], [20, 4, 72],
  [24, 2, 70], [26, 1, 69], [27, 1, 67], [28, 3, 74],
  [32, 1, 74], [33, 1, 72], [34, 2, 70], [36, 4, 65],
  [40, 1, 69], [41, 1, 72], [42, 2, 77], [44, 2, 76], [46, 2, 72],
  [48, 2, 74], [50, 1, 70], [51, 1, 67], [52, 2, 70], [54, 2, 69],
  [56, 2, 69], [58, 1, 73], [59, 1, 76], [60, 3, 69],
];
/** Bugle-like call at the head of intense battle phrases: [step, steps, midi]. */
const CALL: readonly (readonly [number, number, number])[] = [[0, 2, 57], [2, 4, 62], [6, 2, 65], [8, 8, 69]];
const SNARE: readonly number[] = [0.9, 0, 0, 0, 0.35, 0, 0.5, 0, 0.85, 0, 0.3, 0.4, 0.8, 0, 0.35, 0.45];

const LAYERS = ['drone', 'pad', 'strings', 'brass', 'perc', 'melody'] as const;
type Layer = (typeof LAYERS)[number];
/** Layer mix per mode and intensity level 0–3. */
const MIX: Record<MusicMode, readonly (readonly number[])[]> = {
  //          drone pad strings brass perc melody
  battle: [[0.8, 0.8, 0, 0, 0, 0.7], [0.7, 0.8, 0.7, 0, 0.6, 0.45], [0.6, 0.7, 0.85, 0.6, 0.85, 0.3], [0.5, 0.6, 1, 0.85, 1, 0.3]],
  title: [[0.7, 0.9, 0, 0, 0.35, 1], [0.65, 0.9, 0.45, 0, 0.5, 1], [0.6, 0.85, 0.6, 0.4, 0.6, 0.9], [0.6, 0.85, 0.6, 0.4, 0.6, 0.9]],
  aftermath: [[0.6, 0.8, 0, 0, 0.2, 0.7], [0.6, 0.8, 0, 0, 0.2, 0.7], [0.6, 0.8, 0, 0, 0.2, 0.7], [0.6, 0.8, 0, 0, 0.2, 0.7]],
};
const UP = [0.22, 0.46, 0.72];
const DOWN = [0.1, 0.32, 0.58];
/** Reverb send per layer. */
const SEND: Record<Layer, number> = { drone: 0.3, pad: 0.7, strings: 0.35, brass: 0.6, perc: 0.3, melody: 0.8 };

export class Music {
  private readonly c: AudioContext;
  private readonly bus: Record<Layer, GainNode>;
  private readonly lastTarget = new Float64Array(LAYERS.length).fill(-1);
  private mode: MusicMode = 'title';
  private wanted: MusicMode = 'title';
  private prog: readonly Chord[] = PROGS.title;
  private step = 0;
  private phrase = 0;
  private next = 0;
  level = 0;
  private levelSince = 0;
  private bright = 0;
  private readonly droneOsc: OscillatorNode[] = [];

  constructor(private readonly mix: Mixer) {
    const c = (this.c = mix.ctx);
    const mk = (l: Layer): GainNode => {
      const g = c.createGain();
      g.gain.value = 0;
      g.connect(mix.musicIn);
      const s = c.createGain();
      s.gain.value = SEND[l];
      g.connect(s).connect(mix.musicVerb);
      return g;
    };
    this.bus = { drone: mk('drone'), pad: mk('pad'), strings: mk('strings'), brass: mk('brass'), perc: mk('perc'), melody: mk('melody') };
    this.buildDrone();
    this.next = c.currentTime + 0.1;
  }

  /** Persistent pedal on D with a slow breathing swell. */
  private buildDrone(): void {
    const c = this.c;
    const breath = c.createGain();
    breath.gain.value = 0.8;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoAmt = c.createGain();
    lfoAmt.gain.value = 0.2;
    lfo.connect(lfoAmt).connect(breath.gain);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.connect(breath).connect(this.bus.drone);
    const voices: [OscillatorType, number, number][] = [['sine', 38, 0.16], ['sawtooth', 38, 0.05], ['sine', 45, 0.06], ['sawtooth', 26, 0.04]];
    for (const [type, note, lvl] of voices) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = mtof(note);
      o.detune.value = (Math.random() - 0.5) * 6;
      const g = c.createGain();
      g.gain.value = lvl;
      o.connect(g).connect(lp);
      o.start();
      this.droneOsc.push(o);
    }
    lfo.start();
    this.droneOsc.push(lfo);
  }

  get modeNow(): MusicMode {
    return this.mode;
  }

  setMode(m: MusicMode): void {
    this.wanted = m;
  }

  /** Called every frame with the smoothed battle intensity (0–1). */
  update(intensity: number): void {
    const now = this.c.currentTime;
    this.updateLevel(intensity, now);
    this.bright += (intensity - this.bright) * 0.02;
    const mix = MIX[this.mode][this.level];
    for (let i = 0; i < LAYERS.length; i++) {
      const target = mix[i] * 0.95;
      if (Math.abs(target - this.lastTarget[i]) < 1e-3) continue;
      this.lastTarget[i] = target;
      this.bus[LAYERS[i]].gain.setTargetAtTime(target, now, i === 0 ? 3 : 2.2);
    }
    // Resync after the tab was hidden (rAF stopped): never schedule in the past.
    if (this.next < now - 0.05) this.next = now + 0.05;
    const dur = 60 / BPM[this.mode] / 4;
    while (this.next < now + 0.3) {
      this.tick(this.next, dur);
      this.next += dur;
      this.step++;
      if (this.step >= this.prog.length * 32) {
        this.step = 0;
        this.phrase++;
        if (this.mode === 'battle') this.prog = this.phrase % 2 ? PROGS.battleB : PROGS.battleA;
      }
    }
  }

  private updateLevel(intensity: number, now: number): void {
    const x = this.mode === 'title' ? intensity * 0.85 : this.mode === 'aftermath' ? 0 : intensity;
    if (now - this.levelSince < 5) return;
    const cap = this.mode === 'title' ? 2 : 3;
    if (this.level < cap && x > UP[this.level]) {
      this.level++;
      this.levelSince = now;
    } else if (this.level > 0 && x < DOWN[this.level - 1]) {
      this.level--;
      this.levelSince = now;
    }
    if (this.level > cap) this.level = cap;
  }

  /** Schedule everything that starts on this 16th-note step. */
  private tick(t: number, dur: number): void {
    const s16 = this.step % 16;
    // Mode changes land on a bar line and restart the phrase.
    if (s16 === 0 && this.wanted !== this.mode) {
      this.mode = this.wanted;
      this.prog = PROGS[this.mode === 'battle' ? 'battleA' : this.mode];
      this.step = 0;
      this.phrase = 0;
      this.level = Math.min(this.level, this.mode === 'title' ? 2 : 3);
      this.lastTarget.fill(-1);
    }
    const step = this.step;
    const [root, minor] = this.prog[Math.floor(step / 32) % this.prog.length];
    const inChord = step % 32;
    const lv = this.level;
    const c = this.c;
    const b = this.bus;
    if (inChord === 0) {
      for (const pc of [root, root + (minor ? 3 : 4), root + 7]) {
        let n = pc;
        while (n < 50) n += 12;
        while (n > 61) n -= 12;
        pad(c, b.pad, t, n, 32 * dur, 0.07, this.bright);
      }
      pad(c, b.pad, t, root, 32 * dur, 0.05, 0);
      if (lv >= 2) {
        const top = root + 19 > 64 ? root + 7 : root + 19;
        brass(c, b.brass, t + dur * 2, root + 12, 20 * dur, 0.07);
        brass(c, b.brass, t + dur * 2, top, 20 * dur, 0.05);
      }
    }
    if (lv >= 1 && this.mode !== 'aftermath' && s16 % 2 === 0) {
      const off = [0, 0, 12, 0, 7, 0, 12, 7][s16 / 2];
      lowString(c, b.strings, t, root + off, s16 % 8 === 0 ? 0.16 : 0.1);
    } else if (lv >= 3 && s16 % 2 === 1) lowString(c, b.strings, t, root + 12, 0.06);
    this.percussion(t, s16, inChord, root, lv);
    this.melody(t, dur, step, inChord, root, minor, lv);
  }

  private percussion(t: number, s16: number, inChord: number, root: number, lv: number): void {
    const c = this.c;
    const out = this.bus.perc;
    const tim = root < 38 ? root + 12 : root;
    if (s16 === 0 && (lv >= 1 || inChord === 0)) timpani(c, out, t, tim, this.mode === 'battle' ? 0.5 : 0.35);
    if (lv >= 2 && s16 === 8 && inChord >= 16) timpani(c, out, t, tim + 7 > 50 ? tim - 5 : tim + 7, 0.35);
    if (lv >= 3 && inChord >= 28) timpani(c, out, t, tim, 0.12 + (inChord - 28) * 0.08);
    if (lv >= 2 && this.mode === 'battle') {
      const v = SNARE[s16];
      if (v > 0) snare(c, out, this.mix.buffer('noise', 0), t, v * 0.16);
      else if (lv >= 3 && Math.random() < 0.25) snare(c, out, this.mix.buffer('noise', 0), t, 0.03);
    } else if (lv >= 2 && (s16 === 0 || s16 === 8)) snare(c, out, this.mix.buffer('noise', 0), t, 0.06);
  }

  private melody(t: number, dur: number, step: number, inChord: number, root: number, minor: boolean, lv: number): void {
    const c = this.c;
    const out = this.bus.melody;
    if (this.mode === 'title') {
      // Every third pass the horn rests and the strings carry the theme's harmony alone.
      if (step % 4 !== 0 || this.phrase % 3 === 2) return;
      const beat = step / 4;
      for (const [b0, len, note] of THEME) if (b0 === beat) horn(c, out, t, note, len * 4 * dur, 0.11);
      return;
    }
    if (lv >= 2 && this.phrase % 2 === 0) {
      for (const [s0, len, note] of CALL) if (s0 === step) horn(c, out, t, note, len * dur, 0.1);
      return;
    }
    // A slow lament: one long chord tone per chord on alternate phrases.
    if (lv <= 1 && this.phrase % 2 === 1 && inChord === 4) {
      let n = root + (minor ? 3 : 4);
      while (n < 60) n += 12;
      horn(c, out, t, n, 22 * dur, this.mode === 'aftermath' ? 0.09 : 0.07);
    }
  }

  dispose(): void {
    const t = this.c.currentTime;
    for (const l of LAYERS) this.bus[l].gain.setTargetAtTime(0, t, 0.3);
    for (const o of this.droneOsc) o.stop(t + 1.5);
  }
}
