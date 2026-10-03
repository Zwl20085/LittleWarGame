import type { CameraRig } from '../render/camera';
import type { World } from '../sim/world';
import { onSettingsChange, settings, type Settings } from '../ui/settings';
import { AlertWatcher } from './alerts';
import { BattleListener } from './battle';
import { FortuneWatch } from './fortune';
import { Mixer, newReq, PRIO } from './mixer';
import { Music, type MusicMode, type MusicMood } from './music';
import { RECIPES, SOUND_IDS } from './recipes';

export interface SessionOptions {
  /** Title-screen spectator battle: cinematic theme, no alerts. */
  readonly attract: boolean;
  readonly playerId: number;
  readonly spectator: boolean;
}

const CAT_UI = 15;
/** Battle effects sit a little under the score and UI cues (never fatiguing). */
const SFX_TRIM = 0.7;
const TOTAL_BUFFERS = SOUND_IDS.reduce((n, id) => n + RECIPES[id].variants, 0);

/** One running Game's view of the audio engine. */
export class AudioSession {
  private battle: BattleListener | null = null;
  private alerts: AlertWatcher | null = null;
  private fortune: FortuneWatch | null = null;
  private smooth = 0;
  private wasPaused = false;
  private costAcc = 0;
  private costN = 0;
  /** Average main-thread cost of update() over the last ~second (ms). */
  costMs = 0;
  disposed = false;

  constructor(private readonly engine: AudioEngine, readonly opts: SessionOptions) {}

  /** Call once per rendered frame, before the renderer consumes `world.fx`. */
  update(dt: number, w: World, rig: CameraRig, paused: boolean, feed: boolean): void {
    const mix = this.engine.mixer;
    if (this.disposed || !mix) return;
    const t0 = performance.now();
    mix.pump(4);
    if (!this.battle) {
      this.battle = new BattleListener(mix);
      this.alerts = new AlertWatcher(mix, this.opts.playerId, this.opts.spectator, !this.opts.attract, w);
      this.fortune = new FortuneWatch(this.opts.playerId, this.opts.spectator, this.opts.attract);
    }
    const battle = this.battle;
    battle.update(dt, w, rig, paused, feed);
    this.alerts!.update(dt, w, paused);
    // Smoothed intensity: quick to rise, slow to settle (no pumping).
    let target = battle.intensity;
    if (this.alerts!.dangerUntil > mix.ctx.currentTime) target = Math.max(target, 0.75);
    if (!paused) this.smooth += (target - this.smooth) * Math.min(1, dt / (target > this.smooth ? 1.5 : 6));
    const me = w.factions[this.opts.playerId];
    const over = !!w.result || (!this.opts.spectator && !this.opts.attract && !!me && !me.alive);
    const mode: MusicMode = this.opts.attract ? 'title' : over ? 'aftermath' : 'battle';
    this.fortune!.update(dt, w, paused);
    this.engine.drive(this.smooth, mode, this.fortune!);
    if (paused !== this.wasPaused) {
      this.wasPaused = paused;
      this.engine.setPaused(paused);
    }
    this.costAcc += performance.now() - t0;
    if (++this.costN >= 60) {
      this.costMs = this.costAcc / this.costN;
      this.costAcc = 0;
      this.costN = 0;
    }
  }

  get intensity(): number {
    return this.smooth;
  }

  get listener(): BattleListener | null {
    return this.battle;
  }

  get alertCues(): number {
    return this.alerts?.cues ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.battle?.dispose();
    this.engine.end(this);
  }
}

/**
 * Process-wide audio engine. Created lazily on the first user gesture (autoplay rules);
 * survives title → match transitions so the score crossfades instead of restarting.
 */
export class AudioEngine {
  mixer: Mixer | null = null;
  private music: Music | null = null;
  private current: AudioSession | null = null;
  private installed = false;
  private failed = false;
  private paused = false;
  private lastClick = 0;
  private readonly clickReq = newReq();

  /** Idempotent: hook the first-gesture unlock, UI clicks, settings and the debug handle. */
  install(): void {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    const unlock = (): void => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, unlock, { capture: true, passive: true });
    document.addEventListener('click', (e) => this.onClick(e), { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => {
      const c = this.mixer?.ctx;
      if (!c) return;
      if (document.hidden) void c.suspend().catch(() => undefined);
      else void c.resume().catch(() => undefined);
    });
    onSettingsChange((s) => this.applyVolumes(s));
    (window as unknown as { __audio: unknown }).__audio = { stats: () => this.stats(), unlock: () => this.unlock() };
  }

