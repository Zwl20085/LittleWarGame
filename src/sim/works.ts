import { trySpend } from './economy';
import { stormOn } from './strategyai';
import type { Faction, Fort, FortKind, Unit } from './types';
import { angleDiff, DEG, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * Field works (user request: 筑垒围攻 / 筑垒防守). Besiegers dig trench lines around a town;
 * garrisons stack sandbag barricades facing the threat. Troops behind finished works get top
 * cover against blast and direct fire from the front, so a city's guns can't simply shell
 * attackers off the map — and attackers can't simply shell a dug-in garrison.
 */
export const WORKS = {
  trench: { costP: 12, workSeconds: 40, hp: 2600, length: 46, coverRadiusM: 6 },
  sandbag: { costP: 6, workSeconds: 22, hp: 1600, length: 16, coverRadiusM: 4 },
  /** Fire from within ±this of the work's facing is stopped by the parapet. */
  frontArc: 110 * DEG,
  /** One faction may start a new work at most this often (M budget pacing). */
  startEverySeconds: 8,
  maxPerSite: 8,
} as const;

type LineKind = Extract<FortKind, 'trench' | 'sandbag'>;

/** Round 4: the last work each unit failed to reach. */
const unreachableWork = new WeakMap<Unit, number>();

/** Line-work pacing per faction (separate from the field-cover builder's budget). */
const lineWorksAt = new WeakMap<Faction, number>();

/** Distance from p to segment ab. */
export function segDist(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/**
 * Lay out (but don't pay for) a line work centred at `c`, perpendicular to `facing`.
 * Returns null when one already exists there.
 */
function newLine(world: World, owner: number, kind: LineKind, c: V2, facing: number): Fort | null {
  const spec = WORKS[kind];
  for (const f of world.forts) if (f.hp > 0 && (f.kind === 'trench' || f.kind === 'sandbag') && dist(f.pos, c) < spec.length * 0.7) return null;
  const along = facing + Math.PI / 2;
  const h = spec.length / 2;
  const start = { x: c.x - Math.cos(along) * h, z: c.z - Math.sin(along) * h };
  const end = { x: c.x + Math.cos(along) * h, z: c.z + Math.sin(along) * h };
  if (world.terrain.buildingH(c.x, c.z) > 0) return null;
  return { id: world.newId(), owner, kind, pos: { ...c }, facing, start, end, length: spec.length, hp: spec.hp, maxHp: spec.hp, progress: 0, occupant: null };
}

/**
 * Pay for and register a line work if the faction's works budget allows. `prepaid`: the planner
 * already collected the cost in instalments (fortplans.ts escrow), so nothing is charged here.
 */
export function startLine(world: World, f: Faction, kind: LineKind, c: V2, facing: number, prepaid = false): Fort | null {
  if (world.time - (lineWorksAt.get(f) ?? -1e9) < WORKS.startEverySeconds) return null;
  const fort = newLine(world, f.id, kind, c, facing);
  if (!fort) return null;
  // Digging is labour: paid in manpower (P), not munitions.
  const k = world.data.rules.proposed_defaults.army_scale ?? 1;
  const cost = WORKS[kind].costP * k;
  if (!prepaid && (f.p < cost || !trySpend(f, cost, 0).ok)) return null;
  world.forts.push(fort);
  lineWorksAt.set(f, world.time);
  return fort;
}

/** Nearest unfinished friendly line work within r of p (for diggers to help with). */
export function openWork(world: World, owner: number, p: V2, r: number): Fort | null {
  let best: Fort | null = null;
  let bd = r;
  for (const f of world.forts) {
    if (f.owner !== owner || f.hp <= 0 || f.progress >= 1 || (f.kind !== 'trench' && f.kind !== 'sandbag')) continue;
    const d = dist(f.pos, p);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/** One digging step (called from the unit executor, ~every 0.4 s). Returns true while busy. */
export function dig(u: Unit, fort: Fort, moveTo: (p: V2) => void, stop: () => void): boolean {
  if (fort.progress >= 1 || fort.hp <= 0) return false;
  // Round 4: a work this unit could not path to is left to others (soak: diggers 'unreachable' for minutes).
  if (stormOn() && unreachableWork.get(u) === fort.id) return false;
  if (segDist(u.pos, fort.start ?? fort.pos, fort.end ?? fort.pos) > 8) {
    if (stormOn() && u.pathFailed && u.dest && dist(u.dest, fort.pos) < 45) {
      unreachableWork.set(u, fort.id);
      return false;
    }
    moveTo(fort.pos);
  } else {
    stop();
    if (u.moraleState === 'normal') {
      // Engineers dig twice as fast as riflemen.
      const rate = (u.def.id === 'engineer' ? 2 : 1) * 0.4 / WORKS[fort.kind as LineKind].workSeconds;
      fort.progress = Math.min(1, fort.progress + rate);
    }
  }
  u.status = 'status.digging';
  return true;
}

/**
 * Refresh which finished friendly work (if any) shelters this unit; staggered (every 10th
 * tick per unit) and only scans works, so it stays cheap with hundreds of units.
 */
export function updateWorksCover(world: World, u: Unit): void {
  if ((world.tick + u.id) % 10 !== 0) return;
  u.worksFacing = null;
  if (u.def.kind === 'vehicle' || u.moving) return;
  for (const f of world.forts) {
    if (f.owner !== u.owner || f.hp <= 0 || f.progress < 1 || (f.kind !== 'trench' && f.kind !== 'sandbag')) continue;
    if (segDist(u.pos, f.start ?? f.pos, f.end ?? f.pos) <= WORKS[f.kind].coverRadiusM) {
      u.worksFacing = f.facing;
      return;
    }
  }
}

/** Does a work protect `u` against an attack from `from` (null = blast from above/unknown)? */
export function worksProtect(u: Unit, from: V2 | null): boolean {
  if (u.worksFacing === null) return false;
  if (!from) return true;
  return Math.abs(angleDiff(u.worksFacing, headingTo(u.pos, from))) <= WORKS.frontArc;
}
