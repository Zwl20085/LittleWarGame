// Challenge lab: read-only collector of the player-experience time series (experience.ts defines
// the metrics). One call per game second; samples every 30 s. Never writes to the world.
import { dist, type V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import type { ArrivalRecord, ExperienceLog, ExpSample, FallRecord, HealthSample } from './experience';
import { combatUnit, valueOf } from './worldq';

const RING_M = 600;
const SIGHT_RANGE_M = 2500;
const ARRIVAL_VALUE = 400;
const ARRIVAL_ARMY_SHARE = 0;
const SAMPLE_EVERY_S = 30;
/** A unit unseen this long starts a new approach: its next sighting is a new first sighting. */
const LOST_SIGHT_S = 60;
const STUCK_MOVE_M = 2;
const IDLE_FAR_M = 700;
const STARVED_BELOW = 0.5;
const HOME_RING_FRACTION = 0.5;
const SETTLEMENT = new Set(['village', 'town', 'city']);

interface Snap { by: number; force: number; attArmy: number; defArmy: number }

export interface ExpCollector {
  second(): void;
  finish(decided: boolean): ExperienceLog;
}

export function createExpCollector(w: World): ExpCollector {
  const n = w.factions.length;
  const hq: V2[] = w.factions.map((f) => w.hqPos(f.id));
  const samples: ExpSample[] = [];
  const health: HealthSample[] = [];
  const falls: FallRecord[] = [];
  const arrivals: ArrivalRecord[] = [];
  const alive = w.factions.map((f) => f.alive);
  const snaps: (Snap | null)[] = w.factions.map(() => null);
  const arrived = new Set<number>();
  /** sight[a][d]: attacker unit id -> first time defender d saw it within SIGHT_RANGE_M of its capital. */
  const sight: Map<number, [number, number]>[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => new Map<number, [number, number]>()));
  const alarmOn: [number, number][][] = Array.from({ length: n }, () => []);
  const homeSeries: { t: number; v: number }[][] = Array.from({ length: n }, () => []);
  const lastPos = new Map<number, V2>();
  let owners = w.objectives.map((o) => o.owner);
  let firstContactS = -1;
  let firstTownLostS = -1;

  const second = (): void => {
    const t = Math.round(w.time);
    const army: number[] = new Array(n).fill(0);
    const near: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const u of w.units.values()) {
      if (!combatUnit(u)) continue;
      const v = valueOf(u);
      army[u.owner] += v;
      for (let d = 0; d < n; d++) if (d !== u.owner && alive[d] && dist(u.pos, hq[d]) <= RING_M) near[u.owner][d] += v;
    }
    // Sightings of attackers near each defender's capital.
    for (let d = 0; d < n; d++) {
      if (!alive[d]) continue;
      const vis = w.visibleTo[d];
      if (firstContactS < 0 && vis.size > 0) firstContactS = t;
      for (const id of vis) {
        const u = w.units.get(id);
        if (!u || !combatUnit(u) || dist(u.pos, hq[d]) > SIGHT_RANGE_M) continue;
        const m = sight[u.owner][d];
        const cur = m.get(id);
        if (!cur || t - cur[1] > LOST_SIGHT_S) m.set(id, [t, t]);
        else cur[1] = t;
      }
      const on = w.factions[d].command.homeThreat.active;
      const iv = alarmOn[d];
      if (on) { if (iv.length && iv[iv.length - 1][1] === t - 1) iv[iv.length - 1][1] = t; else iv.push([t, t]); }
      homeSeries[d].push({ t, v: near[d][d] });
    }
    // Settlement flips: first non-capital settlement taken from another faction.
    if (firstTownLostS < 0) {
      w.objectives.forEach((o, i) => {
        if (SETTLEMENT.has(o.kind) && owners[i] >= 0 && o.owner >= 0 && o.owner !== owners[i] && !w.factions.some((f) => dist(hq[f.id], o.pos) < Math.max(60, o.radius))) firstTownLostS = t;
      });
    }
    owners = w.objectives.map((o) => o.owner);
    // Arrivals: the first time an attacker stands at a defender's ring.
    for (let a = 0; a < n; a++) {
      for (let d = 0; d < n; d++) {
        if (a === d || !alive[a] || !alive[d] || !w.isHostile(a, d) || arrived.has(a * n + d)) continue;
        const prog = w.factions[d].hqProgress[a] ?? 0;
        if (!(prog > 0 || near[a][d] >= Math.max(ARRIVAL_VALUE, ARRIVAL_ARMY_SHARE * army[a]))) continue;
        arrived.add(a * n + d);
        let first = -1;
        for (const u of w.units.values()) {
          if (u.owner !== a || !combatUnit(u) || dist(u.pos, hq[d]) > RING_M) continue;
          const s = sight[a][d].get(u.id)?.[0];
          if (s !== undefined && (first < 0 || s < first)) first = s;
        }
        arrivals.push({ attacker: a, defender: d, t, force: Math.round(near[a][d]), attArmy: Math.round(army[a]), firstSightS: first, alarmS: -1, defenderArrivalS: -1 });
      }
    }
    // Capital snapshots (the capturing force while a capture is under way) and falls.
    for (let d = 0; d < n; d++) {
      if (!alive[d]) continue;
      let by = -1;
      let bp = 0;
      for (const [k, p] of Object.entries(w.factions[d].hqProgress)) if (p > bp) { bp = p; by = Number(k); }
      if (by >= 0) snaps[d] = { by, force: Math.round(near[by][d]), attArmy: Math.round(army[by]), defArmy: Math.round(army[d]) };
    }
    for (let f = 0; f < n; f++) {
      if (!alive[f] || w.factions[f].alive) continue;
      alive[f] = false;
      const s = snaps[f];
      falls.push({ capital: f, by: s?.by ?? -1, t, force: s?.force ?? 0, attArmy: s?.attArmy ?? 0, defArmy: s?.defArmy ?? Math.round(army[f]) });
    }
    if (t % SAMPLE_EVERY_S === 0) {
      samples.push({ t, army: army.map(Math.round), terr: w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id).length), alive: w.factions.map((f) => f.alive) });
      health.push(healthSample(w, t, lastPos));
    }
  };

  const finish = (decided: boolean): ExperienceLog => {
    for (const a of arrivals) {
      const from = a.firstSightS >= 0 ? a.firstSightS : a.t;
      a.alarmS = alarmOn[a.defender].reduce((best, [s, e]) => (e >= from && best < 0 ? Math.max(s, from) : best), -1);
      const hit = homeSeries[a.defender].find((p) => p.t >= from && p.v >= HOME_RING_FRACTION * a.force);
      a.defenderArrivalS = hit ? hit.t : -1;
    }
    return { samples, health, falls, arrivals, firstContactS, firstTownLostS, minutes: Math.round((w.time / 60) * 10) / 10, decided };
  };
  return { second, finish };
}

