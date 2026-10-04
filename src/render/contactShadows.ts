import * as THREE from 'three';
import { InstanceBatch } from './instancing';

/**
 * Soft contact shadows: one dark, blurred, ground-aligned quad under every soldier, gun and
 * vehicle (a single instanced draw, no shadow-map cost). They make units visibly sit on the
 * ground where the sun shadow is weak, off (low tier) or falls away from the feet on a slope.
 */

/** Lift along the ground normal (m) on top of the polygon offset, against z-fighting. */
const LIFT = 0.06;
const BLACK = new THREE.Color(0, 0, 0);

function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.45, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.75, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ContactShadows {
  private readonly batch: InstanceBatch;

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: '#000000', map: blobTexture(), transparent: true, opacity: 0.6, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false,
    });
    this.batch = new InstanceBatch(parent, geo, mat, 1024, false);
    // Before the other transparent passes (effects, rings) so smoke is not darkened twice.
    this.batch.mesh.renderOrder = -1;
  }

  begin(): void {
    this.batch.begin();
  }

  end(): void {
    this.batch.end();
  }

  /**
   * A blob centred at (x, y, z) on ground with unit normal (nx, ny, nz), elongated along the
   * horizontal heading (ch, sh): half-extents `ra` along and `rb` across (m).
   */
  push(x: number, y: number, z: number, nx: number, ny: number, nz: number, ch: number, sh: number, ra: number, rb: number): void {
    // Forward tangent: heading projected onto the ground plane.
    let fx = ch - nx * (ch * nx + sh * nz);
    let fy = -ny * (ch * nx + sh * nz);
    let fz = sh - nz * (ch * nx + sh * nz);
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // Side = forward × normal.
    const sx = fy * nz - fz * ny;
    const sy = fz * nx - fx * nz;
    const sz = fx * ny - fy * nx;
    const at = this.batch.next(BLACK);
    const te = this.batch.matrices;
    te[at] = fx * ra; te[at + 1] = fy * ra; te[at + 2] = fz * ra; te[at + 3] = 0;
    te[at + 4] = nx; te[at + 5] = ny; te[at + 6] = nz; te[at + 7] = 0;
    te[at + 8] = sx * rb; te[at + 9] = sy * rb; te[at + 10] = sz * rb; te[at + 11] = 0;
    te[at + 12] = x + nx * LIFT; te[at + 13] = y + ny * LIFT; te[at + 14] = z + nz * LIFT; te[at + 15] = 1;
  }

  set visible(on: boolean) {
    this.batch.mesh.visible = on;
  }
}
