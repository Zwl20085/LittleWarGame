import { boundOrder } from './frontref';
import { selectTarget } from './combat';
import { moveTo, stop } from './movement';
import { profileOf, raidIntervalMul, raidsHeld, raidsOnDefence } from './doctrines';
import { corridorDefence, endRaid, ECON_WAR, freeSquad, knownDefence, nearestCell, RAIDER_IDS, raiderRank } from './econwar';
import { pointAlong, railRules } from './rail';
import type { RailLine } from './transportstate';
import type { Faction, Unit } from './types';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * 3.0 rail raids (doctrines `raid_targets.rail`, DOCTRINES.md "Seams"): an AI whose doctrine
 * weights rail raids (attrition) sends a small party (2–3 squads, an engineer first) at an enemy
 * railway — a point on the track or a station near our front, thinly defended, reached through a
 * thin corridor (the econwar.ts party rules). A party member standing within `cutR` of the target
 * for `cutS` tears the track up: the line is cut exactly like a line whose station fell to an enemy
 * (rail.ts `line.cut`), trains on it unload, and its holder's engineers rebuild it through the same
 * repair job (transportjobs.startRailRepair). At a station every hostile line through it is cut.
 * One party per faction at a time; same time budget and abort rules as the economic raids.
 */
export const RAIL_RAID = {
  /** First launch attempt not before this; then every everyS × the doctrine's rail interval multiplier. */
  firstS: 420,
  everyS: 150,
  partyMin: 2,
  partyMax: 3,
  /** Track sample spacing for target points (m); line ends are the stations. */
  sampleM: 150,
  /** A station end counts within this of the line's first / last point (m). */
  stationM: 30,
  /** Demolition: a member within cutR of the target point for cutS seconds cuts the line. */
  cutR: 35,
  cutS: 20,
  /** Party time budget (s). */
  maxS: 360,
} as const;

/** Lab counters: launches, cuts (lines cut by raids), why a launch did not happen. */
export const RAIL_RAID_STATS: Record<string, number> = {};
const count = (k: string, n = 1): void => { RAIL_RAID_STATS[k] = (RAIL_RAID_STATS[k] ?? 0) + n; };

export const railTag = (lineId: number): string => `rail:${lineId}`;
const tagLine = (tag: string | null): number => (tag && tag.startsWith('rail:') ? Number(tag.slice(5)) : -1);

export interface RailPick {
  readonly line: number;
  /** Station id at the target point (−1 = open track). */
  readonly station: number;
  readonly pos: V2;
  readonly defence: number;
  readonly score: number;
  readonly cell: V2;
}

interface RailParty { readonly pick: RailPick; readonly ids: number[]; readonly until: number; arrivedAt: number }
const parties = new WeakMap<Faction, RailParty>();
const nextAt = new WeakMap<Faction, number>();

/** A line worth cutting for `f`: whole, last held by a live enemy of `f`. */
function hostileLine(world: World, f: number, l: RailLine): boolean {
  return !l.cut && l.heldBy >= 0 && world.isHostile(f, l.heldBy) && !!world.factions[l.heldBy]?.alive;
}

/** Hostile whole lines through station `sid` (the lines a cut at that station takes out). */
function linesAt(world: World, f: number, sid: number): number[] {
  const st = world.transport!;
  return st.stations[sid].lines.filter((id) => hostileLine(world, f, st.lines[id]));
}

/**
 * Best enemy railway point to cut: worth (a line in use 1, a station × the hostile lines through
 * it) ÷ (defence and distance from our front), within rangeM of our front cells, defended by at most
 * maxDefence × `partyValue` and reached through a thin corridor (pure scoring; exported for tests).
 */
export function pickRailTarget(world: World, f: Faction, partyValue: number): RailPick | null {
  const st = world.transport;
  if (!st || !railRules(world)) return null;
  let best: RailPick | null = null;
  for (const l of st.lines) {
    if (!hostileLine(world, f.id, l)) continue;
    const n = Math.max(1, Math.ceil(l.len / RAIL_RAID.sampleM));
    for (let k = 0; k <= n; k++) {
      const pos = pointAlong(l.pts, l.cum, (k / n) * l.len);
      const station = k === 0 ? l.a : k === n ? l.b : -1;
      const { cell, d } = nearestCell(world, f.id, pos);
      if (!cell || d > ECON_WAR.rangeM) continue;
      const defence = knownDefence(world, f.id, pos, ECON_WAR.defR);
      if (defence > partyValue * ECON_WAR.maxDefence) continue;
      const corridor = corridorDefence(world, f.id, cell, pos);
      if (corridor > partyValue * ECON_WAR.maxCorridor) continue;
      const worth = (station >= 0 ? linesAt(world, f.id, station).length : 1) * (l.owner >= 0 ? 1 : 0.5);
      const score = worth / ((1 + (defence + corridor) / 300) * (1 + d / 700));
      if (!best || score > best.score + 1e-9) best = { line: l.id, station, pos, defence, score, cell };
    }
  }
  return best;
}

