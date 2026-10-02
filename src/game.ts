import { audio, type AudioSession } from './audio';
import type { GameData } from './data/types';
import { GameRenderer } from './render/renderer';
import { CommandBus, type CommandFail } from './sim/commands';
import { createMatch, step, type Match } from './sim/sim';
import { SimHost } from './simhost';
import type { MatchConfig } from './sim/types';
import { DEG } from './sim/vec';
import type { GameContext } from './ui/context';
import { h } from './ui/dom';
import { Hud } from './ui/hud';
import { t } from './ui/i18n';
import { InputController } from './ui/input';
import { showPauseMenu } from './ui/pause';
import { showResults } from './ui/results';
import { onSettingsChange, prefersReducedMotion, settings, type Settings } from './ui/settings';

const MAX_TICKS_PER_FRAME = 24;
/** Max milliseconds of simulation per rendered frame. */
const SIM_BUDGET_MS = 14;

export interface GameOptions {
  /**
   * Title-screen "attract" mode: an all-AI spectator battle used as a live background —
   * no HUD, no input, no fog, no results screen.
   */
  readonly attract?: boolean;
}

/** One running match: fixed-tick sim + interpolated render + HUD. */
export class Game {
  readonly match: Match;
  readonly renderer: GameRenderer;
  readonly ctx: GameContext;
  readonly attract: boolean;
  /** Per-frame hook (real seconds) — the title screen drives its cinematic camera with it. */
  onFrame: ((dtReal: number) => void) | null = null;
  /** Skip drawing (e.g. while the title battle warms up off-screen). */
  renderSuspended = false;
  lagTicks = 0;
  private slowSmoothed = 0;
  private readonly slowBadge = h('div', { class: 'sim-slow-badge' }, t('hud.simSlow'));
  private readonly bus = new CommandBus();
  /** Simulation worker (null = run the sim on this thread, e.g. without Worker support). */
  private readonly host: SimHost | null;
  private readonly hud: Hud | null;
  private readonly input: InputController | null;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private hudTimer = 0;
  private resultsShown = false;
  private playerDeadShown = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly onResize = (): void => this.renderer.resize();
  private readonly offSettings: () => void;
  private pauseMenu: (() => void) | null = null;
  private readonly audio: AudioSession;

