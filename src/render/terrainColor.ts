import * as THREE from 'three';
import { ValueNoise } from '../sim/noise';
import { Ground, type Terrain } from '../sim/terrain';
import { PAL } from './palette';

/** Per grid-node terrain attributes (4 m grid, row-major by z). */
export interface TerrainAttribs {
  readonly color: Float32Array;
  readonly normal: Float32Array;
  /** 0..1 farmland weight (field patchwork drawn in the fragment shader). */
  readonly farm: Float32Array;
  /** Low-frequency field-orientation angle (radians). */
  readonly fieldAngle: Float32Array;
}

const HYPSO = [
  { t: 0, c: new THREE.Color('#8f9d5e') },
  { t: 0.22, c: new THREE.Color('#9ea566') },
  { t: 0.45, c: new THREE.Color('#ada673') },
  { t: 0.65, c: new THREE.Color('#ab9d7b') },
  { t: 0.85, c: new THREE.Color('#9d9282') },
  { t: 1, c: new THREE.Color('#a39d93') },
];

function hypso(t: number, out: THREE.Color): THREE.Color {
  for (let k = 1; k < HYPSO.length; k++) {
    if (t <= HYPSO[k].t) {
      const a = HYPSO[k - 1];
      const b = HYPSO[k];
      return out.copy(a.c).lerp(b.c, (t - a.t) / (b.t - a.t));
    }
  }
  return out.copy(HYPSO[HYPSO.length - 1].c);
}

/**
 * Diorama ground colouring: hypsometric tint, rock on steep slopes, valley darkening
 * (curvature AO), ground types with soft borders, wet banks, gravel fords, river beds.
 */
export function computeTerrainAttribs(t: Terrain, surface: Float32Array = t.heights): TerrainAttribs {
  const nx = t.nx;
  const nz = t.nz;
  const G = t.ground;
  const cell = t.cell;
  const n = nx * nz;
  const color = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const farm = new Float32Array(n);
  const fieldAngle = new Float32Array(n);
  const noise = new ValueNoise(t.def.seed + 11);
  const sAt = (i: number, j: number): number => surface[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const gAt = (i: number, j: number): number => G[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const relMax = Math.max(45, t.maxHeight);
  const c = new THREE.Color();
  const tmp = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = i * cell;
      const z = j * cell;
      const h = surface[k];
      const dx = (sAt(i + 1, j) - sAt(i - 1, j)) / (2 * cell);
      const dz = (sAt(i, j + 1) - sAt(i, j - 1)) / (2 * cell);
      const inv = 1 / Math.hypot(dx, 1, dz);
      normal[k * 3] = -dx * inv;
      normal[k * 3 + 1] = inv;
      normal[k * 3 + 2] = -dz * inv;
      const slope = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
      // Curvature: positive on ridges, negative in valleys.
      const c1 = h - (sAt(i - 3, j) + sAt(i + 3, j) + sAt(i, j - 3) + sAt(i, j + 3)) / 4;
      const c2 = h - (sAt(i - 9, j) + sAt(i + 9, j) + sAt(i, j - 9) + sAt(i, j + 9)) / 4;
      const ao = Math.min(1.1, Math.max(0.7, 1 + c1 * 0.018 + c2 * 0.007));
      const rel = Math.min(1, h / relMax);
      const nf = noise.fbm(x / 45, z / 45, 3);
      hypso(Math.min(1, rel + (nf - 0.5) * 0.08), c);
      // Meadow variation at low altitude.
      c.lerp(PAL.grassB, Math.max(0, nf - 0.45) * 0.5 * (1 - rel));
      // Rock: steep faces and high crests.
      const strata = 0.9 + 0.2 * noise.sample(x / 9 + h * 0.15, z / 9);
      const rockW = Math.min(0.88, Math.max(0, (slope - 14) / 16) + Math.max(0, rel - 0.78) * 1.2);
      if (rockW > 0) c.lerp(tmp.copy(PAL.rock).multiplyScalar(strata), rockW);
      // Ground types over a 3×3 neighbourhood so borders are soft.
      let wF = 0, wT = 0, wM = 0, wR = 0, wW = 0, wFd = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const gg = gAt(i + di, j + dj);
          if (gg === Ground.Forest) wF++;
          else if (gg === Ground.Town) wT++;
          else if (gg === Ground.Mud) wM++;
          else if (gg === Ground.Road) wR++;
          else if (gg === Ground.Water) wW++;
          else if (gg === Ground.Ford) wFd++;
        }
      }
      c.lerp(PAL.forestFloor, (wF / 9) * 0.8);
      c.lerp(PAL.town, (wT / 9) * 0.75);
      c.lerp(PAL.mud, (wM / 9) * 0.8);
      if (!Number.isNaN(t.waterSurface[k])) c.lerp(PAL.bank, 0.55);
      c.lerp(PAL.riverBed, (wW / 9) * 0.9);
      c.lerp(PAL.gravel, (wFd / 9) * 0.9);
      // Worn verge tint only; the carriageway itself is drawn crisply in the terrain shader.
      if (wR > 0) c.lerp(tmp.copy(PAL.roadEdge).lerp(PAL.road, 0.3 + nf * 0.3), Math.min(1, (wR / 9) * 0.45));
      const v = (0.94 + 0.1 * noise.sample(x / 260, z / 260)) * ao;
      c.multiplyScalar(v);
      color[k * 3] = c.r;
      color[k * 3 + 1] = c.g;
      color[k * 3 + 2] = c.b;
      // Farmland: flat open lowland inside broad agricultural zones.
      const zone = noise.fbm(x / 520 + 31, z / 520 - 7, 2);
      const open = G[k] === Ground.Open && wF === 0 && wW === 0 && wFd === 0 && wR < 2 && wT < 3 ? 1 : 0;
      farm[k] = open * Math.min(1, Math.max(0, (zone - 0.36) * 5)) * Math.min(1, Math.max(0, (8 - slope) / 4)) * Math.min(1, Math.max(0, (0.62 - rel) * 6));
      fieldAngle[k] = (noise.fbm(x / 900 - 50, z / 900 + 80, 2) - 0.5) * 2.4;
    }
  }
  // Soften the farmland mask so field edges fade out instead of following the 4 m grid stairs.
  const soft = blur3(blur3(farm, nx, nz), nx, nz);
  return { color, normal, farm: soft, fieldAngle };
}

/** One 3×3 box-blur pass over a grid (edges clamp). */
function blur3(src: Float32Array, nx: number, nz: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = Math.min(nz - 1, Math.max(0, j + dj));
        for (let di = -1; di <= 1; di++) s += src[jj * nx + Math.min(nx - 1, Math.max(0, i + di))];
      }
      out[j * nx + i] = s / 9;
    }
  }
  return out;
}
