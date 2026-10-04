import type { Building, Terrain } from '../sim/terrain';

/**
 * Render-side reconstruction of the street grids the sim laid its towns out on
 * (`Terrain.layoutSettlement`): towns, cities and capitals put terraced houses around square
 * blocks separated by 12 m streets, on a grid rotated by a per-town angle. The sim does not keep
 * the grid, so it is recovered from the buildings: the angle from their rotations (two
 * candidates, checked against where the houses actually stand), the lattice from the layout
 * constants. Villages are organic clusters and get no grid.
 */

export interface TownGrid {
  readonly x: number;
  readonly z: number;
  /** Grid rotation: grid +u axis = (cos ang, sin ang), +v = (−sin ang, cos ang). */
  readonly ang: number;
  /** Block centres at −half + k·cell along u and v. */
  readonly half: number;
  readonly cell: number;
  readonly block: number;
  readonly street: number;
  /** Radius the streets are clipped to (m). */
  readonly reach: number;
  readonly kind: 'town' | 'city' | 'capital';
  /** Street centre lines, world space: [x0, z0, x1, z1] per segment. */
  readonly streets: Float32Array;
  /** Town square at a central crossing (world x, z, radius m), or null when none is free. */
  readonly square: { x: number; z: number; r: number } | null;
  /** Buildings within the town radius. */
  readonly buildings: readonly Building[];
}

const STREET = 12;
const HALF_PI = Math.PI / 2;
/** Square radius (m): the crossing plus a ring of paving. */
const SQUARE_R = 13;

/** Distance (m) from (x, z) to a building's drawn footprint (0 inside). */
function footprintDist(b: Building, x: number, z: number): number {
  const dx = x - b.x;
  const dz = z - b.z;
  const cs = Math.cos(b.rot);
  const sn = Math.sin(b.rot);
  const lx = Math.abs(dx * cs - dz * sn) - b.w / 2;
  const lz = Math.abs(dx * sn + dz * cs) - b.d / 2;
  return Math.hypot(Math.max(0, lx), Math.max(0, lz));
}

function lattice(v: number, base: number, cell: number): number {
  const f = ((((v - base) % cell) + cell) % cell);
  return Math.min(f, cell - f);
}

/** How many buildings sit on the terrace lines (± inset from a block centre) of this grid. */
function gridScore(bs: readonly Building[], x: number, z: number, ang: number, half: number, cell: number, block: number): number {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const inset = block / 2 - 5;
  let n = 0;
  for (const b of bs) {
    const dx = b.x - x;
    const dz = b.z - z;
    const u = dx * ca + dz * sa;
    const v = -dx * sa + dz * ca;
    const d = Math.min(lattice(u, -half + inset, cell), lattice(u, -half - inset, cell), lattice(v, -half + inset, cell), lattice(v, -half - inset, cell));
    if (d < 0.6) n++;
  }
  return n;
}

function recoverAngle(bs: readonly Building[], x: number, z: number, half: number, cell: number, block: number): number {
  let c = 0;
  let s = 0;
  for (const b of bs) {
    c += Math.cos(b.rot * 4);
    s += Math.sin(b.rot * 4);
  }
  const a = ((Math.atan2(s, c) / 4) % HALF_PI + HALF_PI) % HALF_PI;
  // rot = ±(ang + k·π/2) depending on the layout's rotation convention: test both.
  const b = HALF_PI - a;
  return gridScore(bs, x, z, a, half, cell, block) >= gridScore(bs, x, z, b, half, cell, block) ? a : b;
}

