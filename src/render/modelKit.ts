import * as THREE from 'three';
import { GeoBuilder, trs } from './instancing';
import { PAL } from './palette';

/**
 * Shared building blocks for the unit models: a transform-stack Kit over GeoBuilder, cached
 * primitives (pre-de-indexed) and the faction paint / uniform colour helpers.
 */

const PAINT_K = 0.28;
const UNIFORM_K = 0.35;
const UNIFORM_BASE = new THREE.Color('#6b6a52');
const RECON_GREEN = new THREE.Color('#5c6b45');

export const BOX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
export const ZERO = new THREE.Color(0, 0, 0);

const geoCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    if (g.index) g = g.toNonIndexed();
    geoCache.set(key, g);
  }
  return g;
}

export function cylGeo(rt: number, rb: number, seg: number, open = false, thetaLen = Math.PI * 2): THREE.BufferGeometry {
  return cached(`c${rt},${rb},${seg},${open},${thetaLen}`, () => new THREE.CylinderGeometry(rt, rb, 1, seg, 1, open, 0, thetaLen));
}

export function sphereGeo(r: number, w: number, h: number, hemi = false): THREE.BufferGeometry {
  return cached(`s${r},${w},${h},${hemi}`, () => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, hemi ? Math.PI / 2 : Math.PI));
}

/** Thin wrapper adding convenience primitives in a parent transform. */
export class Kit {
  constructor(private readonly base = new THREE.Matrix4(), readonly b = new GeoBuilder()) {}

  private at(m: THREE.Matrix4): THREE.Matrix4 {
    return this.base.clone().multiply(m);
  }

  child(m: THREE.Matrix4): Kit {
    return new Kit(this.at(m), this.b);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, tint = 0, rx = 0, ry = 0, rz = 0, swing = 0): void {
    this.b.add(BOX, this.at(trs(x, y, z, rx, ry, rz, w, h, d)), c, tint, swing);
  }

  /** Cylinder along local Y unless rotated. */
  cyl(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, c: THREE.Color, tint = 0, rx = 0, ry = 0, rz = 0): void {
    this.b.add(cylGeo(rt, rb, seg), this.at(trs(x, y, z, rx, ry, rz, 1, h, 1)), c, tint);
  }

  /** Cylinder lying along local Z (wheels, axles): `h` is its thickness. */
  wheel(r: number, h: number, seg: number, x: number, y: number, z: number, c: THREE.Color, tint = 0): void {
    this.cyl(r, r, h, seg, x, y, z, c, tint, Math.PI / 2);
  }

  /** Cylinder lying along local X (barrels, rolls, exhausts). */
  rod(r: number, len: number, seg: number, x: number, y: number, z: number, c: THREE.Color, tint = 0, rb = r): void {
    this.cyl(r, rb, len, seg, x, y, z, c, tint, 0, 0, -Math.PI / 2);
  }

  geo(g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color, tint = 0, swing = 0): void {
    this.b.add(g, this.at(m), c, tint, swing);
  }

  build(): THREE.BufferGeometry {
    return this.b.build();
  }
}

/** Painted colour helpers: return [baseColour, tint] for a faction-tinted part. */
export function paint(shade = 1): [THREE.Color, number] {
  return [PAL.olive.clone().multiplyScalar((1 - PAINT_K) * shade), PAINT_K * shade];
}

export function uniform(shade = 1, recon = false): [THREE.Color, number] {
  if (!recon) return [UNIFORM_BASE.clone().multiplyScalar((1 - UNIFORM_K) * shade), UNIFORM_K * shade];
  // factionUniform(F).lerp(green, .35) = (.65·.65·base + .35·green) + .65·.35·F
  const c = UNIFORM_BASE.clone().multiplyScalar(0.65 * 0.65).add(RECON_GREEN.clone().multiplyScalar(0.35)).multiplyScalar(shade);
  return [c, 0.65 * UNIFORM_K * shade];
}

/** Barrel along +x from the kit origin, optional muzzle brake. */
export function barrel(k: Kit, len: number, r: number, c: THREE.Color, t: number, brake = false): void {
  k.rod(r, len, 8, len / 2, 0, 0, c, t, r * 1.1);
  if (brake) {
    k.rod(r * 1.9, len * 0.07, 8, len * 0.985, 0, 0, c, t);
    k.rod(r * 1.6, len * 0.03, 8, len * 0.93, 0, 0, c, t);
  }
}

/** Spoked gun-carriage wheel lying along z: tyre, rim, hub and spokes. */
export function spokedWheel(k: Kit, r: number, x: number, y: number, z: number, tyre: THREE.Color, metal: THREE.Color, mt = 0): void {
  k.wheel(r, 0.16, 12, x, y, z, tyre);
  k.wheel(r * 0.78, 0.18, 10, x, y, z, metal, mt);
  k.wheel(r * 0.22, 0.26, 6, x, y, z, metal, mt);
  const side = Math.sign(z) || 1;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    k.box(0.07, r * 1.5, 0.05, x, y, z + side * 0.1, metal, mt, 0, 0, a);
  }
}
