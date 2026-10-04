import { frontOrderShape, ORDER_COLOR } from '../render/orderLines';
import { CONTESTED, NEUTRAL } from '../sim/frontline';
import { Ground } from '../sim/terrain';
import type { GameContext } from './context';
import { h, setText } from './dom';
import { t } from './i18n';
import { frontLabel } from './labels';

/** Bottom-right: minimap and layer toggles. */
export class MinimapPanel {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly base: HTMLCanvasElement;
  private readonly layerBtns: { key: string; el: HTMLButtonElement }[] = [];
  private readonly layerState: Record<string, boolean>;
  private readonly scale: number;

  constructor(private readonly ctx: GameContext) {
    const w = ctx.match.world;
    const size = 210;
    this.scale = size / Math.max(w.terrain.width, w.terrain.depth);
    this.canvas = h('canvas', { width: Math.round(w.terrain.width * this.scale), height: Math.round(w.terrain.depth * this.scale), class: 'minimap' });
    this.base = document.createElement('canvas');
    this.base.width = this.canvas.width;
    this.base.height = this.canvas.height;
    this.paintBase();
    this.canvas.addEventListener('mousedown', (e) => this.jump(e));
    this.canvas.addEventListener('mousemove', (e) => { if (e.buttons & 1) this.jump(e); });
    const layers = h('div', { class: 'layers' });
    // Layers are a plain flag bag on the renderer; 'terrain' appears once the renderer supports it.
    this.layerState = ctx.renderer.layers as unknown as Record<string, boolean>;
    const keys = ['front', 'supply', 'ranges', 'fronts', 'terrain'].filter((k) => k in this.layerState);
    for (const key of keys) {
      const el = h('button', { class: 'btn tag', 'aria-pressed': 'false', onclick: () => {
        this.layerState[key] = !this.layerState[key];
        ctx.renderer.forceFrontRepaint();
      } }, t(`layer.${key}`));
      this.layerBtns.push({ key, el });
      layers.append(el);
    }
    this.el = h('div', { class: 'minipanel panel paper-stack' }, h('div', { class: 'map-frame' }, this.canvas, h('span', { class: 'compass', 'aria-hidden': 'true' }, 'N')), layers);
  }

  relabel(): void {
    for (const l of this.layerBtns) setText(l.el, t(`layer.${l.key}`));
  }

