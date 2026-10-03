import type { Mixer } from './mixer';
import type { MusicBankMessage } from './music.worker';
import { renderSample, sampleId, sampleKeys, sampleRoot, type MusicSample, type SampleKey } from './orchestra';
import { brightness, Conductor, LAYER_BUS, LAYERS, layerTargets, type Layer, type MusicMode, type NoteEv, type Outcome, type Stinger } from './score';

export type { MusicMode, Outcome, Stinger } from './score';

/**
 * Adaptive orchestral score (WWII war-film style) in D minor. The Conductor (score.ts)
 * composes one bar at a time from the game state; this class plays it on the audio clock
 * with a sampled orchestra built in a worker (orchestra.ts). Nine section buses
 * (strings, bass, winds, horns, brass, ostinato, tremolo, percussion, lead) crossfade
 * smoothly with battle intensity into the music bus; the mixer's master glue compressor
 * and limiter provide the dynamics control (a second compressor here flattened the
 * calm-versus-battle contrast through its automatic make-up gain).
 */

/** Game-side musical context beyond intensity (see AudioSession). */
export interface MusicMood {
  readonly retreat: boolean;
  readonly outcome: Outcome;
  /** One-shot cue to play at the next bar (consumed). */
  readonly stinger: Stinger | null;
}

/** Bars are scheduled this far ahead of the audio clock (seconds). */
const LOOKAHEAD = 0.35;
/** Overall score trim so the orchestra sits under the battle effects. */
const SCORE_TRIM = 0.8;
/** Voice budget: above this many sounding notes, quiet notes are skipped. */
const MAX_NOTES = 48;
const QUIET_VEL = 0.12;

interface Played {
  readonly buf: AudioBuffer;
  readonly root: number;
  readonly loopStart: number;
  readonly loopEnd: number;
}

interface Bus {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode | null;
  last: number;
}

export class Music {
  private readonly c: AudioContext;
  private readonly bus: Record<Layer, Bus>;
  private readonly out: GainNode;
  /** End times of sounding notes (ring buffer for the voice budget). */
  private readonly ends = new Float64Array(96);
  private endIdx = 0;
  skipped = 0;
  private warned = false;
  private readonly samples = new Map<string, Played>();
  private readonly conductor = new Conductor((Math.random() * 2 ** 32) >>> 0);
  private readonly pending: SampleKey[] = [];
  private worker: Worker | null = null;
  private mode: MusicMode = 'title';
  private retreat = false;
  private outcome: Outcome = null;
  private nextBar = 0;
  private x = 0;
  private lastBright = -1;
  /** Notes started per second, averaged over ~8 s (debug / CPU budget). */
  notesPerSec = 0;
  private noteAcc = 0;
  private noteWindow = 0;

  constructor(mix: Mixer) {
    const c = (this.c = mix.ctx);
    this.out = c.createGain();
    this.out.gain.value = SCORE_TRIM;
    this.out.connect(mix.musicIn);
    const mk = (l: Layer): Bus => {
      const cfg = LAYER_BUS[l];
      const gain = c.createGain();
      gain.gain.value = 0;
      let head: AudioNode = gain;
      let filter: BiquadFilterNode | null = null;
      if (cfg.bright) {
        filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 0.5;
        filter.frequency.value = brightness(0);
        head = gain.connect(filter);
      }
      const pan = c.createStereoPanner();
      pan.pan.value = cfg.pan;
      head.connect(pan).connect(this.out);
      const send = c.createGain();
      send.gain.value = cfg.send * SCORE_TRIM;
      head.connect(send).connect(mix.musicVerb);
      return { gain, filter, last: -1 };
    };
    this.bus = Object.fromEntries(LAYERS.map((l) => [l, mk(l)])) as Record<Layer, Bus>;
    this.nextBar = c.currentTime + 0.15;
    this.pending.push(...sampleKeys());
    this.startWorker();
  }

