import { frontAnchor } from './frontai';
import { weakestPoint } from './operations';
import { hostileMask } from './spatial';
import type { Faction, OperationKind, Sector, Unit } from './types';
import { DEG, dist, headingTo, type V2 } from './vec';
import { recordOp } from './stats';
import { startLine, WORKS } from './works';
import type { World } from './world';

/**
 * Battle doctrines (user request): 正面推进 frontal, 侧面迂回 flank, 钳形攻势 pincer,
 * 武装渗透 infiltrate, 筑垒围攻 siege. Each army group runs one operation toward its
 * objective; the AI picks it from the force mix, the target and its doctrine (personality),
 * the player may lock one per group. Work per group is O(group size) every sector think.
 */
export const DOCTRINE = {
  /** Flank waypoint: angle off the front→target axis and distance factor. */
  flankAngle: 70 * DEG,
  flankReach: 0.75,
  /** Share of the group sent on the manoeuvre (flank / pincer). */
  maneuverShare: 0.45,
  minManeuver: 4,
  /** Infiltration teams: share of the group, cap. */
  infiltrateShare: 0.15,
  maxInfiltrators: 8,
  /** Forming up at the waypoint: fraction arrived, or give up waiting after this. */
  formRatio: 0.7,
  formTimeoutS: 110,
  assaultTimeoutS: 260,
  /** Siege ring: distance from the settlement edge, arc half-width, dig budget. */
  siegeStandoffM: 230,
  siegeArc: 75 * DEG,
  siegeMinS: 150,
  siegeMaxS: 360,
  siegeParty: 10,
  /** Siege only when the place is defended by at least this share of our group value. */
  siegeDefenceRatio: 0.45,
  rethinkS: 75,
} as const;

/** Per-group operation bookkeeping (kept on the sector, not shipped to the UI). */
interface OpState {
  key: string; // target key the operation was planned for
  startedAt: number;
  phaseAt: number;
  side: 1 | -1;
  initial: number; // manoeuvre group value at launch
}

const ops = new WeakMap<Sector, OpState>();

const MOBILE = new Set(['light_tank', 'medium_tank', 'heavy_tank', 'motor_inf', 'recon']);
const FOOT = new Set(['infantry', 'engineer', 'motor_inf']);
const INFIL = new Set(['infantry', 'recon', 'engineer', 'motor_inf']);
const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);

function enemyValueNear(world: World, f: number, at: V2, r: number): number {
  let s = 0;
  for (const u of world.spatial.queryOwners(at.x, at.z, r, hostileMask(world, f))) {
    if (u.hp > 0 && world.knows(f, u)) s += (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));
  }
  return s;
}

/** Is the group's objective a defended settlement worth a siege? */
function siegeWorthy(world: World, f: number, s: Sector, groupValue: number): boolean {
  const o = s.targetObjective ? world.objectives.find((x) => x.id === s.targetObjective) : null;
  const isPlace = s.targetCity !== null || (o !== null && o !== undefined && (o.kind === 'town' || o.kind === 'city'));
  if (!isPlace) return false;
  return enemyValueNear(world, f, s.targetPos, 260) > groupValue * DOCTRINE.siegeDefenceRatio;
}

/** AI doctrine choice for one group (deterministic: uses rngAi). */
export function chooseOperation(world: World, f: Faction, s: Sector, units: Unit[]): OperationKind {
  const value = units.reduce((a, u) => a + valueOf(u), 0) + 1;
  if (siegeWorthy(world, f.id, s, value)) return 'siege';
  const mobile = units.filter((u) => MOBILE.has(u.def.id)).length / Math.max(1, units.length);
  const foot = units.filter((u) => FOOT.has(u.def.id)).length;
  const p = f.personality;
  const score: Record<'frontal' | 'flank' | 'infiltrate', number> = {
    frontal: 1 + (p === 'artillery' ? 0.4 : 0) + (p === 'balanced' ? 0.2 : 0),
    flank: 0.5 + mobile * 1.6 + (p === 'armor' || p === 'mechanized' ? 0.5 : 0),
    infiltrate: foot >= 6 ? 0.45 + (p === 'infantry' ? 0.6 : 0) : 0,
  };
  // A little variety so the same doctrine isn't used every time.
  for (const k of Object.keys(score) as (keyof typeof score)[]) score[k] += world.rngAi.next() * 0.35;
  return (Object.keys(score) as (keyof typeof score)[]).reduce((a, b) => (score[b] > score[a] ? b : a));
}