/** Live members of the faction's rail party (drops the party once it is home, broken or done). */
function liveParty(world: World, f: Faction): RailParty | null {
  const p = parties.get(f);
  if (!p) return null;
  const alive = p.ids.filter((id) => { const u = world.unitAlive(id); return !!u && u.opRole === 'raid' && tagLine(u.opObjective) === p.pick.line; });
  const done = world.transport?.lines[p.pick.line]?.cut ?? true;
  if (alive.length === 0 || done || alive.length < Math.ceil(p.ids.length * ECON_WAR.abortShare) || world.time > p.until) {
    count(done ? 'endCut' : world.time > p.until ? (p.arrivedAt >= 0 ? 'endTimeAtSite' : 'endTime') : 'endBroken');
    for (const id of alive) endRaid(world.unitAlive(id)!);
    parties.delete(f);
    return null;
  }
  return p;
}

/** Does this faction's doctrine raid railways at all (weight > 0; never the player, never with doctrines off)? */
export const railRaider = (world: World, f: Faction): boolean => !!profileOf(world, f) && Number.isFinite(raidIntervalMul(world, f, 'rail'));

/**
 * Supreme-HQ pass (fronts.planFronts, next to the economic raids): launch one rail raid party when
 * none is out. Same gates as the economic raids (no finisher / contract, defend only if the doctrine
 * raids on defence, a full enough army, no real alert at home).
 */
export function planRailRaids(world: World, f: Faction): void {
  if (f.isPlayer || !f.alive || !world.transport || !railRules(world) || !railRaider(world, f)) return;
  if (liveParty(world, f)) return;
  if (world.time < Math.max(RAIL_RAID.firstS, nextAt.get(f) ?? 0)) return;
  nextAt.set(f, world.time + RAIL_RAID.everyS * raidIntervalMul(world, f, 'rail'));
  const k = f.directive.kind;
  if (f.command.finisher || k === 'contract' || ((k === 'defend' || k === 'fortify') && !raidsOnDefence(world, f))) return count('directive');
  if (f.command.fullness < ECON_WAR.minFullness) return count('thin');
  if (f.command.homeThreat.alert) return count('alert');
  if (raidsHeld(world, f)) return count('held');
  const rifle = world.data.units.get('infantry');
  const typical = rifle ? 2 * (rifle.costP + rifle.costM) : 200;
  const pick = pickRailTarget(world, f, typical);
  if (!pick) return count('noTarget');
  const bound = new Set(f.fronts.filter(boundOrder).map((s) => s.id));
  const pool: Unit[] = [];
  for (const u of world.aliveUnits) {
    if (u.owner === f.id && RAIDER_IDS.has(u.def.id) && freeSquad(u, bound) && dist(u.pos, pick.cell) <= ECON_WAR.poolR) pool.push(u);
  }
  pool.sort((a, b) => raiderRank(a) - raiderRank(b) || dist(a.pos, pick.pos) - dist(b.pos, pick.pos) || a.id - b.id);
  const size = Math.min(RAIL_RAID.partyMax, RAIL_RAID.partyMin + (pick.defence > 0 ? 1 : 0));
  const party: Unit[] = [];
  let eng = 0;
  for (const u of pool) {
    if (party.length >= size) break;
    if (u.def.id === 'engineer' && eng++ >= 1) continue;
    party.push(u);
  }
  if (party.length < RAIL_RAID.partyMin) return count('noParty');
  count('launched');
  const until = world.time + RAIL_RAID.maxS;
  for (const u of party) {
    u.opRole = 'raid';
    u.opObjective = railTag(pick.line);
    u.opTarget = { ...pick.pos };
    u.opUntil = until;
  }
  parties.set(f, { pick, ids: party.map((u) => u.id), until, arrivedAt: -1 });
  world.note(f.id, 'log.railRaid', { n: party.length }, 'info');
}

/**
 * Tear the track up: the target line (and at a station every hostile whole line through it) is cut
 * like a line whose station fell (rail.ts); its holder repairs it with engineers. Returns lines cut.
 */
export function cutByRaid(world: World, f: number, lineId: number, station: number): number {
  const st = world.transport;
  if (!st) return 0;
  const ids = station >= 0 ? linesAt(world, f, station) : [lineId];
  let n = 0;
  for (const id of ids) {
    const l = st.lines[id];
    if (!l || !hostileLine(world, f, l)) continue;
    l.cut = true;
    n++;
    world.note(l.heldBy, 'log.railCutRaid', {}, 'warn');
  }
  if (n > 0) {
    st.version++;
    count('cuts', n);
  }
  return n;
}

/**
 * Raider behaviour on a rail raid (behavior.thinkOpRaid hands over for a `rail:` objective): march
 * to the track point, stand on it shooting back; after cutS with a member on the spot the line is cut
 * and the party comes home.
 */
export function thinkRailRaid(world: World, u: Unit): boolean {
  const f = world.factions[u.owner];
  const p = parties.get(f);
  const line = tagLine(u.opObjective);
  if (u.routing || u.manual || world.time > u.opUntil || u.hp < u.def.maxHp * 0.4 || !p || p.pick.line !== line || world.transport?.lines[line]?.cut !== false) {
    endRaid(u);
    return false;
  }
  const goal = p.pick.pos;
  selectTarget(world, u, goal);
  const d = dist(u.pos, goal);
  if (d <= RAIL_RAID.cutR) {
    stop(u);
    if (p.arrivedAt < 0) {
      p.arrivedAt = world.time;
      count('arrived');
    }
    else if (world.time - p.arrivedAt >= RAIL_RAID.cutS) cutByRaid(world, u.owner, p.pick.line, p.pick.station);
  } else moveTo(world, u, goal);
  u.status = 'status.raidRail';
  return true;
}