export function townGrids(t: Terrain): TownGrid[] {
  const out: TownGrid[] = [];
  for (const town of t.def.towns) {
    const kind = town.kind ?? (town.buildings > 40 ? 'town' : 'village');
    if (kind === 'village') continue;
    const bs = t.buildings.filter((b) => Math.hypot(b.x - town.x, b.z - town.z) < town.r + 12);
    const terraced = bs.filter((b) => b.kind === 'house' || b.kind === 'block' || b.kind === 'factory');
    if (terraced.length < 6) continue;
    const block = kind === 'town' ? 46 : 52;
    const cell = block + STREET;
    const half = town.r;
    const ang = recoverAngle(terraced, town.x, town.z, half, cell, block);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const reach = half * 0.97;
    const segs: number[] = [];
    const lines: number[] = [];
    for (let u = -half - cell / 2; u <= half + cell / 2; u += cell) if (Math.abs(u) < reach - 8) lines.push(u);
    for (const u of lines) {
      const l = Math.sqrt(reach * reach - u * u);
      // Along v at fixed u, and along u at fixed v (the grid is square).
      segs.push(town.x + u * ca + l * sa, town.z + u * sa - l * ca, town.x + u * ca - l * sa, town.z + u * sa + l * ca);
      segs.push(town.x - u * sa - l * ca, town.z + u * ca - l * sa, town.x - u * sa + l * ca, town.z + u * ca + l * sa);
    }
    // The square: a central crossing, as wide as the houses around it allow (8.5–13 m).
    let square: TownGrid['square'] = null;
    let best = -Infinity;
    for (const u of lines) {
      for (const v of lines) {
        const d = Math.hypot(u, v);
        const px = town.x + u * ca - v * sa;
        const pz = town.z + u * sa + v * ca;
        let r = SQUARE_R;
        for (const b of bs) r = Math.min(r, footprintDist(b, px, pz) - 0.8);
        if (r < 7.5 || d > half * 0.75) continue;
        const score = r * 4 - d * 0.15;
        if (score <= best) continue;
        best = score;
        square = { x: px, z: pz, r };
      }
    }
    out.push({ x: town.x, z: town.z, ang, half, cell, block, street: STREET, reach, kind: kind as TownGrid['kind'], streets: new Float32Array(segs), square, buildings: bs });
  }
  return out;
}

/** Distance from (x, z) to segment k (4 floats) of `segs`. */
export function segDist(segs: Float32Array | readonly number[], k: number, x: number, z: number): number {
  const ax = segs[k];
  const az = segs[k + 1];
  const dx = segs[k + 2] - ax;
  const dz = segs[k + 3] - az;
  const l2 = dx * dx + dz * dz;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - (ax + dx * u), z - (az + dz * u));
}

/** Far value of the town-square distance (m). */
export const SQUARE_FAR = 40;

/**
 * Per grid-node town attributes for the terrain shader, 5 floats per node:
 * [u', v', cell, inside, square] where (u', v') are grid coordinates shifted so street centre
 * lines fall on multiples of `cell` (affine in x, z, so the GPU interpolates them exactly and
 * the fragment shader computes crisp street distances), `cell` = 0 outside towns, `inside` =
 * reach − distance from the town centre (m, negative beyond the streets' end), `square` =
 * distance to the town-square centre minus its radius plus 13 m (SQUARE_FAR when far).
 */
export function townField(t: Terrain, grids: readonly TownGrid[]): Float32Array {
  const nx = t.nx;
  const nz = t.nz;
  const out = new Float32Array(nx * nz * 5);
  for (let k = 0; k < nx * nz; k++) out[k * 5 + 4] = SQUARE_FAR;
  for (const g of grids) {
    const r = g.reach + 24;
    const ca = Math.cos(g.ang);
    const sa = Math.sin(g.ang);
    const off = g.half + g.cell / 2;
    const i0 = Math.max(0, Math.floor((g.x - r) / t.cell));
    const i1 = Math.min(nx - 1, Math.ceil((g.x + r) / t.cell));
    const j0 = Math.max(0, Math.floor((g.z - r) / t.cell));
    const j1 = Math.min(nz - 1, Math.ceil((g.z + r) / t.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i * t.cell - g.x;
        const dz = j * t.cell - g.z;
        const k = (j * nx + i) * 5;
        const u = dx * ca + dz * sa;
        const v = -dx * sa + dz * ca;
        out[k] = u + off;
        out[k + 1] = v + off;
        out[k + 2] = g.cell;
        out[k + 3] = g.reach - Math.hypot(dx, dz);
        // Stored relative to a 13 m square so the shader's fixed ring radius fits any size.
        if (g.square) out[k + 4] = Math.min(out[k + 4], Math.hypot(i * t.cell - g.square.x, j * t.cell - g.square.z) - g.square.r + SQUARE_R);
      }
    }
  }
  return out;
}
