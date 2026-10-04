import { CONTESTED, NEUTRAL, type FrontlineField } from './frontline';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Per-faction view of the battle front, rebuilt every 2 s from the ground-control field:
 * - `cells`: centres of own cells that touch hostile or contested ground (the front line);
 * - `enemyDist`: metres from every cell to the nearest hostile-held cell (chamfer transform),
 *   used to keep artillery and convoys safely inside friendly territory.
 */
export interface FrontInfo {
  readonly cells: V2[];
  /** Metres to the nearest hostile-held cell, on a grid `ED_COARSE`× coarser than the field (2.0 perf). */
  readonly enemyDist: Float32Array;
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
}

/**
 * The distance transform runs on a grid this many times coarser than the 16 m field: its
 * consumers compare against 120–400 m thresholds, and the chamfer + two full-grid passes were
 * 4.6 % of sim CPU at 16 m (2.0 profile). The front cells themselves stay at field resolution.
 */
const ED_COARSE = 2;

export function buildFrontInfo(world: World, field: FrontlineField): FrontInfo[] {
  return world.factions.map((f) => buildFrontInfoFor(world, field, f.id));
}

/** One faction's front info (the per-faction work is staggered over ticks to avoid a burst). */
export function buildFrontInfoFor(world: World, field: FrontlineField, factionId: number): FrontInfo {
  const { nx, nz, cell, owner } = field;
  const nf = world.factions.length;
  const f = world.factions[factionId];
  {
    const cells: V2[] = [];
    const cnx = Math.ceil(nx / ED_COARSE);
    const cnz = Math.ceil(nz / ED_COARSE);
    const ed = new Float32Array(cnx * cnz);
    const BIG = 1e6;
    // Per-owner lookup tables instead of isHostile()/isFoe() per cell (owner codes are -2..nf-1).
    const hostileTo = new Uint8Array(nf);
    const foe = new Uint8Array(nf + 2);
    for (let o = 0; o < nf; o++) {
      hostileTo[o] = o !== f.id && world.isHostile(f.id, o) ? 1 : 0;
      foe[o + 2] = isFoe(world, f.id, o) ? 1 : 0;
    }
    foe[CONTESTED + 2] = isFoe(world, f.id, CONTESTED) ? 1 : 0;
    foe[NEUTRAL + 2] = isFoe(world, f.id, NEUTRAL) ? 1 : 0;
    // One pass over the field: a coarse cell is hostile ground when any of its fine cells is, and
    // an own cell touching foe / contested ground is a front cell.
    ed.fill(BIG);
    const me = f.alive ? f.id : -3;
    for (let j = 0; j < nz; j++) {
      const crow = Math.floor(j / ED_COARSE) * cnx;
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        const o = owner[k];
        if (o === me) {
          const touch = (i > 0 && foe[owner[k - 1] + 2] === 1) || (i < nx - 1 && foe[owner[k + 1] + 2] === 1)
            || (j > 0 && foe[owner[k - nx] + 2] === 1) || (j < nz - 1 && foe[owner[k + nx] + 2] === 1);
          if (touch) cells.push({ x: (i + 0.5) * cell, z: (j + 0.5) * cell });
        } else if (o >= 0 && hostileTo[o] === 1) ed[crow + Math.floor(i / ED_COARSE)] = 0;
      }
    }
    // Two-pass chamfer distance (3-4 weights) in coarse cell units, then metres.
    chamfer(ed, cnx, cnz);
    const cc = cell * ED_COARSE;
    for (let k = 0; k < ed.length; k++) ed[k] = Math.min(BIG, ed[k] * cc);
    return { cells, enemyDist: ed, nx: cnx, nz: cnz, cell: cc };
  }
}

/**
 * In-place two-pass chamfer transform (weights 1 / 1.4142). Same candidates and Float32 stores
 * per cell as the straightforward version; borders are peeled off so the interior loop is
 * branch-free (this runs over every cell for every faction every 2 s).
 */