/** Idle far from every own front / HQ, stuck (an order, no target, not moving), supply-starved: counts over all combat units. */
function healthSample(w: World, t: number, lastPos: Map<number, V2>): HealthSample {
  const anchors: V2[][] = w.factions.map((f) => [w.hqPos(f.id), ...f.fronts.map((s) => s.front)]);
  let units = 0;
  let idleFar = 0;
  let stuck = 0;
  let starved = 0;
  const seen = new Set<number>();
  for (const u of w.units.values()) {
    if (!combatUnit(u) || u.routing) continue;
    units++;
    seen.add(u.id);
    const prev = lastPos.get(u.id);
    const moved = prev ? dist(prev, u.pos) : Infinity;
    lastPos.set(u.id, { x: u.pos.x, z: u.pos.z });
    const hasOrder = u.pathIdx < u.path.length || (u.manual !== null && u.manual.type !== 'hold');
    if (hasOrder && u.targetId === null && moved < STUCK_MOVE_M) stuck++;
    if (!hasOrder && !u.moving && u.targetId === null && anchors[u.owner].every((p) => dist(p, u.pos) > IDLE_FAR_M)) idleFar++;
    if (u.supplyRatio < STARVED_BELOW && u.def.id !== 'commander') starved++;
  }
  for (const id of lastPos.keys()) if (!seen.has(id)) lastPos.delete(id);
  return { t, units, idleFar, stuck, starved };
}