/**
 * Faction level (every sector think): if both wing groups go for nearby objectives with
 * enough mobile troops, make it a pincer on the more valuable target.
 */
export function planPincer(world: World, f: Faction, groups: Unit[][]): void {
  const left = f.sectors.find((s) => s.key === 'left');
  const right = f.sectors.find((s) => s.key === 'right');
  if (!left || !right || left.opLocked || right.opLocked) return;
  if (left.op === 'siege' || right.op === 'siege') return;
  const mob = (s: Sector): number => (groups[s.id] ?? []).filter((u) => MOBILE.has(u.def.id)).length;
  if (mob(left) < 3 || mob(right) < 3) return;
  if (dist(left.targetPos, right.targetPos) > 700) return;
  const stL = ops.get(left);
  if (left.op === 'pincer' && right.op === 'pincer' && stL && world.time - stL.startedAt < DOCTRINE.rethinkS) return;
  const p = f.personality;
  if (left.op !== 'pincer' && world.rngAi.next() > (p === 'armor' || p === 'mechanized' ? 0.6 : 0.3)) return;
  // Both wings converge on the same objective.
  const tgt = (f.command.attackBias[left.targetObjective ?? ''] ?? 0) >= (f.command.attackBias[right.targetObjective ?? ''] ?? 0) ? left : right;
  for (const s of [left, right]) {
    s.targetPos = { ...tgt.targetPos };
    s.targetObjective = tgt.targetObjective;
    s.targetCity = tgt.targetCity;
    if (s.op !== 'pincer') ops.delete(s);
    s.op = 'pincer';
  }
}

/** Run this group's operation: phases, manoeuvre roles, route for the map arrow. */
export function runOperation(world: World, f: Faction, s: Sector, units: Unit[]): void {
  const key = `${Math.round(s.targetPos.x)},${Math.round(s.targetPos.z)}`;
  let st = ops.get(s);
  // Re-plan when the objective changes, or (unlocked) once the current operation has run its course.
  if (!st || st.key !== key || (!s.opLocked && s.opPhase === '' && world.time - st.startedAt > DOCTRINE.rethinkS)) {
    releaseAll(units);
    if (!s.opLocked && s.op !== 'pincer') s.op = chooseOperation(world, f, s, units);
    st = { key, startedAt: world.time, phaseAt: world.time, side: 1, initial: 0 };
    ops.set(s, st);
    s.opPhase = 'form';
    launch(world, f, s, units, st);
    recordOp(world.stats, s.op);
  }
  const from = frontAnchor(world, f.id, s.targetPos) ?? s.front;
  switch (s.op) {
    case 'flank':
    case 'pincer':
      stepManeuver(world, f, s, units, st, from);
      break;
    case 'infiltrate':
      stepInfiltrate(world, f, s, units, st, from);
      break;
    case 'siege':
      stepSiege(world, f, s, units, st);
      break;
    default:
      s.opPhase = s.mode === 'push' || s.mode === 'breakthrough' ? 'assault' : '';
      s.opRoute = [from, s.targetPos];
  }
}

function releaseAll(units: Unit[]): void {
  for (const u of units) {
    if (u.opRole === 'maneuver' || u.opRole === 'infiltrate' || u.opRole === 'siege') {
      u.opRole = 'line';
      u.opTarget = null;
    }
  }
}

function freeLine(u: Unit): boolean {
  return u.opRole === 'line' && !u.spearhead && !u.manual && !u.routing && u.behavior === 'advance';
}

/** Pick the flanking side with less known enemy along the way (pincers: left wing −, right +). */
function flankWaypoint(world: World, s: Sector, from: V2, side: 1 | -1): V2 {
  const axis = headingTo(s.targetPos, from);
  const r = dist(from, s.targetPos) * DOCTRINE.flankReach + 120;
  const a = axis + side * DOCTRINE.flankAngle;
  const p = { x: s.targetPos.x + Math.cos(a) * r, z: s.targetPos.z + Math.sin(a) * r };
  const t = world.terrain;
  const c = { x: Math.max(60, Math.min(t.width - 60, p.x)), z: Math.max(60, Math.min(t.depth - 60, p.z)) };
  return world.nav(false, 35).nearestPassable(c, 120) ?? c;
}