  private startWorker(): void {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('./music.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<MusicBankMessage>) => {
        if (e.data.t === 'done') this.stopWorker();
        else this.store(e.data.s);
      };
      w.onerror = (e) => {
        console.warn('[audio] music worker failed, rendering on main thread:', e.message);
        this.stopWorker();
      };
      w.postMessage(null);
    } catch (err: unknown) {
      console.warn('[audio] music worker unavailable:', err instanceof Error ? err.message : err);
      this.worker = null;
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private store(s: MusicSample): void {
    const id = sampleId(s.inst, s.root, s.v);
    if (this.samples.has(id)) return;
    const buf = this.c.createBuffer(1, s.data.length, s.rate);
    buf.copyToChannel(s.data, 0);
    this.samples.set(id, { buf, root: s.root, loopStart: s.loopStart, loopEnd: s.loopEnd });
    const i = this.pending.findIndex((k) => k.inst === s.inst && k.root === s.root && k.v === s.v);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /** Main-thread fallback when workers are unavailable: render a time-boxed slice. */
  private pump(budgetMs: number): void {
    if (this.worker || !this.pending.length) return;
    const t0 = performance.now();
    while (this.pending.length && performance.now() - t0 < budgetMs) this.store(renderSample(this.pending[0]));
  }

  get modeNow(): MusicMode {
    return this.mode;
  }

  /** Current orchestration tier 0–3. */
  get level(): number {
    return this.conductor.level;
  }

  get samplesReady(): number {
    return this.samples.size;
  }

  setMode(m: MusicMode): void {
    this.mode = m;
  }

  setMood(m: MusicMood): void {
    this.retreat = m.retreat;
    this.outcome = m.outcome;
    if (m.stinger) this.conductor.stinger(m.stinger);
  }

  /** Called every frame with the smoothed battle intensity (0–1). */
  update(intensity: number): void {
    const now = this.c.currentTime;
    this.pump(3);
    this.x += (intensity - this.x) * 0.02;
    this.applyBuses(now);
    // Resync after the tab was hidden (rAF stopped): never schedule in the past.
    if (this.nextBar < now - 0.05) this.nextBar = now + 0.05;
    while (this.nextBar < now + LOOKAHEAD) {
      const plan = this.conductor.nextBar({ mode: this.mode, intensity, retreat: this.retreat, outcome: this.outcome });
      const spb = 60 / plan.bpm;
      for (const e of plan.events) {
        try {
          this.play(e, this.nextBar + e.beat * spb, spb);
        } catch (err: unknown) {
          // Never let a scheduling error escape into the game loop; report it once.
          if (!this.warned) console.warn('[audio] music note failed:', err instanceof Error ? err.message : err);
          this.warned = true;
        }
      }
      this.nextBar += plan.beats * spb;
    }
    if (now - this.noteWindow >= 8) {
      this.notesPerSec = this.noteAcc / Math.max(1, now - this.noteWindow);
      this.noteAcc = 0;
      this.noteWindow = now;
    }
  }

  private applyBuses(now: number): void {
    const targets = layerTargets(this.x, this.mode, this.retreat);
    for (const l of LAYERS) {
      const b = this.bus[l];
      const g = targets[l];
      if (Math.abs(g - b.last) < 0.01) continue;
      b.last = g;
      b.gain.gain.setTargetAtTime(g, now, 1.6);
    }
    const bright = brightness(this.x);
    if (Math.abs(bright - this.lastBright) > 60) {
      this.lastBright = bright;
      for (const l of LAYERS) this.bus[l].filter?.frequency.setTargetAtTime(bright, now, 1.5);
    }
  }

  private play(e: NoteEv, t: number, spb: number): void {
    const s = this.samples.get(sampleId(e.inst, sampleRoot(e.inst, e.midi), e.v));
    if (!s || e.vel < 0.004) return;
    if (e.vel < QUIET_VEL && this.sounding(t) >= MAX_NOTES) {
      this.skipped++;
      return;
    }
    const c = this.c;
    const src = c.createBufferSource();
    src.buffer = s.buf;
    const rate = Math.pow(2, (e.midi - s.root) / 12);
    if (rate !== 1) src.playbackRate.value = rate;
    const g = c.createGain();
    const p = g.gain;
    src.connect(g).connect(this.bus[e.layer].gain);
    src.start(t);
    src.onended = () => g.disconnect();
    if (s.loopEnd > 0) {
      src.loop = true;
      src.loopStart = s.loopStart;
      src.loopEnd = s.loopEnd;
      const dur = Math.max(0.05, e.dur * spb);
      const atk = Math.min(Math.max(0.005, e.atk), dur * 0.9);
      const rel = Math.max(0.05, e.rel);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(e.vel, t + atk);
      p.setValueAtTime(e.vel, t + dur);
      p.setTargetAtTime(0, t + dur, rel / 4);
      src.stop(t + dur + rel * 1.25);
      this.track(t + dur + rel * 1.25);
    } else {
      p.value = e.vel;
      this.track(t + s.buf.duration / rate);
    }
    this.noteAcc++;
  }

  private sounding(t: number): number {
    let n = 0;
    for (let i = 0; i < this.ends.length; i++) if (this.ends[i] > t) n++;
    return n;
  }

  private track(end: number): void {
    // Overwrite the earliest-ending slot so the ring always holds the longest-lived notes.
    let k = this.endIdx;
    for (let i = 0; i < this.ends.length; i++) if (this.ends[i] < this.ends[k]) k = i;
    this.ends[k] = end;
    this.endIdx = k;
  }

  dispose(): void {
    const t = this.c.currentTime;
    this.stopWorker();
    for (const l of LAYERS) this.bus[l].gain.gain.setTargetAtTime(0, t, 0.3);
  }
}
