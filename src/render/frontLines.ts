import * as THREE from 'three';
import { CONTESTED, NEUTRAL, type FrontlineField } from '../sim/frontline';

const VERT = /* glsl */ `
attribute vec2 aNrm;
attribute float aSide;
attribute vec3 aCol;
uniform float uWidth;
uniform float uTime;
varying vec3 vCol;
varying float vEdge;
varying float vInk;
void main() {
  vCol = aCol;
  vEdge = aSide;
  vec3 p = position + vec3(aNrm.x, 0.0, aNrm.y) * (aSide * uWidth);
  // Ink that is never quite even: a slow travelling density wave along the line.
  vInk = 0.86 + 0.14 * sin((position.x + position.z) * 0.045 - uTime * 1.3);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  // Small depth bias so trees and low rises do not chop the line into dashes.
  gl_Position.z -= 0.004 * gl_Position.w;
}`;

const FRAG = /* glsl */ `
uniform float uAlpha;
varying vec3 vCol;
varying float vEdge;
varying float vInk;
void main() {
  // Darkened faction colour reads as ink on the paper-toned table; the outer edge feathers.
  vec3 ink = vCol * 0.62 * vInk;
  float a = uAlpha * (1.0 - smoothstep(0.75, 1.0, vEdge));
  gl_FragColor = vec4(ink, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Marching-squares edge pairs per case (corner bits: 1=bl, 2=br, 4=tr, 8=tl; edges 0=b,1=r,2=t,3=l).
const CASES: number[][] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [2, 3], [2, 0], [0, 1, 2, 3], [2, 1], [1, 3], [1, 0], [0, 3], [],
];

/**
 * Crisp front-line ink: for every faction, the 0.5 contour of its (lightly blurred) territory is
 * traced with marching squares and kept only where it borders another faction's ground. Each
 * side draws its own colour, offset into its own territory, so a contact line reads as a
 * two-colour ink stroke. Width is in screen pixels (set per frame); rebuilt on field changes.
 */
export class FrontLines {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = { uWidth: { value: 3 }, uTime: { value: 0 }, uAlpha: { value: 0.95 } };
  private vals = new Float32Array(0);
  private active = new Uint8Array(0);

  constructor() {
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Per-frame: line width in pixels → metres, slow ink animation, softer when zoomed in. */
  update(realDt: number, ppm: number): void {
    const px = ppm < 1 ? 3.2 : ppm < 4 ? 2.6 : 2.2;
    this.uniforms.uWidth.value = px / Math.max(0.05, ppm);
    this.uniforms.uTime.value += realDt;
    this.uniforms.uAlpha.value = ppm > 4 ? 0.55 : ppm > 1.5 ? 0.8 : 0.95;
  }

  rebuild(field: FrontlineField, colors: readonly THREE.Color[], heightAt: (x: number, z: number) => number): void {
    const { nx, nz, cell, owner } = field;
    if (this.vals.length !== nx * nz) this.vals = new Float32Array(nx * nz);
    const pos: number[] = [];
    const nrm: number[] = [];
    const side: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const v = this.vals;
    if (this.active.length !== nx * nz) this.active = new Uint8Array(nx * nz);
    const act = this.active;
    let cur = 0;
    // Blurred indicator inside the contact band, exact 0/1 elsewhere.
    const val = (k: number): number => (act[k] ? v[k] : owner[k] === cur ? 1 : 0);
    const vAt = (i: number, j: number): number => val(Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i)));
    // Bilinear sample of the indicator field at world (x, z); samples sit at cell centres.
    const sample = (x: number, z: number): number => {
      const fx = x / cell - 0.5;
      const fz = z / cell - 0.5;
      const i = Math.floor(fx);
      const j = Math.floor(fz);
      const tx = fx - i;
      const tz = fz - j;
      return (vAt(i, j) * (1 - tx) + vAt(i + 1, j) * tx) * (1 - tz) + (vAt(i, j + 1) * (1 - tx) + vAt(i + 1, j + 1) * tx) * tz;
    };
    const ownerAt = (x: number, z: number): number => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(x / cell)));
      const j = Math.min(nz - 1, Math.max(0, Math.floor(z / cell)));
      return owner[j * nx + i];
    };
    const ex = [0, 0];
    const ez = [0, 0];
    // Only cells within 2 of a contact between two owners need the blur (borders with neutral
    // ground are never drawn); elsewhere the indicator is exactly 0/1.
    act.fill(0);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const o = owner[k];
        if (o === NEUTRAL) continue;
        const or = i + 1 < nx ? owner[k + 1] : o;
        const od = j + 1 < nz ? owner[k + nx] : o;
        if ((or !== o && or !== NEUTRAL) || (od !== o && od !== NEUTRAL)) {
          for (let jj = Math.max(0, j - 2); jj <= Math.min(nz - 1, j + 3); jj++) {
            for (let ii = Math.max(0, i - 2); ii <= Math.min(nx - 1, i + 3); ii++) act[jj * nx + ii] = 1;
          }
        }
      }
    }
    const list: number[] = [];
    for (let k = 0; k < nx * nz; k++) if (act[k]) list.push(k);
    for (let f = 0; f < colors.length; f++) {
      cur = f;
      let any = false;
      for (let k = 0; k < nx * nz; k++) if (owner[k] === f) { any = true; break; }
      if (!any) continue;
      // Indicator blurred 3×3 so the traced contour is diagonal-smooth, not 10 m stairs.
      for (const k of list) {
        {
          const i = k % nx;
          const j = (k - i) / nx;
          let s = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = Math.min(nx - 1, Math.max(0, i + di));
              const jj = Math.min(nz - 1, Math.max(0, j + dj));
              s += owner[jj * nx + ii] === f ? (di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1) : 0;
            }
          }
          v[j * nx + i] = s / 16;
        }
      }
      const c = colors[f];
      for (const k of list) {
        const i = k % nx;
        const j = (k - i) / nx;
        if (i >= nx - 1 || j >= nz - 1) continue;
        {
          const a = val(k);
          const b = val(k + 1);
          const cc = val(k + nx + 1);
          const d = val(k + nx);
          const code = (a > 0.5 ? 1 : 0) | (b > 0.5 ? 2 : 0) | (cc > 0.5 ? 4 : 0) | (d > 0.5 ? 8 : 0);
          const segs = CASES[code];
          if (segs.length === 0) continue;
          const x0 = (i + 0.5) * cell;
          const z0 = (j + 0.5) * cell;
          for (let s = 0; s < segs.length; s += 2) {
            for (let e = 0; e < 2; e++) {
              const edge = segs[s + e];
              // Interpolated crossing on the edge.
              if (edge === 0) { ex[e] = x0 + cell * lerpT(a, b); ez[e] = z0; }
              else if (edge === 1) { ex[e] = x0 + cell; ez[e] = z0 + cell * lerpT(b, cc); }
              else if (edge === 2) { ex[e] = x0 + cell * lerpT(d, cc); ez[e] = z0 + cell; }
              else { ex[e] = x0; ez[e] = z0 + cell * lerpT(a, d); }
            }
            const dx = ex[1] - ex[0];
            const dz = ez[1] - ez[0];
            const len = Math.hypot(dx, dz);
            if (len < 1e-3) continue;
            let px = -dz / len;
            let pz = dx / len;
            const mx = (ex[0] + ex[1]) / 2;
            const mz = (ez[0] + ez[1]) / 2;
            if (sample(mx + px * 3, mz + pz * 3) < sample(mx - px * 3, mz - pz * 3)) { px = -px; pz = -pz; }
            // Only where the far side belongs to another faction (or is being fought over).
            const o = ownerAt(mx - px * cell, mz - pz * cell);
            if (o === f || o === NEUTRAL) continue;
            if (o !== CONTESTED && o < 0) continue;
            const base = pos.length / 3;
            for (let e = 0; e < 2; e++) {
              const y = heightAt(ex[e], ez[e]) + 1.2;
              for (let sd = 0; sd < 2; sd++) {
                pos.push(ex[e], y, ez[e]);
                nrm.push(px, pz);
                side.push(sd);
                col.push(c.r, c.g, c.b);
              }
            }
            idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aNrm', new THREE.Float32BufferAttribute(nrm, 2));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  clear(): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.BufferGeometry();
  }
}

function lerpT(a: number, b: number): number {
  const d = b - a;
  return Math.abs(d) < 1e-6 ? 0.5 : Math.min(1, Math.max(0, (0.5 - a) / d));
}
