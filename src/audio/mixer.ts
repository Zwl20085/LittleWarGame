import type { BankMessage, BankRequest } from './bank.worker';
import { impulse, RECIPES, SOUND_IDS, type SoundId } from './recipes';

/** Hard cap on concurrent one-shot voices (loops and music are separate). */
export const MAX_VOICES = 24;
/** Above this many voices, quiet background sounds are culled. */
const BUSY_VOICES = 16;

/** The effects bank is synthesised at 32 kHz (resampled on playback) to halve build cost. */
const BANK_RATE = 32000;

export type Bus = 'near' | 'far' | 'ui' | 'alert';

/** Priorities (§15): danger warnings > own events > nearby fire > distant background. */
export const PRIO = { distant: 0, near: 1, own: 2, danger: 3 } as const;

/** Reusable play request — callers fill one shared object instead of allocating. */
export interface PlayReq {
  id: SoundId;
  variant: number;
  gain: number;
  pan: number;
  /** Lowpass cutoff (Hz); >= 16000 skips the filter node. */
  cutoff: number;
  rate: number;
  delay: number;
  bus: Bus;
  prio: number;
  /** Category for per-category concurrency limits (index into the caller's table). */
  cat: number;
  /** Max concurrent voices in this category. */
  catMax: number;
}

export const newReq = (): PlayReq => ({ id: 'click', variant: -1, gain: 1, pan: 0, cutoff: 20000, rate: 1, delay: 0, bus: 'near', prio: 1, cat: 0, catMax: 99 });

/**
 * Owns the AudioContext graph: master chain with glue compressor + brick-wall limiter,
 * music / effects / UI buses, two reverbs and the deterministic sound bank.
 */