  private paintBase(): void {
    const w = this.ctx.match.world;
    const g = this.base.getContext('2d')!;
    const img = g.createImageData(this.base.width, this.base.height);
    for (let j = 0; j < this.base.height; j++) {
      for (let i = 0; i < this.base.width; i++) {
        const x = i / this.scale;
        const z = j / this.scale;
        const hgt = w.terrain.heightAt(x, z);
        const gr = w.terrain.groundAt(x, z);
        let r = 190, gg = 180, b = 140;
        if (gr === Ground.Forest) { r = 120; gg = 135; b = 90; }
        else if (gr === Ground.Road) { r = 220; gg = 205; b = 165; }
        else if (gr === Ground.Town) { r = 175; gg = 165; b = 150; }
        else if (gr === Ground.Mud) { r = 140; gg = 120; b = 90; }
        const shade = 0.75 + Math.min(0.4, hgt / 160);
        const k = (j * this.base.width + i) * 4;
        img.data[k] = r * shade;
        img.data[k + 1] = gg * shade;
        img.data[k + 2] = b * shade;
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private jump(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.canvas.width / this.scale;
    const z = ((e.clientY - r.top) / r.height) * this.canvas.height / this.scale;
    this.ctx.renderer.rig.lookAt(x, z);
  }

  /** Standing supreme-HQ orders (the player's; every faction's, thin, when spectating) + front names. */
  private drawOrders(g: CanvasRenderingContext2D): void {
    const w = this.ctx.match.world;
    const k = this.scale;
    const spect = this.ctx.spectator;
    g.save();
    g.lineCap = 'round';
    for (const f of w.factions) {
      if ((!spect && f.id !== this.ctx.playerId) || !f.alive) continue;
      for (const s of f.fronts) {
        const sh = frontOrderShape(w, f, s);
        const col = ORDER_COLOR[s.order.kind];
        if (sh) {
          g.setLineDash(s.order.kind === 'fallBack' ? [3, 2] : []);
          const strokeSeg = (a: { x: number; z: number }, b: { x: number; z: number }, width: number): void => {
            g.beginPath();
            g.moveTo(a.x * k, a.z * k);
            g.lineTo(b.x * k, b.z * k);
            g.strokeStyle = '#1f231e';
            g.lineWidth = width + 1.6;
            g.stroke();
            g.strokeStyle = col;
            g.lineWidth = width;
            g.stroke();
          };
          const lw = spect ? 1.5 : 2.5;
          if (sh.line) strokeSeg(sh.line.a, sh.line.b, lw);
          if (sh.arrow) {
            strokeSeg(sh.arrow.from, sh.arrow.to, lw * 0.7);
            const { from, to } = sh.arrow;
            const ang = Math.atan2(to.z - from.z, to.x - from.x);
            g.setLineDash([]);
            g.fillStyle = col;
            g.beginPath();
            g.moveTo(to.x * k + Math.cos(ang) * 4, to.z * k + Math.sin(ang) * 4);
            g.lineTo(to.x * k + Math.cos(ang + 2.4) * 5, to.z * k + Math.sin(ang + 2.4) * 5);
            g.lineTo(to.x * k + Math.cos(ang - 2.4) * 5, to.z * k + Math.sin(ang - 2.4) * 5);
            g.closePath();
            g.fill();
          }
        }
        if (spect) continue;
        // Front name at its line (or battle line), stamped small.
        const at = sh ? sh.anchor : s.front;
        const name = frontLabel(w, f.id, s.id);
        g.setLineDash([]);
        g.font = '600 9px "Oswald", "Microsoft YaHei", sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineWidth = 2.5;
        g.strokeStyle = 'rgba(31, 35, 30, 0.85)';
        g.strokeText(name, at.x * k, at.z * k - 7);
        g.fillStyle = s.id === f.mainFront ? '#e3c27a' : '#f4ecd9';
        g.fillText(name, at.x * k, at.z * k - 7);
      }
    }
    g.restore();
  }

  refresh(): void {
    const w = this.ctx.match.world;
    const g = this.canvas.getContext('2d')!;
    g.drawImage(this.base, 0, 0);
    const field = this.ctx.match.frontView ?? this.ctx.match.front;
    if (this.ctx.renderer.layers.front) {
      const cs = field.cell * this.scale;
      for (let j = 0; j < field.nz; j++) {
        for (let i = 0; i < field.nx; i++) {
          const o = field.owner[j * field.nx + i];
          if (o === NEUTRAL) continue;
          g.fillStyle = o === CONTESTED ? 'rgba(230,190,90,0.35)' : w.factions[o].color + '55';
          g.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5);
        }
      }
    }
    for (const o of w.objectives) {
      g.fillStyle = o.owner >= 0 ? w.factions[o.owner].color : '#f4ecd9';
      g.strokeStyle = '#1f231e';
      g.beginPath();
      g.arc(o.pos.x * this.scale, o.pos.z * this.scale, 4, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    for (const f of w.factions) {
      const c = w.cityOf(f.id).hq;
      g.fillStyle = f.alive ? f.color : '#555';
      g.fillRect(c.x * this.scale - 5, c.z * this.scale - 5, 10, 10);
      g.strokeRect(c.x * this.scale - 5, c.z * this.scale - 5, 10, 10);
    }
    const fog = w.config.infoMode === 'fog' && !this.ctx.spectator;
    for (const u of w.units.values()) {
      if (u.hp <= 0) continue;
      if (fog && u.owner !== this.ctx.playerId && !w.visibleTo[this.ctx.playerId].has(u.id)) continue;
      g.fillStyle = w.factions[u.owner].color;
      const s = u.def.kind === 'vehicle' ? 3 : 2;
      g.fillRect(u.pos.x * this.scale - s / 2, u.pos.z * this.scale - s / 2, s, s);
    }
    if (this.ctx.renderer.layers.fronts) this.drawOrders(g);
    const corners = this.ctx.renderer.rig.viewCorners();
    if (corners.length === 4) {
      g.strokeStyle = '#f4ecd9';
      g.lineWidth = 1.5;
      g.beginPath();
      corners.forEach((c, k) => (k === 0 ? g.moveTo(c.x * this.scale, c.z * this.scale) : g.lineTo(c.x * this.scale, c.z * this.scale)));
      g.closePath();
      g.stroke();
    }
    for (const l of this.layerBtns) {
      const on = !!this.layerState[l.key];
      l.el.classList.toggle('on', on);
      l.el.setAttribute('aria-pressed', String(on));
    }
  }
}
