import * as THREE from 'three';
import type { Unit } from '../sim/types';
import type { GameContext } from './context';
import type { Hud } from './hud';
import { TerrainTip } from './terrainTip';

/** Mouse/keyboard → camera moves and CommandBus commands. Never mutates the sim directly. */
export class InputController {
  private readonly keys = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;
  private panDrag: { x: number; y: number } | null = null;
  private readonly box: HTMLDivElement;
  private readonly off: (() => void)[] = [];
  private lastPointer = new THREE.Vector2();
  private readonly terrainTip: TerrainTip;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ctx: GameContext, private readonly hud: Hud) {
    this.box = document.createElement('div');
    this.box.className = 'select-box';
    document.body.append(this.box);
    this.terrainTip = new TerrainTip(canvas, ctx);
    hud.root.append(this.terrainTip.el);
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, ev: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(ev, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(ev, fn as EventListener));
    };
    on(canvas, 'mousedown', (e) => this.down(e));
    on(window, 'mousemove', (e) => this.move(e));
    on(window, 'mouseup', (e) => this.up(e));
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'wheel', (e) => this.wheel(e), { passive: false });
    on(window, 'keydown', (e) => this.keydown(e));
    on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  dispose(): void {
    for (const f of this.off) f();
    this.terrainTip.dispose();
    this.box.remove();
  }

  private ndc(e: MouseEvent): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private viewport(): { w: number; h: number } {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  private mine = (u: Unit): boolean => u.owner === this.ctx.playerId && !u.fixed && !this.ctx.spectator;

  private down(e: MouseEvent): void {
    if (e.button === 1) {
      this.panDrag = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      if (this.ctx.mode.kind !== 'normal') {
        this.modeClick(e);
        return;
      }
      this.dragStart = { x: e.clientX, y: e.clientY };
    }
    if (e.button === 2) this.rightClick(e);
  }

  private modeClick(e: MouseEvent): void {
    const p = this.ctx.renderer.groundAt(this.ndc(e));
    const m = this.ctx.mode;
    this.ctx.mode = { kind: 'normal' };
    if (!p) return;
    if (m.kind === 'attackMove') {
      const ids = [...this.ctx.renderer.units.selected];
      this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'attackMove', pos: p, queue: e.shiftKey });
      this.ctx.renderer.orderMarker(p, '#e08050');
    } else if (m.kind === 'sectorTarget') {
      this.ctx.issue({ type: 'setSectorTarget', sectorId: m.sectorId, pos: p });
      this.ctx.renderer.orderMarker(p, '#f4ecd9');
    } else if (m.kind === 'air') {
      this.ctx.issue({ type: 'air', missionId: m.missionId, pos: p });
      this.ctx.renderer.orderMarker(p, '#e0c070');
    }
  }

  private rightClick(e: MouseEvent): void {
    if (this.ctx.mode.kind !== 'normal') {
      this.ctx.mode = { kind: 'normal' };
      return;
    }
    const ids = [...this.ctx.renderer.units.selected];
    if (ids.length === 0 || this.ctx.spectator) return;
    const ndc = this.ndc(e);
    const w = this.ctx.match.world;
    const enemy = this.ctx.renderer.units.pick(ndc, this.ctx.renderer.rig.camera, 22, this.viewport(), (u) => w.isHostile(this.ctx.playerId, u.owner) && w.knows(this.ctx.playerId, u));
    if (enemy) {
      this.ctx.issue({ type: 'focus', unitIds: ids, targetId: enemy.id });
      this.ctx.renderer.orderMarker(enemy.pos, '#a63f36');
      return;
    }
    const p = this.ctx.renderer.groundAt(ndc);
    if (!p) return;
    this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: e.ctrlKey ? 'moveHold' : 'move', pos: p, queue: e.shiftKey });
    this.ctx.renderer.orderMarker(p, '#9fd08a');
  }

  private move(e: MouseEvent): void {
    this.lastPointer = this.ndc(e);
    if (this.panDrag) {
      const dx = e.clientX - this.panDrag.x;
      const dy = e.clientY - this.panDrag.y;
      this.panDrag = { x: e.clientX, y: e.clientY };
      const k = 1 / this.ctx.renderer.rig.zoom;
      this.ctx.renderer.rig.pan(-dx * k * 0.5, dy * k * 0.7);
      return;
    }
    if (this.dragStart) {
      const x0 = Math.min(this.dragStart.x, e.clientX);
      const y0 = Math.min(this.dragStart.y, e.clientY);
      const w = Math.abs(e.clientX - this.dragStart.x);
      const hgt = Math.abs(e.clientY - this.dragStart.y);
      if (w > 4 || hgt > 4) {
        Object.assign(this.box.style, { display: 'block', left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${hgt}px` });
      }
    } else if (e.target === this.canvas) {
      const u = this.ctx.renderer.units.pick(this.lastPointer, this.ctx.renderer.rig.camera, 18, this.viewport(), () => true);
      this.ctx.renderer.units.hovered = u?.id ?? null;
    }
  }

  private up(e: MouseEvent): void {
    if (e.button === 1) {
      this.panDrag = null;
      return;
    }
    if (e.button !== 0 || !this.dragStart) return;
    const start = this.dragStart;
    this.dragStart = null;
    this.box.style.display = 'none';
    const sel = this.ctx.renderer.units.selected;
    const additive = e.shiftKey;
    const dragged = Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4;
    const cam = this.ctx.renderer.rig.camera;
    if (!additive) sel.clear();
    this.hud.selection.inspectEnemy = null;
    if (dragged) {
      const r = this.canvas.getBoundingClientRect();
      const a = new THREE.Vector2(((start.x - r.left) / r.width) * 2 - 1, -((start.y - r.top) / r.height) * 2 + 1);
      for (const u of this.ctx.renderer.units.inRect(a, this.ndc(e), cam, this.mine)) sel.add(u.id);
      return;
    }
    const u = this.ctx.renderer.units.pick(this.ndc(e), cam, 20, this.viewport(), () => true);
    if (!u) return;
    if (this.mine(u)) {
      if (additive && sel.has(u.id)) sel.delete(u.id);
      else sel.add(u.id);
    } else {
      this.hud.selection.inspectEnemy = u.id;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      this.ctx.renderer.rig.setElevation(this.ctx.renderer.rig.elevationGoal - Math.sign(e.deltaY) * 3);
      return;
    }
    this.ctx.renderer.rig.zoomBy(e.deltaY > 0 ? 0.88 : 1.14);
  }

  private keydown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    const ids = [...this.ctx.renderer.units.selected];
    const rig = this.ctx.renderer.rig;
    switch (k) {
      case ' ':
        this.ctx.paused = !this.ctx.paused;
        e.preventDefault();
        break;
      case 'a':
        if (ids.length > 0 && !this.ctx.spectator) this.ctx.mode = { kind: 'attackMove' };
        break;
      case 'h':
        if (ids.length) this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'hold' });
        break;
      case 'r':
        if (ids.length) this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'retreat' });
        break;
      case 'g':
        if (ids.length) this.ctx.issue({ type: 'unitOrder', unitIds: ids, order: 'resume' });
        break;
      case 'q':
        rig.rotate(Math.PI / 8);
        break;
      case 'e':
        rig.rotate(-Math.PI / 8);
        break;
      case 'pageup':
        rig.setElevation(rig.elevationGoal + 5);
        break;
      case 'pagedown':
        rig.setElevation(rig.elevationGoal - 5);
        break;
      case 'tab':
        e.preventDefault();
        rig.setElevation(rig.elevationGoal > 60 ? 45 : 70);
        rig.setZoom(rig.elevationGoal > 60 ? 0.55 : 1);
        break;
      case 'f': {
        const first = ids[0];
        if (first !== undefined) {
          rig.follow = () => {
            const u = this.ctx.match.world.unitAlive(first);
            return u ? new THREE.Vector3(u.pos.x, u.y, u.pos.z) : null;
          };
        }
        break;
      }
      case 'u':
        this.ctx.hudHidden = !this.ctx.hudHidden;
        break;
      case 'escape':
        if (this.ctx.mode.kind !== 'normal') this.ctx.mode = { kind: 'normal' };
        else if (this.ctx.renderer.units.selected.size > 0) this.ctx.renderer.units.selected.clear();
        else this.onEscape?.();
        break;
      case '1': case '2': case '3':
        if (!this.ctx.spectator) this.hud.sectors.toggle(Number(k) - 1);
        break;
      default:
        break;
    }
  }

  onEscape: (() => void) | null = null;

  /** Continuous keyboard panning; call each frame. */
  update(dt: number): void {
    const rig = this.ctx.renderer.rig;
    const sp = (420 * dt) / rig.zoom;
    let right = 0;
    let fwd = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += sp;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= sp;
    if (this.keys.has('d') || this.keys.has('arrowright')) right += sp;
    if (this.keys.has('arrowleft')) right -= sp;
    if (this.keys.has('a') && this.ctx.renderer.units.selected.size === 0) right -= sp;
    if (right !== 0 || fwd !== 0) rig.pan(right, fwd);
  }
}
