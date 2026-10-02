import { Ground, type Terrain } from '../sim/terrain';

/** Grid cells either side of the waterline that get eased. */
const BAND = 3;
const PASSES = 3;

/**
 * Render-only copy of `terrain.visualHeights` with river banks eased: the sim carves channels per
 * 4 m cell, which reads as a staircase of little cliffs where the water meets the shore. A few
 * box-blur passes restricted to a narrow band around the water turn those into smooth banks, so
 * the water sheet's depth-clipped edge follows a natural curve. Sim heights are untouched.
 */
export function smoothBankHeights(t: Terrain): Float32Array {
  const nx = t.nx;
  const nz = t.nz;
  const src = t.visualHeights;
  const wet = (k: number): boolean => !Number.isNaN(t.waterSurface[k]) || t.ground[k] === Ground.Water || t.ground[k] === Ground.Ford;
  // Distance (in cells, Chebyshev) to the nearest wet/dry boundary, capped at BAND + 1.
  const near = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const w = wet(k);
      const r = i + 1 < nx ? k + 1 : k;
      const d = j + 1 < nz ? k + nx : k;
      if (w !== wet(r) || w !== wet(d)) {
        for (let dj = -BAND; dj <= BAND; dj++) {
          for (let di = -BAND; di <= BAND; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii >= 0 && jj >= 0 && ii < nx && jj < nz) near[jj * nx + ii] = 1;
          }
        }
      }
    }
  }
  let a = src.slice();
  let b = src.slice();
  for (let pass = 0; pass < PASSES; pass++) {
    for (let j = 1; j < nz - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        if (!near[k]) continue;
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += a[k + dj * nx + di];
        b[k] = s / 9;
      }
    }
    const tmp = a;
    a = b;
    b = tmp;
    b.set(a);
  }
  return a;
}