export class Mixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly musicBus: GainNode;
  readonly sfxBus: GainNode;
  readonly uiBus: GainNode;
  /** Ducked briefly while an alert plays (priority). */
  readonly sfxDuck: GainNode;
  readonly musicIn: GainNode;
  readonly musicVerb: GainNode;
  private readonly near: GainNode;
  private readonly far: GainNode;
  private readonly buffers = new Map<SoundId, AudioBuffer[]>();
  private readonly pending: { id: SoundId; v: number }[] = [];
  private verbsPending = true;
  private readonly sfxConv: ConvolverNode;
  private readonly musicConv: ConvolverNode;
  private worker: Worker | null = null;
  private readonly meter: AnalyserNode;
  private meterBuf: Float32Array | null = null;

  // Voice pool (fixed arrays, no per-play bookkeeping allocations).
  private readonly vEnd = new Float64Array(MAX_VOICES);
  private readonly vPrio = new Int8Array(MAX_VOICES);
  private readonly vCat = new Int16Array(MAX_VOICES);
  private readonly vSrc: (AudioBufferSourceNode | null)[] = new Array(MAX_VOICES).fill(null);
  voicePeak = 0;
  dropped = 0;
  stolen = 0;
  readonly plays: Record<string, number> = {};

  constructor() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const c = this.ctx;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -20; glue.knee.value = 10; glue.ratio.value = 3; glue.attack.value = 0.01; glue.release.value = 0.3;
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -4; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.2;
    this.master = c.createGain();
    this.master.connect(glue).connect(limiter).connect(c.destination);
    this.meter = c.createAnalyser();
    this.meter.fftSize = 2048;
    limiter.connect(this.meter);
    this.musicBus = c.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus = c.createGain();
    this.sfxBus.connect(this.master);
    this.uiBus = c.createGain();
    this.uiBus.connect(this.master);
    this.sfxDuck = c.createGain();
    this.sfxDuck.connect(this.sfxBus);
    this.near = c.createGain();
    this.far = c.createGain();
    this.near.connect(this.sfxDuck);
    this.far.gain.value = 0.8;
    this.far.connect(this.sfxDuck);
    // Effects reverb: short outdoor slap, mostly on distant sounds.
    this.sfxConv = c.createConvolver();
    const sfxSend = c.createGain();
    sfxSend.gain.value = 0.5;
    const nearSend = c.createGain();
    nearSend.gain.value = 0.12;
    this.near.connect(nearSend).connect(this.sfxConv);
    this.far.connect(sfxSend).connect(this.sfxConv);
    this.sfxConv.connect(this.sfxDuck);
    // Music: dry + hall reverb.
    this.musicIn = c.createGain();
    this.musicIn.connect(this.musicBus);
    this.musicVerb = c.createGain();
    this.musicConv = c.createConvolver();
    const musicWet = c.createGain();
    musicWet.gain.value = 0.55;
    this.musicVerb.connect(this.musicConv).connect(musicWet).connect(this.musicBus);
    for (const id of SOUND_IDS) for (let v = 0; v < RECIPES[id].variants; v++) this.pending.push({ id, v });
    this.startWorker();
  }

  /** Build the bank in a worker; on any failure fall back to time-sliced main-thread synthesis. */
  private startWorker(): void {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('./bank.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      w.onmessage = (e: MessageEvent<BankMessage>) => this.onBank(e.data);
      w.onerror = (e) => {
        console.warn('[audio] bank worker failed, synthesising on main thread:', e.message);
        this.stopWorker();
      };
      const req: BankRequest = { rate: BANK_RATE, irRate: this.ctx.sampleRate };
      w.postMessage(req);
    } catch (err: unknown) {
      console.warn('[audio] bank worker unavailable:', err instanceof Error ? err.message : err);
      this.worker = null;
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private onBank(m: BankMessage): void {
    if (m.t === 'done') {
      this.stopWorker();
      return;
    }
    if (m.t === 'ir') {
      if (!this.verbsPending) return;
      (m.which === 'sfx' ? this.sfxConv : this.musicConv).buffer = this.makeStereo([m.l, m.r]);
      if (m.which === 'music') this.verbsPending = false;
      return;
    }
    const i = this.pending.findIndex((p) => p.id === m.id && p.v === m.v);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.store(m.id, m.data);
  }

  private store(id: SoundId, data: Float32Array): void {
    const buf = this.ctx.createBuffer(1, data.length, BANK_RATE);
    buf.copyToChannel(data, 0);
    const list = this.buffers.get(id) ?? [];
    list.push(buf);
    this.buffers.set(id, list);
  }

  /** Main-thread fallback: synthesise a time-boxed slice of the bank (no-op while the worker runs). */
  pump(budgetMs: number): void {
    if (this.worker || (!this.pending.length && !this.verbsPending)) return;
    const t0 = performance.now();
    if (this.verbsPending) {
      this.verbsPending = false;
      this.sfxConv.buffer = this.makeStereo(impulse(this.ctx.sampleRate, 1.4, 31, 3000));
      this.musicConv.buffer = this.makeStereo(impulse(this.ctx.sampleRate, 3.2, 77, 2400));
      if (performance.now() - t0 > budgetMs) return;
    }
    while (this.pending.length && performance.now() - t0 < budgetMs) {
      const { id, v } = this.pending.shift()!;
      this.store(id, RECIPES[id].make(BANK_RATE, v));
    }
  }

  get ready(): number {
    let n = 0;
    for (const l of this.buffers.values()) n += l.length;
    return n;
  }

  private makeStereo([l, r]: [Float32Array, Float32Array]): AudioBuffer {
    const b = this.ctx.createBuffer(2, l.length, this.ctx.sampleRate);
    b.copyToChannel(l, 0);
    b.copyToChannel(r, 1);
    return b;
  }

  buffer(id: SoundId, variant = -1): AudioBuffer | null {
    const list = this.buffers.get(id);
    if (!list || !list.length) return null;
    const v = variant < 0 ? Math.floor(Math.random() * list.length) : variant % list.length;
    return list[v];
  }

  /** Output level of the last ~43 ms (debug): [rms, peak]. */
  level(): [number, number] {
    const b = (this.meterBuf ??= new Float32Array(this.meter.fftSize));
    this.meter.getFloatTimeDomainData(b);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < b.length; i++) {
      sum += b[i] * b[i];
      peak = Math.max(peak, Math.abs(b[i]));
    }
    return [Math.sqrt(sum / b.length), peak];
  }

  /** Active one-shot voices right now. */
  activeVoices(): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (let i = 0; i < MAX_VOICES; i++) if (this.vEnd[i] > now) n++;
    return n;
  }

  /** Count active voices in a category. */
  catCount(cat: number): number {
    const now = this.ctx.currentTime;
    let n = 0;
    for (let i = 0; i < MAX_VOICES; i++) if (this.vEnd[i] > now && this.vCat[i] === cat) n++;
    return n;
  }

  /** Play a one-shot through the voice pool. Returns false when culled/dropped. */
  play(q: PlayReq): boolean {
    const buf = this.buffer(q.id, q.variant);
    if (!buf || q.gain < 0.004) return false;
    const now = this.ctx.currentTime;
    if (this.catCount(q.cat) >= q.catMax) {
      this.dropped++;
      return false;
    }
    // Free slot, else steal the lowest-priority voice that is closest to finishing.
    let slot = -1;
    let active = 0;
    let victim = -1;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.vEnd[i] <= now) {
        if (slot < 0) slot = i;
        continue;
      }
      active++;
      if (this.vPrio[i] <= q.prio && (victim < 0 || this.vPrio[i] < this.vPrio[victim] || (this.vPrio[i] === this.vPrio[victim] && this.vEnd[i] < this.vEnd[victim]))) victim = i;
    }
    // Busy pool: faint background voices give way so important sounds keep headroom.
    if (active >= BUSY_VOICES && q.prio <= PRIO.near && q.gain < 0.06) {
      this.dropped++;
      return false;
    }
    if (slot < 0) {
      if (victim < 0 || this.vPrio[victim] > q.prio) {
        this.dropped++;
        return false;
      }
      try { this.vSrc[victim]?.stop(now + 0.02); } catch { /* already stopped */ }
      this.stolen++;
      slot = victim;
    } else active++;
    this.voicePeak = Math.max(this.voicePeak, active);
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = q.rate;
    const g = c.createGain();
    g.gain.value = Math.min(1.5, q.gain);
    let head: AudioNode = g;
    if (q.cutoff < 16000) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.max(80, q.cutoff);
      f.Q.value = 0.5;
      f.connect(g);
      head = f;
    }
    src.connect(head);
    const out = q.bus === 'far' ? this.far : q.bus === 'near' ? this.near : this.uiBus;
    if (q.pan !== 0 && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, q.pan));
      g.connect(p).connect(out);
    } else g.connect(out);
    const at = now + Math.max(0, q.delay);
    src.start(at);
    this.vSrc[slot] = src;
    this.vEnd[slot] = at + buf.duration / Math.max(0.1, q.rate);
    this.vPrio[slot] = q.prio;
    this.vCat[slot] = q.cat;
    src.onended = () => {
      if (this.vSrc[slot] === src) this.vSrc[slot] = null;
      src.disconnect();
    };
    this.plays[q.id] = (this.plays[q.id] ?? 0) + 1;
    return true;
  }

  /** Long-lived looping voice (rumble bed); caller owns the nodes. */
  loop(id: SoundId, variant: number): { src: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; filter: BiquadFilterNode } | null {
    const buf = this.buffer(id, variant);
    if (!buf) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2000;
    const gain = c.createGain();
    gain.gain.value = 0;
    const pan = c.createStereoPanner();
    src.connect(filter).connect(gain).connect(pan).connect(this.near);
    src.start(c.currentTime + Math.random() * 0.05, Math.random() * buf.duration);
    return { src, gain, pan, filter };
  }

  dispose(): void {
    this.stopWorker();
    void this.ctx.close().catch(() => undefined);
  }
}