  constructor(private readonly root: HTMLElement, data: GameData, readonly config: MatchConfig, private readonly exits: { again: () => void; menu: () => void }, opts: GameOptions = {}) {
    this.attract = !!opts.attract;
    this.canvas = h('canvas', { class: 'view' });
    root.append(this.canvas);
    this.slowBadge.style.display = 'none';
    root.append(this.slowBadge);
    // The main thread builds the same deterministic match (terrain for rendering + the mirror
    // world); the worker builds its own copy and becomes authoritative.
    this.match = createMatch(data, config);
    this.host = typeof Worker !== 'undefined' ? new SimHost(this.match, config, config.playerSlot) : null;
    this.renderer = new GameRenderer(this.canvas, this.match);
    const spectator = !!config.spectate || this.attract;
    this.audio = audio.session({ attract: this.attract, playerId: config.playerSlot, spectator });
    this.renderer.playerId = config.playerSlot;
    this.renderer.fog = config.infoMode === 'fog' && !spectator;
    this.applySettings(settings());
    this.offSettings = onSettingsChange((s) => this.applySettings(s));
    const self = this;
    this.ctx = {
      match: this.match, bus: this.bus, renderer: this.renderer, playerId: config.playerSlot, spectator,
      speed: 1, paused: false, mode: { kind: 'normal' }, hudHidden: false, openPanel: null,
      issue(cmd) {
        if (self.host) self.host.issue(config.playerSlot, cmd);
        else self.bus.issue(self.match, config.playerSlot, cmd);
      },
      toast(text, sev) { self.hud?.toast(text, sev); },
    };
    this.bus.onResult = (env, out) => {
      if (!out.ok && env.actor === config.playerSlot) this.hud?.toast(t(`fail.${out.reason as CommandFail}`), 'warn');
    };
    if (this.host) {
      this.host.onCommandResult = this.bus.onResult;
      this.host.onError = (m) => console.error('[sim worker]', m);
    }
    if (this.attract) {
      this.hud = null;
      this.input = null;
    } else {
      this.hud = new Hud(root, this.ctx);
      this.input = new InputController(this.canvas, this.ctx, this.hud);
      this.input.onEscape = () => this.togglePauseMenu();
    }
    window.addEventListener('resize', this.onResize);
    this.renderer.resize();
    const city = this.match.world.cityOf(config.playerSlot);
    const look = { x: (city.hq.x * 0.45 + city.vanguard[1].x * 0.55), z: (city.hq.z * 0.45 + city.vanguard[1].z * 0.55) };
    this.renderer.rig.lookAt(look.x, look.z);
    this.renderer.rig.faceHeading(city.forwardDeg * DEG, true);
    if (spectator && !this.attract) {
      this.renderer.rig.lookAt(this.match.world.terrain.width / 2, this.match.world.terrain.depth / 2);
      this.renderer.rig.setZoom(0.5);
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  private applySettings(s: Settings): void {
    const fx = this.renderer.effects;
    fx.smokeScale = s.smoke;
    fx.reducedMotion = !s.shake || prefersReducedMotion();
  }

  private togglePauseMenu(): void {
    if (this.pauseMenu) {
      this.pauseMenu();
      this.pauseMenu = null;
      this.ctx.paused = false;
      return;
    }
    this.ctx.paused = true;
    this.pauseMenu = showPauseMenu(this.root, { resume: () => this.togglePauseMenu(), quit: () => this.exits.menu() });
  }

  private readonly frame = (now: number): void => {
    const dtReal = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const w = this.match.world;
    const ctx = this.ctx;
    // Commands issued while paused are recorded and applied on the next tick (§4.1).
    let alpha = 1;
    if (this.host) {
      if (!ctx.paused && !w.result) {
        this.acc = Math.min(this.acc + dtReal * ctx.speed, w.dt * MAX_TICKS_PER_FRAME);
        if (!this.host.busy && this.acc >= w.dt) {
          const n = Math.min(MAX_TICKS_PER_FRAME, Math.floor(this.acc / w.dt));
          if (this.host.advance(n)) this.acc -= n * w.dt;
        }
        // Behind = requested time keeps piling up because the worker cannot keep pace.
        const behind = this.acc >= w.dt * (MAX_TICKS_PER_FRAME - 1);
        this.lagTicks = behind ? Math.round(this.acc / w.dt) : 0;
        this.slowSmoothed = this.slowSmoothed * 0.9 + (behind ? 1 : 0) * 0.1;
        this.slowBadge.style.display = this.slowSmoothed > 0.5 && !this.attract ? '' : 'none';
        // Interpolate across the last tick over the time the batch is expected to take.
        const span = (this.host.lastBatch * w.dt * 1000) / Math.max(0.25, ctx.speed);
        alpha = Math.min(1, (now - this.host.lastSnapAt) / Math.max(16, span / this.host.lastBatch));
      }
    } else if (!ctx.paused && !w.result) {
      this.acc += dtReal * ctx.speed;
      let n = 0;
      // Time-box the simulation per frame so rendering/input stay responsive. If the sim cannot
      // keep up, the game runs slower than requested instead of freezing (shown in the HUD).
      const t0 = performance.now();
      while (this.acc >= w.dt && n < MAX_TICKS_PER_FRAME && (n === 0 || performance.now() - t0 < SIM_BUDGET_MS)) {
        this.bus.flush(this.match);
        step(this.match);
        this.acc -= w.dt;
        n++;
      }
      const behind = this.acc > w.dt * 2;
      this.lagTicks = behind ? Math.round(this.acc / w.dt) : 0;
      if (behind) this.acc = w.dt * 2;
      this.slowSmoothed = this.slowSmoothed * 0.9 + (behind ? 1 : 0) * 0.1;
      this.slowBadge.style.display = this.slowSmoothed > 0.5 && !this.attract ? '' : 'none';
    }
    this.input?.update(dtReal);
    this.onFrame?.(dtReal);
    if (!this.host) alpha = ctx.paused ? 1 : Math.min(1, this.acc / w.dt);
    // Audio reads world.fx before the renderer consumes it.
    this.audio.update(dtReal, w, this.renderer.rig, ctx.paused, !this.renderSuspended);
    if (!this.renderSuspended) this.renderer.frame(alpha, ctx.paused ? 0 : dtReal * ctx.speed);
    this.hudTimer -= dtReal;
    if (this.hud && this.hudTimer <= 0) {
      this.hud.refresh();
      this.hudTimer = 0.2;
    }
    if (!this.attract) this.checkEnd();
    this.raf = requestAnimationFrame(this.frame);
  };

  private checkEnd(): void {
    const w = this.match.world;
    const me = w.factions[this.ctx.playerId];
    if (w.result && !this.resultsShown) {
      this.resultsShown = true;
      showResults(this.root, w, this.ctx.playerId, this.ctx.spectator, { ...this.exits, watch: () => undefined });
    } else if (!this.ctx.spectator && me && !me.alive && !this.playerDeadShown && !w.result) {
      this.playerDeadShown = true;
      this.renderer.fog = false;
      showResults(this.root, w, this.ctx.playerId, this.ctx.spectator, { ...this.exits, watch: () => undefined });
    }
  }

  /** Run the simulation forward without rendering (QA helper; also warms up the title battle). */
  async fastForward(seconds: number, budgetMs = 60000): Promise<void> {
    if (this.host) {
      await this.host.fastForward(seconds, budgetMs);
      return;
    }
    const w = this.match.world;
    const n = Math.round(seconds * w.tickHz);
    for (let i = 0; i < n && !w.result; i++) {
      this.bus.flush(this.match);
      step(this.match);
      if (w.fx.length > 3000) w.fx.length = 0;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.audio.dispose();
    this.host?.dispose();
    window.removeEventListener('resize', this.onResize);
    this.offSettings();
    this.pauseMenu?.();
    this.input?.dispose();
    this.hud?.dispose();
    this.renderer.dispose();
    // Free the WebGL context now: the title screen and matches create one each.
    this.renderer.renderer.forceContextLoss();
    this.root.innerHTML = '';
  }
}
