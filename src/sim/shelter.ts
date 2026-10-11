import { buildingsNear, extentAlong, isCollapsed, noteBuildingHit } from './buildings';
import { selectTarget } from './combat';
import { boundOrder, frontOf } from './frontref';
import { moveTo, stop } from './movement';
import { garrisonCover } from './structures';
import type { Building } from './terrain';
import { threatCentre } from './terrainai';
import type { Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.2 (V22_SPEC §12): foot squads under artillery / mortar fire go into the nearest building with
 * room — a roadside farm or a town house — and are then *inside* it: all-round cover, blast and HE
 * strongly reduced (a lighter bunker), the building absorbing part of every shell that would have
 * hit them until it collapses and leaves them exposed. They keep shooting from the windows and go
 * back to their front task once the shelling stops (sooner, and only under sustained fire, when
 * their front has a binding attack order).
 */
export const SHELTER = {
  /** One burst this close is enough to take cover. */
  burstR: 60,
  /** Bursts this close count as a battery ranging on the area ... */
  rangingR: 130,
  /** ... and this many of them (within holdS of each other) send the squad into cover too. */
  rangingBursts: 2,
  /** A squad stays in cover this long after the last burst (within rangingR), then resumes its task. */
  holdS: 14,
  /** Front on a binding attack order: only after this many close bursts, and it leaves sooner. */
  attackBursts: 3,
  attackHoldS: 6,
  /** Search radius for a building with room; up to searchFarR when the straight way there is clear. */
  searchR: 110,
  searchFarR: 160,
  /** A chosen building is re-checked this often (full, collapsed). */
  recheckS: 4,
  /** Known enemies within this decide the side to enter from. */
  threatR: 700,
  /** Within this of its spot a sheltering squad is inside the building. */
  insideM: 3.5,
  /** Inside: blast damage multiplier (bunker 0.4, pillbox 0.55, open 1) — the walls take the rest. */
  insideBlastMul: 0.3,
  /** Share of the blast damage kept off the squad that the building takes instead. */
  absorbFrac: 0.6,
  /** Squads per building: one per this many m² of footprint, 1..maxCapacity. */
  capacityM2: 45,
  maxCapacity: 4,
  /** Indirect fire target score penalty for squads inside intact buildings (prefer exposed targets). */
  artyInsidePenalty: 0.35,
} as const;

/** A/B switch for headless comparisons (scripts only). */
export const SHELTER_AB = { enabled: true };

/** Squads that take cover (guns and their crews stay with the gun). */
const SHELTERS = new Set(['infantry', 'recon', 'mg', 'engineer', 'motor_inf', 'commander']);

interface Mark {
  /** Last burst within rangingR. */
  at: number;
  /** Bursts within burstR / within rangingR since the mark started. */
  close: number;
  ranging: number;
  /** Running mean of the close bursts (fallback side to enter from). */
  x: number;
  z: number;
  spot: V2 | null;
  /** Building index the squad shelters in (-1 none). */
  k: number;
  from: V2 | null;
  checkedAt: number;
}

interface State {
  readonly marks: Map<number, Mark>;
  /** Building index → squads that chose it (validated lazily against their marks). */
  readonly rooms: Map<number, number[]>;
}

const states = new WeakMap<World, State>();

function state(world: World): State {
  let s = states.get(world);
  if (!s) states.set(world, (s = { marks: new Map(), rooms: new Map() }));
  return s;
}

const SC: Unit[] = [];

/** A shell burst at `at` (resolveBlast, kind 'shell'): mark the foot squads around it. */
export function noteShellBurst(world: World, at: V2): void {
  const st = state(world);
  for (const u of world.spatial.query(at.x, at.z, SHELTER.rangingR, SC)) {
    if (u.hp <= 0 || u.fixed || !SHELTERS.has(u.def.id)) continue;
    const d = Math.hypot(u.pos.x - at.x, u.pos.z - at.z);
    if (d > SHELTER.rangingR) continue;
    let m = st.marks.get(u.id);
    if (!m || world.time - m.at > SHELTER.holdS) {
      if (m) release(st, u.id, m);
      m = { at: world.time, close: 0, ranging: 0, x: at.x, z: at.z, spot: null, k: -1, from: null, checkedAt: -1e9 };
      st.marks.set(u.id, m);
    }
    m.at = world.time;
    if (d <= SHELTER.burstR) {
      m.x += (at.x - m.x) * (m.close === 0 ? 1 : 0.35);
      m.z += (at.z - m.z) * (m.close === 0 ? 1 : 0.35);
      m.close++;
    } else m.ranging++;
  }
  if (st.marks.size > 4096) {
    for (const [id, m] of st.marks) if (world.time - m.at > SHELTER.holdS || !world.unitAlive(id)) { release(st, id, m); st.marks.delete(id); }
  }
}

/** Squads one building holds (by footprint). */
export function capacityOf(b: Building): number {
  return Math.max(1, Math.min(SHELTER.maxCapacity, Math.floor((b.w * b.d) / SHELTER.capacityM2)));
}

function release(st: State, id: number, m: Mark): void {
  if (m.k < 0) return;
  const list = st.rooms.get(m.k);
  if (list) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  }
  m.k = -1;
  m.spot = null;
}

