import * as THREE from 'three';
import type { Fort } from '../sim/types';
import type { Terrain } from '../sim/terrain';
import { GeoBuilder, trs } from './instancing';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const COL = {
  hull: new THREE.Color('#5d6650'),
  hullDark: new THREE.Color('#383d31'),
  plank: new THREE.Color('#9a8566'),
  plankDark: new THREE.Color('#7c6a50'),
  rail: new THREE.Color('#5e5040'),
  ramp: new THREE.Color('#8a7a5e'),
};

/** Pontoon spacing along the span (m) and deck width. */
const PITCH = 4.4;
const DECK_W = 5.2;
const MATERIAL = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.03 });

function box(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, rz = 0): void {
  b.add(BOX, trs(x, y, z, 0, 0, rz, w, h, d), c);
}

/**
 * Engineer pontoon bridge: a row of boats moored across the current with a plank deck and
 * rope rails, laid out progressively from the start bank as `progress` grows. Geometry is
 * merged into one mesh and rebuilt only when another pontoon is floated into place.
 */
export class PontoonView {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private builtSegs = -1;
  private readonly segs: number;
  private readonly len: number;
  /** Work-site position (tip of the deck) for construction dust; null when finished. */
  readonly tip = new THREE.Vector3();
  building = true;

  constructor(private readonly fort: Fort, private readonly terrain: Terrain) {
    const s = fort.start ?? fort.pos;
    const e = fort.end ?? fort.pos;
    this.len = Math.max(4, fort.length ?? Math.hypot(e.x - s.x, e.z - s.z));
    this.segs = Math.max(1, Math.ceil(this.len / PITCH));
    this.group.position.set(s.x, 0, s.z);
    this.group.rotation.y = -Math.atan2(e.z - s.z, e.x - s.x);
  }

  /** Water surface at a point along the span (NaN on dry bank). */
  private surfaceAt(d: number): number {
    const t = this.terrain;
    const s = this.fort.start ?? this.fort.pos;
    const e = this.fort.end ?? this.fort.pos;
    const f = d / this.len;
    const i = Math.min(t.nx - 1, Math.max(0, Math.round((s.x + (e.x - s.x) * f) / t.cell)));
    const j = Math.min(t.nz - 1, Math.max(0, Math.round((s.z + (e.z - s.z) * f) / t.cell)));
    return t.waterSurface[j * t.nx + i];
  }

  /** Water surface (or bank + clearance) at a point along the span. */
  private deckY(d: number): number {
    const t = this.terrain;
    const s = this.fort.start ?? this.fort.pos;
    const e = this.fort.end ?? this.fort.pos;
    const f = d / this.len;
    const x = s.x + (e.x - s.x) * f;
    const z = s.z + (e.z - s.z) * f;
    const i = Math.min(t.nx - 1, Math.max(0, Math.round(x / t.cell)));
    const j = Math.min(t.nz - 1, Math.max(0, Math.round(z / t.cell)));
    const surf = t.waterSurface[j * t.nx + i];
    const ground = t.heightAt(x, z);
    return Number.isNaN(surf) ? ground + 0.35 : Math.max(surf + 0.55, ground + 0.3);
  }

  update(progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    const n = p >= 1 ? this.segs : Math.floor(p * this.segs + 0.35);
    this.building = p < 1;
    if (n === this.builtSegs) return;
    this.builtSegs = n;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    const b = new GeoBuilder();
    const built = Math.min(this.len, n * PITCH);
    // Shore ramp at the start bank (always: it is laid first).
    const y0 = this.deckY(0);
    box(b, 3.2, 0.25, DECK_W + 0.4, -1.2, y0 - 0.15, 0, COL.ramp, -0.08);
    let prevY = y0;
    for (let k = 0; k < n; k++) {
      const d = Math.min(this.len, (k + 0.5) * PITCH);
      const y = this.deckY(d);
      if (!Number.isNaN(this.surfaceAt(d))) {
        // Boat: hull across the bridge axis, darker gunwale, raked bow and stern.
        box(b, 2.3, 0.9, DECK_W + 2.2, d, y - 0.75, 0, COL.hull);
        box(b, 2.5, 0.18, DECK_W + 2.4, d, y - 0.28, 0, COL.hullDark);
        for (const side of [-1, 1]) box(b, 1.6, 0.6, 0.8, d, y - 0.8, side * (DECK_W / 2 + 1.4), COL.hull, 0);
      } else {
        // On the bank: timber trestle posts instead of a boat.
        for (const side of [-1, 1]) box(b, 0.35, 1.2, 0.35, d, y - 0.7, side * (DECK_W / 2 - 0.4), COL.rail);
      }
      // Deck balks and planks to the next boat.
      const segL = Math.min(PITCH, built - k * PITCH);
      const mid = k * PITCH + segL / 2;
      const ym = (prevY + y) / 2;
      box(b, segL + 0.05, 0.16, DECK_W, mid, ym, 0, k % 2 ? COL.plank : COL.plankDark);
      for (const side of [-1, 1]) {
        box(b, segL, 0.22, 0.25, mid, ym + 0.08, side * (DECK_W / 2 - 0.15), COL.rail);
        box(b, 0.14, 1.0, 0.14, d, y + 0.5, side * (DECK_W / 2 - 0.1), COL.rail);
        box(b, segL, 0.07, 0.07, mid, ym + 0.95, side * (DECK_W / 2 - 0.1), COL.rail);
      }
      prevY = y;
    }
    if (p >= 1) {
      const y1 = this.deckY(this.len);
      box(b, 3.2, 0.25, DECK_W + 0.4, this.len + 1.2, y1 - 0.15, 0, COL.ramp, 0.08);
    }
    this.mesh = new THREE.Mesh(b.build(), MATERIAL);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
    this.group.updateMatrixWorld(true);
    this.tip.set(built, prevY, 0).applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.group.removeFromParent();
  }
}