function launch(world: World, f: Faction, s: Sector, units: Unit[], st: OpState): void {
  const pool = units.filter(freeLine);
  if (s.op === 'flank' || s.op === 'pincer') {
    const from = frontAnchor(world, f.id, s.targetPos) ?? s.front;
    if (s.op === 'pincer') st.side = s.key === 'left' ? -1 : 1;
    else {
      const l = enemyValueNear(world, f.id, flankWaypoint(world, s, from, -1), 300);
      const r = enemyValueNear(world, f.id, flankWaypoint(world, s, from, 1), 300);
      st.side = l <= r ? -1 : 1;
    }
    const want = Math.max(DOCTRINE.minManeuver, Math.round(units.length * DOCTRINE.maneuverShare));
    const group = pool.filter((u) => MOBILE.has(u.def.id) || u.def.id === 'infantry')
      .sort((a, b) => Number(MOBILE.has(b.def.id)) - Number(MOBILE.has(a.def.id)) || a.id - b.id).slice(0, want);
    if (group.length < DOCTRINE.minManeuver) {
      s.op = 'frontal';
      return;
    }
    for (const u of group) u.opRole = 'maneuver';
    st.initial = group.reduce((a, u) => a + valueOf(u), 0);
    world.note(f.id, s.op === 'pincer' ? 'log.opPincer' : 'log.opFlank', { n: group.length, point: s.targetObjective ?? '' }, 'info');
  } else if (s.op === 'infiltrate') {
    const n = Math.min(DOCTRINE.maxInfiltrators, Math.max(3, Math.round(units.length * DOCTRINE.infiltrateShare)));
    const team = pool.filter((u) => INFIL.has(u.def.id) && u.hp > u.def.maxHp * 0.7).sort((a, b) => a.id - b.id).slice(0, n);
    if (team.length < 3) {
      s.op = 'frontal';
      return;
    }
    for (const u of team) u.opRole = 'infiltrate';
    st.initial = team.reduce((a, u) => a + valueOf(u), 0);
    world.note(f.id, 'log.opInfiltrate', { n: team.length, point: s.targetObjective ?? '' }, 'info');
  } else if (s.op === 'siege') {
    // A dedicated work party (incl. squads waiting at the rally point) digs and mans the ring.
    const party = units.filter((u) => FOOT.has(u.def.id) && u.opRole === 'line' && !u.spearhead && !u.manual && !u.routing && (u.behavior === 'advance' || u.behavior === 'rally'))
      .sort((a, b) => Number(b.def.id === 'engineer') - Number(a.def.id === 'engineer') || dist(a.pos, s.targetPos) - dist(b.pos, s.targetPos)).slice(0, DOCTRINE.siegeParty);
    const ring = siegeRing(world, f.id, s, Math.max(1, party.length));
    party.forEach((u, i) => {
      u.opRole = 'siege';
      u.behavior = 'advance';
      u.opTarget = ring[i];
    });
    world.note(f.id, 'log.opSiege', { point: s.targetObjective ?? '' }, 'info');
  }
}

function setPhase(world: World, s: Sector, st: OpState, phase: string): void {
  if (s.opPhase === phase) return;
  s.opPhase = phase;
  st.phaseAt = world.time;
}

function stepManeuver(world: World, f: Faction, s: Sector, units: Unit[], st: OpState, from: V2): void {
  const group = units.filter((u) => u.opRole === 'maneuver');
  const wp = flankWaypoint(world, s, from, st.side);
  s.opRoute = [from, wp, s.targetPos];
  if (group.length === 0) {
    s.op = 'frontal';
    return;
  }
  if (s.opPhase === 'form') {
    const arrived = group.filter((u) => dist(u.pos, wp) < 140).length / group.length;
    let ready = arrived >= DOCTRINE.formRatio || world.time - st.phaseAt > DOCTRINE.formTimeoutS;
    if (ready && s.op === 'pincer') {
      // Wait for the other wing (or its timeout) so both jaws close together.
      const other = f.sectors.find((x) => x.id !== s.id && x.op === 'pincer');
      const os = other ? ops.get(other) : undefined;
      if (other && os && other.opPhase === 'form' && world.time - os.phaseAt < DOCTRINE.formTimeoutS) ready = false;
    }
    if (ready) setPhase(world, s, st, 'assault');
  }
  const target = s.opPhase === 'assault' ? s.targetPos : wp;
  for (const u of group) u.opTarget = target;
  const left = group.reduce((a, u) => a + valueOf(u), 0);
  const won = world.objectives.some((o) => o.id === s.targetObjective && o.owner === f.id);
  if (won) recordOp(world.stats, `won:${s.op}`);
  if (won || left < st.initial * 0.3 || (s.opPhase === 'assault' && world.time - st.phaseAt > DOCTRINE.assaultTimeoutS)) {
    releaseAll(units);
    s.op = s.opLocked ? s.op : 'frontal';
    setPhase(world, s, st, '');
  }
}