/** Room for squad `id` in building k (other reservations still valid). */
function hasRoom(world: World, st: State, k: number, id: number): boolean {
  const list = st.rooms.get(k);
  if (!list) return true;
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    const m = st.marks.get(o);
    if (!m || m.k !== k || world.time - m.at > SHELTER.holdS || !world.unitAlive(o)) list.splice(i, 1);
  }
  return list.filter((o) => o !== id).length < capacityOf(world.terrain.buildings[k]);
}

/** Building index a squad is sheltering inside (intact, at its spot), or -1. */
export function housedIn(world: World, u: Unit): number {
  const m = states.get(world)?.marks.get(u.id);
  if (!m || m.k < 0 || !m.spot || world.time - m.at > SHELTER.holdS) return -1;
  if (Math.abs(u.pos.x - m.spot.x) > SHELTER.insideM || Math.abs(u.pos.z - m.spot.z) > SHELTER.insideM) return -1;
  return isCollapsed(world, m.k) ? -1 : m.k;
}

/**
 * Blast on a squad inside a building (damage.resolveBlast): the reduced multiplier, and the walls
 * take part of what was kept off the squad (they wear down and collapse). Null when not inside.
 */
export function insideBlastMul(world: World, u: Unit, raw: number): number | null {
  const k = housedIn(world, u);
  if (k < 0) return null;
  const b = world.terrain.buildings[k];
  noteBuildingHit(world, { x: b.x, y: world.terrain.heightAt(b.x, b.z) + 1, z: b.z }, raw * (1 - SHELTER.insideBlastMul) * SHELTER.absorbFrac);
  return SHELTER.insideBlastMul;
}

const NEAR: number[] = [];

/** Spots along a building's walls: three on the side away from `from`, one on each flank. */
function spotsOf(b: Building, from: V2): Array<{ p: V2; pen: number }> {
  const dx = b.x - from.x;
  const dz = b.z - from.z;
  const L = Math.hypot(dx, dz) || 1;
  const ux = dx / L;
  const uz = dz / L;
  const e = extentAlong(b, ux, uz) + 1.0;
  const s = extentAlong(b, -uz, ux) + 1.0;
  const along = Math.min(b.w, b.d) / 3;
  return [
    { p: { x: b.x + ux * e, z: b.z + uz * e }, pen: 0 },
    { p: { x: b.x + ux * e - uz * along, z: b.z + uz * e + ux * along }, pen: 0 },
    { p: { x: b.x + ux * e + uz * along, z: b.z + uz * e - ux * along }, pen: 0 },
    { p: { x: b.x - uz * s, z: b.z + ux * s }, pen: 8 },
    { p: { x: b.x + uz * s, z: b.z - ux * s }, pen: 8 },
  ];
}

