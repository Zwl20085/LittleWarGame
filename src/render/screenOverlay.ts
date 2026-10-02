import * as THREE from 'three';

/**
 * A 2D canvas laid over the WebGL canvas (pointer-events: none). Unit counters, HP bars and
 * map labels are drawn here each frame from projected positions — no per-unit sprites.
 */
export class ScreenOverlay {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** CSS pixel size. */
  w = 1;
  h = 1;
  dpr = 1;
  private readonly vp = new THREE.Matrix4();

  constructor(glCanvas: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'render-overlay';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'block' });
    glCanvas.after(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
  }

  /** Start a frame: clear and capture the camera's view-projection. */
  begin(camera: THREE.Camera): void {
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
  }

  /** Project a world point to CSS pixels; returns false when behind/outside the clip volume. */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const e = this.vp.elements;
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
    const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
    const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) / cw;
    out.x = (nx + 1) * 0.5 * this.w;
    out.y = (1 - ny) * 0.5 * this.h;
    return nz > -1 && nz < 1;
  }

  onScreen(p: { x: number; y: number }, margin = 40): boolean {
    return p.x > -margin && p.y > -margin && p.x < this.w + margin && p.y < this.h + margin;
  }

  dispose(): void {
    this.canvas.remove();
  }
}

/** Simple rectangle declutter: rejects boxes overlapping already placed ones (grid-bucketed). */
export class Declutter {
  private readonly cells = new Map<number, number[]>();
  private readonly boxes: number[] = [];
  private readonly size = 64;

  clear(): void {
    this.cells.clear();
    this.boxes.length = 0;
  }

  /** Try to place a box; returns true (and records it) when free. */
  place(x0: number, y0: number, x1: number, y1: number, force = false): boolean {
    const s = this.size;
    const i0 = Math.floor(x0 / s);
    const i1 = Math.floor(x1 / s);
    const j0 = Math.floor(y0 / s);
    const j1 = Math.floor(y1 / s);
    if (!force) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const list = this.cells.get(j * 4096 + i);
          if (!list) continue;
          for (const b of list) {
            const bx = this.boxes;
            if (x0 < bx[b + 2] && x1 > bx[b] && y0 < bx[b + 3] && y1 > bx[b + 1]) return false;
          }
        }
      }
    }
    const idx = this.boxes.length;
    this.boxes.push(x0, y0, x1, y1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = j * 4096 + i;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(idx);
      }
    }
    return true;
  }
}