function stepInfiltrate(world: World, f: Faction, s: Sector, units: Unit[], st: OpState, from: V2): void {
  const team = units.filter((u) => u.opRole === 'infiltrate');
  const cells = world.frontInfo[f.id]?.cells ?? [];
  const gap = (cells.length ? weakestPoint(world, f.id, cells.filter((c) => dist(c, from) < 700)) : null) ?? from;
  s.opRoute = [from, gap, s.targetPos];
  if (team.length === 0) {
    s.op = 'frontal';
    return;
  }
  setPhase(world, s, st, 'move');
  for (const u of team) u.opTarget = dist(u.pos, gap) > 60 && dist(u.pos, s.targetPos) > dist(gap, s.targetPos) ? gap : s.targetPos;
  const won = world.objectives.some((o) => o.id === s.targetObjective && o.owner === f.id);
  if (won) recordOp(world.stats, 'won:infiltrate');
  if (won || world.time - st.startedAt > DOCTRINE.assaultTimeoutS + 120) {
    releaseAll(units);
    s.op = s.opLocked ? s.op : 'frontal';
  }
}

/** Ring of positions (arc facing our side) around the besieged place. */
export function siegeRing(world: World, f: number, s: Sector, n: number): V2[] {
  const o = s.targetObjective ? world.objectives.find((x) => x.id === s.targetObjective) : null;
  const r = (o?.radius ?? 120) + DOCTRINE.siegeStandoffM;
  const home = headingTo(s.targetPos, world.hqPos(f));
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const a = home + t * 2 * DOCTRINE.siegeArc;
    out.push({ x: s.targetPos.x + Math.cos(a) * r, z: s.targetPos.z + Math.sin(a) * r });
  }
  return out;
}

function stepSiege(world: World, f: Faction, s: Sector, units: Unit[], st: OpState): void {
  const ring = siegeRing(world, f.id, s, 9);
  s.opRoute = ring;
  const mine = units.reduce((a, u) => a + valueOf(u), 0) + 1;
  const theirs = enemyValueNear(world, f.id, s.targetPos, 260);
  const elapsed = world.time - st.startedAt;
  if (s.opPhase === 'form' && units.some((u) => dist(u.pos, ring[4]) < 260)) setPhase(world, s, st, 'dig');
  if (s.opPhase === 'dig') {
    // Lay trench lines along the ring facing the place; diggers come from the line itself.
    // One trench at a time so the diggers concentrate; centre of the arc first, then outward.
    const site = world.forts.filter((x) => x.owner === f.id && x.kind === 'trench' && x.hp > 0 && dist(x.pos, s.targetPos) < 700);
    if (site.length < WORKS.maxPerSite && !site.some((x) => x.progress < 1)) {
      const order = [4, 3, 5, 2, 6, 1, 7, 0, 8];
      for (const k of order) if (startLine(world, f, 'trench', ring[k], headingTo(ring[k], s.targetPos))) break;
    }
    const worn = theirs < mine * 0.35;
    if ((elapsed > DOCTRINE.siegeMinS && worn) || elapsed > DOCTRINE.siegeMaxS) {
      setPhase(world, s, st, 'assault');
      releaseAll(units); // the work party joins the storm
      world.note(f.id, 'log.opSiegeAssault', { point: s.targetObjective ?? '' }, 'info');
      recordOp(world.stats, 'siegeAssault');
    }
  }
  const taken = world.objectives.some((o) => o.id === s.targetObjective && o.owner === f.id);
  if (taken && s.opPhase !== '') recordOp(world.stats, 'won:siege');
  if (s.opPhase === 'assault' && (taken || world.time - st.phaseAt > DOCTRINE.assaultTimeoutS)) {
    s.op = s.opLocked ? s.op : 'frontal';
    setPhase(world, s, st, '');
  }
}
