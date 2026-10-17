// 3.0 debug lab (V30_SPEC §2): read-only anomaly probe. `anomalySecond` tracks per-unit / place /
// front state once per game second; `anomalyWindow` classifies every 30 s window into anomaly
// records and merges consecutive windows into episodes. It never writes world state, so a probed
// match stays bit-identical to an unprobed one. Root-cause guesses: anomalyCauses.ts.
import type { Front, Unit } from '../../src/sim/types';
import type { V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { idleCause, navCause, phantomCause, starvedCauses, supplyChainCause, truckCause } from './anomalyCauses';
import { centroid, dist, drawRadiusOf, isCombat, isTruck, placeOwnerOf } from './anomalyWorld';

/** Detection thresholds (docs/DEBUG_LAB.md). */
export const ANOMALY = {
  windowS: 30,
  starved: { minUnits: 5, radius: 120, medianAmmo: 0.15, notRearmS: 90, enemyR: 400 },
  supplyChain: { zeroS: 120, stockEps: 0.5, waitAmmo: 0.5, minWaiting: 2 },
  idle: { minUnits: 8, idleS: 180, frontR: 400, clusterR: 150, firedS: 30 },
  stuck: { s: 60, moveM: 4 },
  convoy: { s: 300 },
  phantom: { maxUnits: 3, s: 180 },
  unreachable: { fails: 3, s: 60, goalCellM: 25 },
  /** Cluster records of one class / faction within this of the last window's join one episode. */
  mergeR: 250,
} as const;

export type AnomalyClass = 'ammo_starved' | 'supply_chain' | 'idle_herd' | 'stuck' | 'convoy_loop' | 'phantom_front' | 'unreachable';
export const CLASSES: readonly AnomalyClass[] = ['ammo_starved', 'supply_chain', 'idle_herd', 'stuck', 'convoy_loop', 'phantom_front', 'unreachable'];
export type Severity = 'low' | 'medium' | 'high';

export interface AnomalyRecord {
  readonly cls: AnomalyClass;
  readonly tick: number;
  readonly t: number;
  readonly faction: number;
  readonly pos: V2;
  readonly unitIds: number[];
  readonly size: number;
  readonly severity: Severity;
  /** Main root-cause guess, plus every probe that fired. */
  readonly cause: string;
  readonly causes: string[];
  /** Episode key for single-object classes (unit / place / front); '' = merge by proximity. */
  readonly key: string;
  readonly detail: Record<string, string | number>;
}

export interface Episode {
  readonly id: number;
  readonly cls: AnomalyClass;
  readonly faction: number;
  readonly key: string;
  readonly startT: number;
  endT: number;
  pos: V2;
  unitIds: number[];
  peakSize: number;
  severity: Severity;
  causes: Record<string, number>;
  timeline: { t: number; size: number; pos: V2; cause: string; detail: Record<string, string | number> }[];
}

interface UnitTrack {
  firstSeen: number;
  lastAmmo: number;
  lastRearmAt: number;
  idleSince: number;
  stuckX: number;
  stuckZ: number;
  stuckSince: number;
  failGoal: string;
  failCount: number;
  failSince: number;
  lastFailed: boolean;
  lastCargo: number;
  lastDeliveryAt: number;
}

export interface AnomalyProbe {
  readonly units: Map<number, UnitTrack>;
  /** Place id → time its stock hit 0 (owned places only). */
  readonly zeroSince: Map<string, number>;
  /** `${faction}:${front}` → time the commanded front fell below phantom.maxUnits. */
  readonly thinSince: Map<string, number>;
  readonly records: AnomalyRecord[];
  readonly episodes: Episode[];
  /** Front id → members (excl. commander / trucks), per faction, refreshed every second. */
  members: Map<number, number>[];
}

export function createAnomalyProbe(): AnomalyProbe {
  return { units: new Map(), zeroSince: new Map(), thinSince: new Map(), records: [], episodes: [], members: [] };
}

/** Idle: standing, nothing to shoot, not fired lately, not rearming or garrisoned or recovering. */
export function isIdle(w: World, u: Unit): boolean {
  return !u.moving && u.path.length === 0 && u.targetId === null && w.time - u.lastFiredAt > ANOMALY.idle.firedS && !u.rearming
    && u.fortId === null && u.opRole !== 'garrison' && u.behavior !== 'recover' && u.behavior !== 'retreat' && isCombat(u);
}

/** Wants to move (stuck.ts / soak.ts rule): a path, no target, not riding. */
const wantsMove = (u: Unit): boolean => u.path.length > 0 && u.targetId === null && !u.mounted;
const goalKey = (u: Unit): string => (u.dest ? `${Math.round(u.dest.x / ANOMALY.unreachable.goalCellM)},${Math.round(u.dest.z / ANOMALY.unreachable.goalCellM)}` : '-');

/** Once per game second: update the trackers (read-only on the world). */
export function anomalySecond(w: World, p: AnomalyProbe): void {
  const t = w.time;
  p.members = w.factions.map(() => new Map<number, number>());
  for (const u of w.aliveUnits) {
    if (u.hp <= 0 || u.fixed) continue;
    let tr = p.units.get(u.id);
    if (!tr) {
      tr = { firstSeen: t, lastAmmo: u.ammo, lastRearmAt: t, idleSince: t, stuckX: u.pos.x, stuckZ: u.pos.z, stuckSince: t, failGoal: '', failCount: 0, failSince: t, lastFailed: false, lastCargo: u.cargo, lastDeliveryAt: t };
      p.units.set(u.id, tr);
    }
    // Rearm activity = ammunition actually received (a unit "rearming" on a long walk for minutes is still starved).
    if (u.ammo > tr.lastAmmo + 1e-6) tr.lastRearmAt = t;
    tr.lastAmmo = u.ammo;
    if (!isIdle(w, u)) tr.idleSince = t;
    if (!wantsMove(u) || Math.hypot(u.pos.x - tr.stuckX, u.pos.z - tr.stuckZ) > ANOMALY.stuck.moveM) {
      tr.stuckX = u.pos.x;
      tr.stuckZ = u.pos.z;
      tr.stuckSince = t;
    }
    if (u.pathFailed && !tr.lastFailed) {
      const g = goalKey(u);
      if (g === tr.failGoal) tr.failCount++;
      else {
        tr.failGoal = g;
        tr.failCount = 1;
        tr.failSince = t;
      }
    }
    if (!u.pathFailed && u.dest && goalKey(u) !== tr.failGoal) tr.failCount = 0;
    tr.lastFailed = u.pathFailed;
    if (isTruck(u)) {
      // Cargo only falls by hand-over (the state may already read 'return' by the time we look);
      // a loaded truck parked at its depot for want of demand is waiting, not looping.
      const parked = u.truckState === 'load' && u.cargo >= (w.data.rules.logistics?.truck_capacity ?? 40) * 0.95;
      if (u.cargo < tr.lastCargo - 0.01 || parked) tr.lastDeliveryAt = t;
      tr.lastCargo = u.cargo;
    } else if (u.def.id !== 'commander') {
      const m = p.members[u.owner];
      if (m) m.set(u.frontId, (m.get(u.frontId) ?? 0) + 1);
    }
  }
  if (w.tick % (60 * w.tickHz) === 0) for (const id of [...p.units.keys()]) if (!w.unitAlive(id)) p.units.delete(id);
  for (const pl of w.places) {
    if (placeOwnerOf(w, pl) >= 0 && pl.stock < ANOMALY.supplyChain.stockEps) {
      if (!p.zeroSince.has(pl.id)) p.zeroSince.set(pl.id, t);
    } else p.zeroSince.delete(pl.id);
  }
  const live = new Set<string>();
  for (const f of w.factions) {
    if (!f.alive) continue;
    for (const s of f.fronts) {
      const key = `${f.id}:${s.id}`;
      if (w.unitAlive(s.commanderId) && (p.members[f.id]?.get(s.id) ?? 0) < ANOMALY.phantom.maxUnits) {
        live.add(key);
        if (!p.thinSince.has(key)) p.thinSince.set(key, t);
      }
    }
  }
  for (const k of [...p.thinSince.keys()]) if (!live.has(k)) p.thinSince.delete(k);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function hostileNear(w: World, f: number, at: V2, r: number): boolean {
  for (const o of w.spatial.query(at.x, at.z, r)) if (o.hp > 0 && w.isHostile(f, o.owner) && dist(o.pos, at) <= r) return true;
  return false;
}

function composition(us: readonly Unit[]): string {
  const c = new Map<string, number>();
  for (const u of us) c.set(u.def.id, (c.get(u.def.id) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
}

function rec(w: World, cls: AnomalyClass, faction: number, pos: V2, units: readonly Unit[], severity: Severity, causes: string[], key: string, detail: Record<string, string | number>): AnomalyRecord {
  return { cls, tick: w.tick, t: w.time, faction, pos: { x: Math.round(pos.x), z: Math.round(pos.z) }, unitIds: units.map((u) => u.id), size: units.length, severity, cause: causes[0] ?? 'unknown', causes, key, detail };
}

function starvedClusters(w: World, p: AnomalyProbe, out: AnomalyRecord[]): void {
  const A = ANOMALY.starved;
  const t = w.time;
  for (const f of w.factions) {
    if (!f.alive) continue;
    const used = new Set<number>();
    const seeds = w.aliveUnits.filter((u) => u.owner === f.id && u.hp > 0 && isCombat(u) && u.ammo < A.medianAmmo).sort((a, b) => a.id - b.id);
    for (const s of seeds) {
      if (used.has(s.id)) continue;
      const members = w.spatial.query(s.pos.x, s.pos.z, A.radius).filter((u) => u.owner === f.id && u.hp > 0 && isCombat(u) && !used.has(u.id) && dist(u.pos, s.pos) <= A.radius);
      if (members.length < A.minUnits) continue;
      const med = median(members.map((u) => u.ammo));
      if (!(med < A.medianAmmo)) continue;
      const idle = members.filter((u) => t - (p.units.get(u.id)?.lastRearmAt ?? t) > A.notRearmS).length;
      if (idle * 2 < members.length) continue;
      const c = centroid(members);
      const engaged = hostileNear(w, f.id, c, A.enemyR) || members.some((u) => u.targetId !== null);
      if (!engaged) continue;
      for (const u of members) used.add(u.id);
      const tanks = members.filter((u) => u.def.kind === 'vehicle').length;
      const sev: Severity = tanks >= 3 || members.length >= 10 || med < 0.05 ? 'high' : 'medium';
      out.push(rec(w, 'ammo_starved', f.id, c, members, sev, starvedCauses(w, members, c), '', { medianAmmo: +med.toFixed(3), tanks, notRearming: idle, mix: composition(members) }));
    }
  }
}

function supplyChain(w: World, p: AnomalyProbe, out: AnomalyRecord[]): void {
  const A = ANOMALY.supplyChain;
  for (const pl of w.places) {
    const since = p.zeroSince.get(pl.id);
    if (since === undefined || w.time - since <= A.zeroS) continue;
    const owner = placeOwnerOf(w, pl);
    const r = drawRadiusOf(w, pl);
    const waiting = w.spatial.query(pl.pos.x, pl.pos.z, r).filter((u) => u.owner === owner && u.hp > 0 && isCombat(u) && u.ammo < A.waitAmmo && dist(u.pos, pl.pos) <= r);
    if (waiting.length < A.minWaiting) continue;
    const sev: Severity = waiting.length >= 8 ? 'high' : waiting.length >= 4 ? 'medium' : 'low';
    out.push(rec(w, 'supply_chain', owner, pl.pos, waiting, sev, [supplyChainCause(w, pl, owner)], `place:${pl.id}`, { place: pl.id, kind: pl.kind, zeroForS: Math.round(w.time - since), logistics: Math.round(w.factions[owner]?.logistics ?? 0) }));
  }
}

/** Points that mark a faction's fighting line: every front's line centre and segment. */
function linePoints(w: World, f: number): V2[] {
  const pts: V2[] = [];
  for (const s of w.factions[f].fronts) {
    pts.push(s.front);
    for (const q of s.segment) pts.push(q);
  }
  return pts;
}

function idleHerds(w: World, p: AnomalyProbe, out: AnomalyRecord[]): void {
  const A = ANOMALY.idle;
  for (const f of w.factions) {
    if (!f.alive) continue;
    const lines = linePoints(w, f.id);
    const far = (u: Unit): boolean => lines.every((q) => dist(q, u.pos) > A.frontR) && !hostileNear(w, f.id, u.pos, A.frontR);
    const idle = w.aliveUnits.filter((u) => u.owner === f.id && u.hp > 0 && isIdle(w, u) && w.time - (p.units.get(u.id)?.idleSince ?? w.time) > A.idleS).sort((a, b) => a.id - b.id);
    const used = new Set<number>();
    for (const s of idle) {
      if (used.has(s.id) || !far(s)) continue;
      const herd = idle.filter((u) => !used.has(u.id) && dist(u.pos, s.pos) <= A.clusterR && far(u));
      if (herd.length < A.minUnits) continue;
      for (const u of herd) used.add(u.id);
      const sev: Severity = herd.length >= 16 ? 'high' : herd.length >= 12 ? 'medium' : 'low';
      out.push(rec(w, 'idle_herd', f.id, centroid(herd), herd, sev, idleCause(w, herd), '', { mix: composition(herd) }));
    }
  }
}

function perUnit(w: World, p: AnomalyProbe, out: AnomalyRecord[]): void {
  const t = w.time;
  for (const u of w.aliveUnits) {
    if (u.hp <= 0 || u.fixed) continue;
    const tr = p.units.get(u.id);
    if (!tr) continue;
    if (wantsMove(u) && t - tr.stuckSince > ANOMALY.stuck.s) {
      out.push(rec(w, 'stuck', u.owner, u.pos, [u], t - tr.stuckSince > 180 ? 'medium' : 'low', [navCause(w, u)], `unit:${u.id}`, { type: u.def.id, forS: Math.round(t - tr.stuckSince), status: u.status }));
    }
    if (tr.failCount >= ANOMALY.unreachable.fails || (u.pathFailed && t - tr.failSince > ANOMALY.unreachable.s && tr.failCount > 0)) {
      out.push(rec(w, 'unreachable', u.owner, u.pos, [u], tr.failCount >= 6 ? 'medium' : 'low', [navCause(w, u)], `unit:${u.id}`, { type: u.def.id, fails: tr.failCount, goal: tr.failGoal, status: u.status }));
    }
    if (isTruck(u) && t - Math.max(tr.lastDeliveryAt, tr.firstSeen) > ANOMALY.convoy.s) {
      out.push(rec(w, 'convoy_loop', u.owner, u.pos, [u], t - tr.lastDeliveryAt > 600 ? 'medium' : 'low', [truckCause(w, u)], `unit:${u.id}`, { state: u.truckState, cargo: +u.cargo.toFixed(1), sinceS: Math.round(t - Math.max(tr.lastDeliveryAt, tr.firstSeen)) }));
    }
  }
}

function phantoms(w: World, p: AnomalyProbe, out: AnomalyRecord[]): void {
  for (const [key, since] of p.thinSince) {
    if (w.time - since <= ANOMALY.phantom.s) continue;
    const [fs, ss] = key.split(':');
    const f = w.factions[Number(fs)];
    const s: Front | undefined = f?.fronts.find((x) => x.id === Number(ss));
    const cmd = s ? w.unitAlive(s.commanderId) : null;
    if (!s || !cmd) continue;
    const n = p.members[f.id]?.get(s.id) ?? 0;
    out.push(rec(w, 'phantom_front', f.id, cmd.pos, [cmd], n === 0 ? 'medium' : 'low', [phantomCause(w, f.id, s)], `front:${key}`, { front: s.name || String(s.id), members: n, fronts: f.fronts.length, order: s.order.kind, forS: Math.round(w.time - since) }));
  }
}

/** Classify the current window, store the records and merge them into episodes. */
export function anomalyWindow(w: World, p: AnomalyProbe): AnomalyRecord[] {
  const out: AnomalyRecord[] = [];
  starvedClusters(w, p, out);
  supplyChain(w, p, out);
  idleHerds(w, p, out);
  perUnit(w, p, out);
  phantoms(w, p, out);
  for (const r of out) mergeEpisode(p, r);
  p.records.push(...out);
  return out;
}

const SEV_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

function mergeEpisode(p: AnomalyProbe, r: AnomalyRecord): void {
  const gap = ANOMALY.windowS * 1.5;
  const open = p.episodes.find((e) => e.cls === r.cls && e.faction === r.faction && r.t - e.endT <= gap && e.endT < r.t
    && (r.key ? e.key === r.key : dist(e.pos, r.pos) <= ANOMALY.mergeR));
  const step = { t: r.t, size: r.size, pos: r.pos, cause: r.cause, detail: r.detail };
  if (!open) {
    p.episodes.push({ id: p.episodes.length + 1, cls: r.cls, faction: r.faction, key: r.key, startT: r.t, endT: r.t, pos: r.pos, unitIds: [...r.unitIds], peakSize: r.size, severity: r.severity, causes: { [r.cause]: 1 }, timeline: [step] });
    return;
  }
  open.endT = r.t;
  open.pos = r.pos;
  open.peakSize = Math.max(open.peakSize, r.size);
  if (SEV_RANK[r.severity] > SEV_RANK[open.severity]) open.severity = r.severity;
  open.unitIds = [...new Set([...open.unitIds, ...r.unitIds])];
  open.causes[r.cause] = (open.causes[r.cause] ?? 0) + 1;
  open.timeline.push(step);
}

/** Ranking for "worst episodes": severity × duration (min) × √peak size. */
export function episodeScore(e: Episode): number {
  return SEV_RANK[e.severity] * ((e.endT - e.startT + ANOMALY.windowS) / 60) * Math.sqrt(e.peakSize);
}

