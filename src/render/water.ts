import * as THREE from 'three';
import { Ground, type Terrain } from '../sim/terrain';
import { PAL } from './palette';

const VERT = /* glsl */ `
attribute float aDepth;
attribute float aFord;
attribute vec2 aFlow;
varying vec3 vW;
varying float vDepth;
varying float vFord;
varying vec2 vFlow;
void main() {
  vDepth = aDepth; vFord = aFord; vFlow = aFlow;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uView;
uniform float uMap;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFordCol;
varying vec3 vW;
varying float vDepth;
varying float vFord;
varying vec2 vFlow;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}
float waves(vec2 p) {
  vec2 fl = vFlow * uTime;
  return vn(p * 0.09 - fl * 0.1) * 0.6 + vn(p * 0.23 + vec2(uTime * 0.11, -uTime * 0.09) - fl * 0.22) * 0.4;
}
void main() {
  float d = vDepth;
  vec3 col = mix(uShallow, uDeep, smoothstep(0.3, 3.5, d));
  col = mix(col, uFordCol, clamp(vFord, 0.0, 1.0) * 0.75);
  vec2 p = vW.xz;
  // Fade ripples out when a pixel covers several metres (no moiré / striping at overview zoom).
  float px = length(fwidth(p));
  float detail = 1.0 - smoothstep(0.9, 3.2, px);
  float e = 1.5;
  float w0 = waves(p);
  vec3 N = normalize(vec3((w0 - waves(p + vec2(e, 0.0))) * 0.18 * detail, 1.0, (w0 - waves(p + vec2(0.0, e))) * 0.18 * detail));
  float dif = 0.8 + 0.2 * max(dot(N, uSun), 0.0); // calm, matte diorama water (no marbling)
  vec3 H = normalize(uSun + uView);
  float spec = pow(max(dot(N, H), 0.0), 120.0) * 0.3 * detail;
  // Bank foam: a soft broken line where the water meets the shore.
  float foamN = mix(0.7, 0.45 + 0.55 * vn(p * 0.7 + vFlow * uTime * 0.8), detail);
  float foam = smoothstep(0.02, 0.18, d) * (1.0 - smoothstep(0.2, 0.75, d)) * foamN;
  col = col * dif + vec3(spec) + vec3(0.86, 0.86, 0.8) * foam * 0.5;
  float a = 0.92 * smoothstep(0.0, 0.35, d);
  if (uMap > 0.5) {
    float hatch = smoothstep(0.35, 0.0, abs(fract((vW.x - vW.z) / 5.0) - 0.5) - 0.25);
    vec3 deepMap = mix(vec3(0.05, 0.22, 0.55), vec3(0.02, 0.10, 0.35), hatch);
    vec3 fordMap = vec3(0.45, 0.72, 0.85) * (0.85 + 0.15 * step(0.5, fract(vW.x / 3.0) + fract(vW.z / 3.0) - 0.5));
    col = mix(deepMap, fordMap, clamp(vFord, 0.0, 1.0));
    a = 0.92 * smoothstep(0.0, 0.2, d);
  }
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Average each wet cell's surface with its wet neighbours (radius 2); NaN stays dry. */
function smoothSurface(src: Float32Array, nx: number, nz: number): Float32Array {
  const out = new Float32Array(src.length).fill(NaN);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (Number.isNaN(src[k])) continue;
      let sum = 0;
      let n = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const v = src[jj * nx + ii];
          if (!Number.isNaN(v)) { sum += v; n++; }
        }
      }
      out[k] = sum / n;
    }
  }
  return out;
}

/** Animated river surface built from `terrain.waterSurface`. Fords are lighter and shallower. */
export class WaterView {
  readonly mesh: THREE.Mesh | null;
  readonly uniforms = {
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(-0.5, 0.8, -0.35).normalize() },
    uView: { value: new THREE.Vector3(0, 1, 0) },
    uMap: { value: 0 },
    uDeep: { value: PAL.water.deep },
    uShallow: { value: PAL.water.shallow },
    uFordCol: { value: PAL.water.ford },
  };

  constructor(private readonly terrain: Terrain, private readonly ground: Float32Array = terrain.visualHeights) {
    this.mesh = this.build();
  }

  private build(): THREE.Mesh | null {
    const t = this.terrain;
    const nx = t.nx;
    const nz = t.nz;
    // Ease the per-cell surface so steps between river segments become gentle ramps.
    const S = smoothSurface(t.waterSurface, nx, nz);
    const has = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < nz && !Number.isNaN(S[j * nx + i]);
    const vIndex = new Int32Array(nx * nz).fill(-1);
    const pos: number[] = [];
    const depth: number[] = [];
    const ford: number[] = [];
    const flow: number[] = [];
    const idx: number[] = [];
    // Dry vertices next to the river take the neighbouring surface so the sheet runs under the
    // bank and the terrain depth-clips a smooth shoreline (no 4 m staircase).
    const surfAt = (i: number, j: number): number => {
      if (has(i, j)) return S[j * nx + i];
      let s = 0;
      let n = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (has(i + di, j + dj)) { s += S[(j + dj) * nx + i + di]; n++; }
      return n ? s / n : NaN;
    };
    const vert = (i: number, j: number): number => {
      const k = j * nx + i;
      if (vIndex[k] >= 0) return vIndex[k];
      const y = surfAt(i, j);
      const x = i * t.cell;
      const z = j * t.cell;
      vIndex[k] = pos.length / 3;
      pos.push(x, y, z);
      // Dry vertices (outside the sim river) never show water, even where the bank dips below the
      // neighbouring surface; their true (negative) depth keeps the shore contour smooth.
      depth.push(has(i, j) ? y - this.ground[k] : Math.min(y - this.ground[k], -0.4));
      ford.push(t.ground[k] === Ground.Ford ? 1 : 0);
      // Flow follows the surface downhill (fallback: gentle drift).
      const gx = (surfAt(i + 2, j) - surfAt(i - 2, j)) || 0;
      const gz = (surfAt(i, j + 2) - surfAt(i, j - 2)) || 0;
      const gl = Math.hypot(gx, gz);
      flow.push(gl > 1e-3 ? (-gx / gl) * 1.2 : 0.4, gl > 1e-3 ? (-gz / gl) * 1.2 : 0.3);
      return vIndex[k];
    };
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (!has(i, j) && !has(i + 1, j) && !has(i, j + 1) && !has(i + 1, j + 1)) continue;
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    if (idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
    g.setAttribute('aFord', new THREE.Float32BufferAttribute(ford, 1));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1;
    return mesh;
  }

  update(dt: number, camera: THREE.Camera, sunDir: THREE.Vector3, mapMode: boolean): void {
    this.uniforms.uTime.value += dt;
    camera.getWorldDirection(this.uniforms.uView.value).negate();
    this.uniforms.uSun.value.copy(sunDir);
    this.uniforms.uMap.value = mapMode ? 1 : 0;
  }
}
