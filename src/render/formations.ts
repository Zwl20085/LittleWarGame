/**
 * Squad and crew layouts. A pattern is picked deterministically from the unit's visual seed and
 * its situation (marching on a road, advancing, idle, engaged, pinned); every soldier gets a
 * stable personal jitter so no two squads stand alike. Offsets are local: +x forward, +z right.
 */
export type Pattern = 'wedge' | 'file' | 'column' | 'teams' | 'cluster' | 'line' | 'echelon';

export type Situation = 'road' | 'moving' | 'idle' | 'engaged' | 'pinned';

/**
 * Slot spacing multiplier: soldiers are drawn large (SOLDIER_SCALE), so squads open up to keep
 * individual figures readable instead of merging into a blob.
 */
export const SQUAD_SPREAD = 1.55;
/** Extra spread for gun crews on top of the gun's own model scale. */
export const CREW_SPREAD = 1.2;

const MOVING: Pattern[] = ['wedge', 'column', 'teams', 'cluster', 'echelon', 'wedge'];
const IDLE: Pattern[] = ['cluster', 'teams', 'line', 'cluster', 'echelon'];

/** Stable hash → [0,1). */
export function vhash(seed: number, k: number, salt: number): number {
  let h = (seed ^ (k * 374761393) ^ (salt * 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function choosePattern(seed: number, s: Situation): Pattern {
  switch (s) {
    case 'road': return vhash(seed, 0, 1) < 0.6 ? 'file' : 'column';
    case 'engaged': case 'pinned': return 'line';
    case 'moving': return MOVING[Math.floor(vhash(seed, 0, 2) * MOVING.length)];
    default: return IDLE[Math.floor(vhash(seed, 0, 3) * IDLE.length)];
  }
}

/** Local slot (forward, right) in metres for soldier k of n, including personal jitter. */
export function slot(p: Pattern, k: number, n: number, seed: number, out: [number, number]): [number, number] {
  const jx = (vhash(seed, k, 11) - 0.5) * 2;
  const jz = (vhash(seed, k, 12) - 0.5) * 2;
  let x = 0;
  let z = 0;
  let jit = 1.2;
  switch (p) {
    case 'wedge': {
      const row = Math.floor((k + 1) / 2);
      const side = k === 0 ? 0 : k % 2 === 1 ? -1 : 1;
      x = -row * 2.7;
      z = side * row * 2.5;
      break;
    }
    case 'file':
      // Staggered single file along the road edge.
      x = -k * 2.6;
      z = (k % 2 ? 0.9 : -0.9) + 2.5;
      jit = 0.5;
      break;
    case 'column':
      x = -Math.floor(k / 2) * 3;
      z = k % 2 ? 1.6 : -1.6;
      jit = 0.6;
      break;
    case 'teams': {
      const half = Math.ceil(n / 2);
      const team = k < half ? 0 : 1;
      const i = team ? k - half : k;
      x = -i * 2.2 - team * 4;
      z = (team ? 5 : -5) + (i % 2 ? 1.6 : -1.6);
      break;
    }
    case 'cluster': {
      const r = 2.1 * Math.sqrt(k + 0.6);
      const a = k * 2.39996 + vhash(seed, 0, 5) * 6.28;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      jit = 0.8;
      break;
    }
    case 'line':
      // Skirmish line across the facing direction, staggered and gappy.
      x = (k % 2 ? -1.2 : 0.6) + (vhash(seed, k, 13) - 0.5) * 1.5;
      z = (k - (n - 1) / 2) * (3.6 + vhash(seed, 0, 6) * 1.4);
      jit = 0.9;
      break;
    case 'echelon':
      x = -k * 2.1;
      z = k * 2.3 * (vhash(seed, 0, 7) < 0.5 ? 1 : -1);
      break;
  }
  out[0] = (x + jx * jit) * SQUAD_SPREAD;
  out[1] = (z + jz * jit) * SQUAD_SPREAD;
  return out;
}

/** Crew positions around a gun (turret-local x forward), varied per gun. */
const CREW_LAYOUTS: [number, number][][] = [
  [[-1.4, 1.2], [-1.6, -1.1], [-2.6, 0.4], [-0.6, -1.8], [-2.8, -1.4]],
  [[-1.0, 1.6], [-2.2, -0.9], [-1.2, -1.9], [-3.0, 1.0], [-3.4, -0.2]],
  [[-1.8, 0.9], [-0.8, -1.6], [-2.9, -1.2], [-2.4, 2.0], [-4.0, 0.5]],
];

export function crewSlot(seed: number, k: number, out: [number, number]): [number, number] {
  const layout = CREW_LAYOUTS[Math.floor(vhash(seed, 0, 21) * CREW_LAYOUTS.length)];
  const [x, z] = layout[k % layout.length];
  out[0] = (x + (vhash(seed, k, 22) - 0.5) * 0.8) * CREW_SPREAD;
  out[1] = (z + (vhash(seed, k, 23) - 0.5) * 0.8) * CREW_SPREAD;
  return out;
}