/** No nook: open, passable ground 3 m out from the spot (straight out and at ±50°). */
function openAround(world: World, u: Unit, b: Building, p: V2): boolean {
  const t = world.terrain;
  const nav = world.navFor(u);
  const a = Math.atan2(p.z - b.z, p.x - b.x);
  for (const da of [0, 0.87, -0.87]) {
    const q = { x: p.x + Math.cos(a + da) * 3, z: p.z + Math.sin(a + da) * 3 };
    if (t.buildingH(q.x, q.z) > 0 || !nav.passable(q)) return false;
  }
  return true;
}

/** Nearest building with room (and a reachable spot at its walls) for squad `u`. */
export function shelterSpot(world: World, u: Unit, from: V2): { p: V2; k: number } | null {
  const t = world.terrain;
  const nav = world.navFor(u);
  const st = state(world);
  let best: { p: V2; k: number } | null = null;
  let bd: number = SHELTER.searchFarR;
  for (const k of buildingsNear(t, u.pos, SHELTER.searchFarR, NEAR)) {
    const b = t.buildings[k];
    if (Math.abs(b.x - u.pos.x) > bd + 15 || Math.abs(b.z - u.pos.z) > bd + 15 || b.h < 4 || isCollapsed(world, k)) continue;
    if (best && best.k === k) continue;
    let ok = false;
    for (const c of spotsOf(b, from)) {
      const d = dist(c.p, u.pos) + c.pen;
      if (d >= bd || !t.inBounds(c.p.x, c.p.z) || t.buildingH(c.p.x, c.p.z) > 0 || !nav.passable(c.p)) continue;
      if (d > SHELTER.searchR && !t.wallFree(u.pos, c.p)) continue;
      if (!openAround(world, u, b, c.p)) continue;
      if (!ok && !hasRoom(world, st, k, u.id)) break;
      ok = true;
      bd = d;
      best = { p: c.p, k };
    }
  }
  return best;
}

function reserve(st: State, id: number, k: number): void {
  const list = st.rooms.get(k);
  if (!list) st.rooms.set(k, [id]);
  else if (!list.includes(id)) list.push(id);
}

/**
 * Behaviour hook (behavior.thinkUnit): a shelled foot squad with no works / bunker of its own
 * goes into a building and fights from there. Returns false (normal task) when the squad is not
 * shelled, already protected, or has no building with room nearby.
 */
export function takeShelter(world: World, u: Unit): boolean {
  if (!SHELTER_AB.enabled || !SHELTERS.has(u.def.id) || u.mounted || u.fixed || u.manual) return false;
  const st = states.get(world);
  const m = st?.marks.get(u.id);
  if (!st || !m) return false;
  const front = frontOf(world.factions[u.owner], u.frontId);
  const attack = !!front && boundOrder(front) && front.order.kind === 'attack';
  if (world.time - m.at > (attack ? SHELTER.attackHoldS : SHELTER.holdS)) {
    release(st, u.id, m);
    st.marks.delete(u.id);
    return false;
  }
  if (attack ? m.close < SHELTER.attackBursts : m.close < 1 && m.ranging < SHELTER.rangingBursts) return false;
  // Works, a fort slot or a pillbox / bunker already protect it (their own duty keeps it there).
  if (u.fortId !== null || u.worksFacing !== null || garrisonCover(u) !== null) return false;
  if (!m.spot || world.time - m.checkedAt > SHELTER.recheckS) {
    // Enter on the side away from the enemy (guns and spotters), else away from the bursts.
    if (!m.from) m.from = threatCentre(world, u.owner, u.pos, SHELTER.threatR) ?? { x: m.x, z: m.z };
    const inside = m.spot !== null && dist(u.pos, m.spot) <= SHELTER.insideM;
    const keep = m.k >= 0 && !isCollapsed(world, m.k) && (inside || hasRoom(world, st, m.k, u.id));
    if (!keep) {
      release(st, u.id, m);
      const got = shelterSpot(world, u, m.from);
      if (got) {
        m.spot = got.p;
        m.k = got.k;
        reserve(st, u.id, got.k);
      }
    }
    m.checkedAt = world.time;
  }
  if (!m.spot) return false;
  if (dist(u.pos, m.spot) > 2.5) moveTo(world, u, m.spot);
  else stop(u);
  selectTarget(world, u, null);
  u.status = 'status.takingCover';
  return true;
}