function chamfer(ed: Float32Array, nx: number, nz: number): void {
  const a = 1;
  const b = 1.4142;
  for (let j = 0; j < nz; j++) {
    const row = j * nx;
    if (j === 0) {
      for (let i = 1; i < nx; i++) ed[i] = Math.min(ed[i], ed[i - 1] + a);
      continue;
    }
    // i = 0: no left / up-left neighbour.
    let v = Math.min(ed[row], ed[row - nx] + a);
    if (nx > 1) v = Math.min(v, ed[row - nx + 1] + b);
    ed[row] = v;
    for (let k = row + 1, last = row + nx - 1; k < last; k++) {
      let w = Math.min(ed[k], ed[k - 1] + a);
      w = Math.min(w, ed[k - nx] + a);
      w = Math.min(w, ed[k - nx - 1] + b);
      ed[k] = Math.min(w, ed[k - nx + 1] + b);
    }
    if (nx > 1) {
      // i = nx-1: no up-right neighbour.
      const k = row + nx - 1;
      let w = Math.min(ed[k], ed[k - 1] + a);
      w = Math.min(w, ed[k - nx] + a);
      ed[k] = Math.min(w, ed[k - nx - 1] + b);
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    const row = j * nx;
    if (j === nz - 1) {
      for (let i = nx - 2; i >= 0; i--) ed[row + i] = Math.min(ed[row + i], ed[row + i + 1] + a);
      continue;
    }
    // i = nx-1: no right / down-right neighbour.
    const kr = row + nx - 1;
    let v = Math.min(ed[kr], ed[kr + nx] + a);
    if (nx > 1) v = Math.min(v, ed[kr + nx - 1] + b);
    ed[kr] = v;
    for (let k = row + nx - 2; k > row; k--) {
      let w = Math.min(ed[k], ed[k + 1] + a);
      w = Math.min(w, ed[k + nx] + a);
      w = Math.min(w, ed[k + nx + 1] + b);
      ed[k] = Math.min(w, ed[k + nx - 1] + b);
    }
    if (nx > 1) {
      // i = 0: no down-left neighbour.
      let w = Math.min(ed[row], ed[row + 1] + a);
      w = Math.min(w, ed[row + nx] + a);
      ed[row] = Math.min(w, ed[row + nx + 1] + b);
    }
  }
}

function isFoe(world: World, f: number, o: number): boolean {
  return o === CONTESTED || (o !== NEUTRAL && o !== f && o >= 0 && world.isHostile(f, o));
}

/** Distance (m) from p to hostile-held ground for faction f (Infinity-ish when no contact yet). */
export function enemyDistance(world: World, f: number, p: V2): number {
  const info = world.frontInfo[f];
  if (!info) return 1e6;
  const i = Math.min(info.nx - 1, Math.max(0, Math.floor(p.x / info.cell)));
  const j = Math.min(info.nz - 1, Math.max(0, Math.floor(p.z / info.cell)));
  return info.enemyDist[j * info.nx + i];
}

/** Front-line point of faction f nearest to `toward` (null before first contact). */
export function frontAnchor(world: World, f: number, toward: V2, maxDist = 900): V2 | null {
  const info = world.frontInfo[f];
  if (!info || info.cells.length === 0) return null;
  let best: V2 | null = null;
  let bd = maxDist;
  for (const c of info.cells) {
    const d = dist(c, toward);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/**
 * Pull a position back toward `home` until it is at least `safe` metres from hostile ground
 * (artillery, supply points). Bounded so it never retreats past home.
 */
export function safeRear(world: World, f: number, p: V2, home: V2, safe: number): V2 {
  let q = p;
  for (let k = 0; k < 20 && enemyDistance(world, f, q) < safe; k++) {
    const d = dist(q, home);
    if (d < 40) return home;
    const t = Math.min(1, 40 / d);
    q = { x: q.x + (home.x - q.x) * t, z: q.z + (home.z - q.z) * t };
  }
  return q;
}