  /** Create / resume the AudioContext (must run inside a user gesture). */
  unlock(): void {
    if (this.failed) return;
    if (!this.mixer) {
      try {
        this.mixer = new Mixer();
        this.music = new Music(this.mixer);
        this.applyVolumes(settings());
        this.mixer.pump(6);
      } catch (err: unknown) {
        this.failed = true;
        this.mixer = null;
        console.warn('[audio] disabled:', err instanceof Error ? err.message : err);
        return;
      }
    }
    if (this.mixer.ctx.state === 'suspended' && !document.hidden) void this.mixer.ctx.resume().catch(() => undefined);
  }

  session(opts: SessionOptions): AudioSession {
    this.install();
    this.current?.dispose();
    this.current = new AudioSession(this, opts);
    return this.current;
  }

  /** A session ended (its Game was disposed). */
  end(s: AudioSession): void {
    if (this.current === s) this.current = null;
    if (this.paused) this.setPaused(false);
  }

  drive(intensity: number, mode: MusicMode, mood?: MusicMood): void {
    if (!this.music) return;
    this.music.setMode(mode);
    if (mood) this.music.setMood(mood);
    this.music.update(intensity);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.applyVolumes(settings());
  }

  private applyVolumes(s: Settings): void {
    const m = this.mixer;
    if (!m) return;
    const t = m.ctx.currentTime;
    const sq = (v: number): number => v * v;
    m.master.gain.setTargetAtTime(s.muted ? 0 : sq(s.volMaster), t, 0.05);
    // Paused: the score is ducked (not stopped) so the pause dossier stays calm.
    m.musicBus.gain.setTargetAtTime(sq(s.volMusic) * 0.9 * (this.paused ? 0.35 : 1), t, 0.25);
    m.sfxBus.gain.setTargetAtTime(sq(s.volSfx) * SFX_TRIM, t, 0.05);
    m.uiBus.gain.setTargetAtTime(sq(s.volSfx) * 0.9, t, 0.05);
  }

  /** Subtle switch click for buttons and toggles. */
  private onClick(e: Event): void {
    const m = this.mixer;
    const el = e.target as Element | null;
    if (!m || !el || typeof el.closest !== 'function') return;
    if (!el.closest('button, .btn, [role="button"], input[type="checkbox"], select, summary')) return;
    const now = performance.now();
    if (now - this.lastClick < 40) return;
    this.lastClick = now;
    const q = this.clickReq;
    q.id = 'click';
    q.gain = 0.22;
    q.rate = 0.95 + Math.random() * 0.1;
    q.bus = 'ui';
    q.prio = PRIO.own;
    q.cat = CAT_UI;
    q.catMax = 2;
    m.play(q);
  }

  stats(): Record<string, unknown> {
    const m = this.mixer;
    const s = this.current;
    const L = s?.listener;
    return {
      state: m ? m.ctx.state : this.failed ? 'failed' : 'locked',
      buffers: m ? `${m.ready}/${TOTAL_BUFFERS}` : '0',
      level: m ? m.level().map((x) => Math.round(x * 1000) / 1000) : null,
      voices: m ? m.activeVoices() : 0,
      voicePeak: m?.voicePeak ?? 0,
      dropped: m?.dropped ?? 0,
      stolen: m?.stolen ?? 0,
      culled: L?.culled ?? 0,
      intensity: s ? Math.round(s.intensity * 1000) / 1000 : 0,
      rawIntensity: L ? Math.round(L.intensity * 1000) / 1000 : 0,
      combat: L ? Math.round(L.combat * 1000) / 1000 : 0,
      zoomGain: L ? Math.round(L.zoomGain * 100) / 100 : 0,
      musicMode: this.music?.modeNow ?? null,
      musicLevel: this.music?.level ?? 0,
      musicSamples: this.music?.samplesReady ?? 0,
      musicNotesPerSec: this.music ? Math.round(this.music.notesPerSec * 10) / 10 : 0,
      paused: this.paused,
      alertCues: s?.alertCues ?? 0,
      updateMs: s ? Math.round(s.costMs * 1000) / 1000 : 0,
      hot: L ? [Math.round(L.hotX), Math.round(L.hotZ)] : null,
      rates: L?.rates() ?? {},
      plays: m ? { ...m.plays } : {},
    };
  }
}

export const audio = new AudioEngine();
