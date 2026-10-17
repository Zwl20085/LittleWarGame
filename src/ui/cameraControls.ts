import type { Hotspot } from '../render/battleHeat';
import { CAMERA_MODES, CameraModes, type CameraMode } from '../render/cameraModes';
import type { GameContext } from './context';
import { h } from './dom';
import { onLangChange, t } from './i18n';
import { prefersReducedMotion } from './settings';

/**
 * 3.0 camera keys (V30_SPEC §4). R and F were taken (retreat / follow), so tilt is on [ and ]
 * (PageDown / PageUp still work). O orbit, K battle cam, F follow, Tab overview, Esc back to free.
 */
export const CAMERA_KEYS = { orbit: 'o', battle: 'k', follow: 'f', overview: 'tab', tiltDown: '[', tiltUp: ']' } as const;
const TILT_STEP = 5;
/** Battle-cam fallback when nothing is firing: where hostile units mix (cell size, m). */
const MIX_CELL = 120;

/**
 * Camera-mode keys, the HUD mode strip and the dip-to-black for battle-cam cuts. One instance
 * per match; registered with the input controller as a key handler (game.ts).
 */
export class CameraControls {
  readonly modes: CameraModes;
  readonly el: HTMLElement;
  private readonly dip: HTMLElement;
  private readonly buttons = new Map<CameraMode, HTMLButtonElement>();
  private readonly label: HTMLElement;
  private readonly offLang: () => void;

  constructor(private readonly ctx: GameContext, private readonly expandedFront: () => number | null) {
    this.dip = h('div', { class: 'cam-dip', 'aria-hidden': 'true' });
    // Right above the canvas: the black covers the map, never the HUD.
    ctx.renderer.renderer.domElement.after(this.dip);
    const w = ctx.match.world;
    this.modes = new CameraModes(ctx.renderer.rig, w, {
      onDip: (on) => this.dip.classList.toggle('dip', on),
      still: prefersReducedMotion(),
      fallback: () => this.mixSpot(),
    });
    this.label = h('span', { class: 'lbl' });
    for (const m of CAMERA_MODES) {
      this.buttons.set(m, h('button', { class: 'key cam-key', onclick: () => this.pick(m) }));
    }
    this.el = h('div', { class: 'cam-modes plate' }, this.label, ...this.buttons.values());
    this.modes.onChange = () => this.sync();
    this.offLang = onLangChange(() => this.relabel());
    this.relabel();
  }

  private pick(m: CameraMode): void {
    if (m === 'free') this.modes.exit();
    else if (m === 'overview') this.modes.toggleOverview();
    else if (m === 'follow') this.followSelection();
    else if (this.modes.mode === m) this.modes.exit();
    else this.modes.setMode(m);
  }

  /** F / the follow button: the first selected unit, else the expanded front card. */
  private followSelection(): void {
    if (this.modes.mode === 'follow') {
      this.modes.exit();
      return;
    }
    const first = this.ctx.renderer.units.selected.values().next();
    if (!first.done && this.modes.follow({ kind: 'unit', id: first.value })) return;
    const fid = this.expandedFront();
    if (fid !== null && this.modes.follow({ kind: 'front', faction: this.ctx.playerId, id: fid })) return;
    this.ctx.toast(t('cam.noFollow'), 'info');
  }

  followFront(frontId: number): void {
    if (!this.modes.follow({ kind: 'front', faction: this.ctx.playerId, id: frontId })) this.ctx.toast(t('cam.followLost'), 'warn');
  }

  /** Key handler (input.ts runs it first); true = the key was used here. */
  keydown(e: KeyboardEvent, k: string): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    const rig = this.ctx.renderer.rig;
    switch (k) {
      case CAMERA_KEYS.orbit:
        this.pick('orbit');
        return true;
      case CAMERA_KEYS.battle:
        this.pick('battle');
        return true;
      case CAMERA_KEYS.follow:
        this.followSelection();
        return true;
      case CAMERA_KEYS.overview:
        e.preventDefault();
        this.modes.toggleOverview();
        return true;
      case CAMERA_KEYS.tiltDown:
        rig.setElevation(rig.elevationGoal - TILT_STEP);
        return true;
      case CAMERA_KEYS.tiltUp:
        rig.setElevation(rig.elevationGoal + TILT_STEP);
        return true;
      case 'escape':
        // Order placement keeps priority for Esc; then a camera mode is left before anything else.
        return this.ctx.mode.kind === 'normal' && this.modes.exit();
      default:
        return false;
    }
  }

  /** Per frame (real seconds), before the renderer consumes this frame's fx. */
  update(dt: number): void {
    this.modes.ingest(this.ctx.match.world.fx);
    this.modes.update(dt);
  }

  /** Where hostile units are mixing (used only when no fight produced fx heat). */
  private mixSpot(): Hotspot | null {
    const w = this.ctx.match.world;
    const cols = Math.max(1, Math.ceil(w.terrain.width / MIX_CELL));
    const cells = new Map<number, Map<number, number>>();
    for (const u of w.units.values()) {
      if (u.hp <= 0 || u.fixed) continue;
      const key = Math.floor(u.pos.z / MIX_CELL) * cols + Math.floor(u.pos.x / MIX_CELL);
      let c = cells.get(key);
      if (!c) cells.set(key, (c = new Map()));
      c.set(u.owner, (c.get(u.owner) ?? 0) + 1);
    }
    let best: Hotspot | null = null;
    for (const [key, c] of cells) {
      if (c.size < 2) continue;
      const n = [...c.values()].sort((a, b) => b - a);
      const score = Math.min(n[0], n[1]);
      if (!best || score > best.score) best = { x: ((key % cols) + 0.5) * MIX_CELL, z: (Math.floor(key / cols) + 0.5) * MIX_CELL, score };
    }
    return best;
  }

  private relabel(): void {
    this.label.textContent = t('cam.label');
    for (const [m, b] of this.buttons) {
      b.textContent = t(`cam.${m}`);
      b.title = t(`cam.tip.${m}`);
    }
    this.sync();
  }

  private sync(): void {
    const cur = this.modes.mode;
    for (const [m, b] of this.buttons) {
      b.classList.toggle('on', m === cur);
      b.setAttribute('aria-pressed', String(m === cur));
    }
    this.el.dataset.mode = cur;
  }

  dispose(): void {
    this.offLang();
    this.modes.exit();
    this.dip.remove();
    this.el.remove();
  }
}
