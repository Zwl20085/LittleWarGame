import type { Terrain, Walk } from './terrain';
import type { V2 } from './vec';

/**
 * Closed yards (2.2 pathing round). Two houses that meet at a corner can leave a few metres of
 * open 2 m raster cells with no 4-way exit: per-tick movement only tests the point it steps to,
 * so a unit nudged diagonally across that corner (separation, a wall escape) gets in, but a route
 * never gets it out again (the soak's "infantry squad stuck inside a town" for the whole war).
 */
export const POCKET = {
  /** Raster cells (2 m) reachable from a spot below which it counts as a closed yard. */
  minCells: 80,
  /** Ring radius (raster cells) searched for open ground outside the yard. */
  searchCells: 12,
} as const;

const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

function free(t: Terrain, walk: Walk, i: number, j: number): boolean {
  const x = i * t.bcell;
  const z = j * t.bcell;
  return t.inBounds(x, z) && t.buildingH(x, z) === 0 && walk(x, z);
}

/**
 * Raster cells reachable from (i, j) with the router's moves (8-way, no corner cutting), up to
 * `cap`; the visited cells go into `seen` when given.
 */
function reach(t: Terrain, walk: Walk, i0: number, j0: number, cap: number, seen?: Set<number>): number {
  const W = 1 << 16;
  const key = (i: number, j: number): number => j * W + i;
  const mark = seen ?? new Set<number>();
  const queue: number[] = [key(i0, j0)];
  mark.add(queue[0]);
  for (let h = 0; h < queue.length && queue.length < cap; h++) {
    const i = queue[h] % W;
    const j = (queue[h] - i) / W;
    for (let n = 0; n < 8; n++) {
      const ni = i + DI[n];
      const nj = j + DJ[n];
      const k = key(ni, nj);
      if (mark.has(k) || !free(t, walk, ni, nj)) continue;
      if (n >= 4 && (!free(t, walk, ni, j) || !free(t, walk, i, nj))) continue;
      mark.add(k);
      queue.push(k);
    }
  }
  return queue.length;
}

/**
 * When `from` lies in a closed yard: the nearest open raster point outside it (with room to move
 * on), to walk to straight through the corner. Null when `from` is not boxed in or nothing is near.
 */
export function pocketExit(t: Terrain, from: V2, walk: Walk): V2 | null {
  const c = t.bcell;
  const ci = Math.round(from.x / c);
  const cj = Math.round(from.z / c);
  if (!free(t, walk, ci, cj)) return null;
  const yard = new Set<number>();
  if (reach(t, walk, ci, cj, POCKET.minCells, yard) >= POCKET.minCells) return null;
  for (let r = 1; r <= POCKET.searchCells; r++) {
    let best: V2 | null = null;
    let bd = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        const d = di * di + dj * dj;
        if (d >= bd || yard.has(j * (1 << 16) + i) || !free(t, walk, i, j)) continue;
        if (reach(t, walk, i, j, POCKET.minCells) < POCKET.minCells) continue;
        bd = d;
        best = { x: i * c, z: j * c };
      }
    }
    if (best) return best;
  }
  return null;
}
