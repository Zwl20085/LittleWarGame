import type { Faction, Objective, OperationKind, Posture, Personality, Front, Unit } from './types';
import { crossings } from './terrainai';
import { frontById } from './frontref';
import { dist, type V2 } from './vec';
import type { World } from './world';

/**
 * Battle-event log (user request: "a mechanism for the battle event, strategy choice, analysis").
 * A compact, deterministic record of what the AI decided and what came of it:
 *  - ops: every army-group operation (kind, target, force ratio, terrain, doctrine) and its outcome;
 *  - directives: high-command defend / occupy / attack orders and their follow-through;
 *  - engagements: fire-fights clustered by settlement (or 400 m field cell), losses per side,
 *    peak forces, duration and result (captured / repulsed / stalemate / won);
 *  - captures: settlements changing hands;
 *  - samples: per faction every 10 s — stuck / idle units and the army groups' modes.
 * Write-only during a match: the AI never reads it, it consumes no RNG, so it cannot change the
 * deterministic outcome. Arrays are bounded (oldest dropped). Analysis: scripts/strategy.ts.
 */
export const EVENTS = {
  maxRecords: 4000,
  quietCloseS: 30,
  fieldCell: 400,
  areaPad: 150,
  peakEveryS: 5,
  sampleEveryS: 10,
  /** Engagements removing less HP than this in total are counted as skirmishes, not stored. */
  minEngagementHp: 60,
  directiveWindowS: 300,
  attackWindowS: 600,
} as const;

export type TerrainCtx = 'river' | 'pass' | 'town' | 'open';
export type OpOutcome = 'won' | 'abort' | 'spent' | 'timeout' | 'noForce' | 'unreachable' | 'retarget' | 'rethink' | 'reset' | 'open';

export interface OpRecord {
  readonly id: number;
  readonly f: number;
  readonly front: number;
  readonly op: OperationKind;
  readonly doctrine: Personality;
  readonly posture: Posture;
  readonly locked: boolean;
  /** Objective id, `hq:<faction>` for a capital, or '' when none. */
  readonly target: string;
  readonly targetKind: string;
  readonly targetOwner: number;
  readonly area: string;
  readonly t0: number;
  /** Group value (P+M × hp share), known enemy value within 260 m of the target, and their ratio. */
  readonly mine: number;
  readonly theirs: number;
  readonly ratio: number;
  readonly units: number;
  readonly terrain: TerrainCtx;
  readonly distM: number;
  t1: number;
  outcome: OpOutcome;
  /** Value lost by the group's units while the op ran. */
  loss: number;
  lostUnits: number;
  phases: string;
  capturedAt: number;
}

export interface DirectiveRecord {
  readonly id: number;
  readonly f: number;
  readonly kind: 'defend' | 'occupy' | 'attack';
  readonly obj: string;
  readonly t: number;
  readonly n: number;
  readonly value: number;
  readonly ownerAt: number;
  resolvedAt: number;
  result: 'captured' | 'held' | 'lost' | 'expired' | 'open';
}

export interface SideTally {
  loss: number; // value lost
  hp: number; // hp lost
  killed: number;
  dealt: number; // hp removed from others
  peak: number; // peak value present in the area
}

export interface EngagementRecord {
  readonly id: number;
  readonly area: string;
  readonly kind: 'settlement' | 'field';
  readonly pos: V2;
  readonly t0: number;
  readonly holder: number;
  tLast: number;
  t1: number;
  readonly sides: Record<number, SideTally>;
  captureBy: number;
  outcome: 'captured' | 'repulsed' | 'stalemate' | 'won' | 'open';
  winner: number;
}

export interface CaptureRecord {
  readonly t: number;
  readonly obj: string;
  readonly kind: string;
  readonly from: number;
  readonly to: number;
  readonly engagement: number;
}

export interface FactionSample {
  units: number;
  stuck: number;
  idle: number;
  fighting: number;
  modes: Record<string, number>;
  reasons: Record<string, number>;
}

export interface BattleSample {
  readonly t: number;
  readonly f: FactionSample[];
}

export interface BattleLog {
  readonly ops: OpRecord[];
  readonly directives: DirectiveRecord[];
  readonly engagements: EngagementRecord[];
  readonly captures: CaptureRecord[];
  readonly samples: BattleSample[];
  skirmishes: number;
  nextId: number;
  /** Off = hot hooks (hits, per-second upkeep) return at once (for overhead measurements). */
  enabled: boolean;
  /** Runtime indices (not part of the record). */
  readonly activeOp: Map<Front, OpRecord>;
  readonly openEng: Map<string, EngagementRecord>;
  readonly openDir: DirectiveRecord[];
  readonly lastPos: Map<number, V2>;
  readonly lastAttack: Map<number, string>;
  areaGrid: Int16Array | null;
  gridNx: number;
}

export function createBattleLog(): BattleLog {
  return {
    ops: [], directives: [], engagements: [], captures: [], samples: [], skirmishes: 0, nextId: 1, enabled: true,
    activeOp: new Map(), openEng: new Map(), openDir: [], lastPos: new Map(), lastAttack: new Map(), areaGrid: null, gridNx: 0,
  };
}

function push<T>(arr: T[], rec: T): void {
  arr.push(rec);
  if (arr.length > EVENTS.maxRecords) arr.splice(0, arr.length - EVENTS.maxRecords);
}

const valueOf = (u: Unit): number => (u.def.costP + u.def.costM) * (u.hp / (u.fixed ? 1400 : u.def.maxHp));

// ---------------------------------------------------------------- areas

const GRID = 50;

/** Settlement index whose area (radius + pad) covers p, else -1 (grid built once per world). */
function settlementAt(world: World, p: V2): number {
  const log = world.battle;
  if (!log.areaGrid) {
    const nx = Math.ceil(world.terrain.width / GRID) + 1;
    const nz = Math.ceil(world.terrain.depth / GRID) + 1;
    const g = new Int16Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const c = { x: (i + 0.5) * GRID, z: (j + 0.5) * GRID };
        let best = -1;
        let bd = Infinity;
        world.objectives.forEach((o, k) => {
          const d = dist(o.pos, c);
          if (d < o.radius + EVENTS.areaPad && d < bd) {
            bd = d;
            best = k;
          }
        });
        g[j * nx + i] = best;
      }
    }
    log.areaGrid = g;
    log.gridNx = nx;
  }
  const i = Math.max(0, Math.min(log.gridNx - 1, Math.floor(p.x / GRID)));
  const j = Math.max(0, Math.floor(p.z / GRID));
  return log.areaGrid[j * log.gridNx + i] ?? -1;
}

/** Area key used to cluster fighting: objective id, or a 400 m field cell. */
export function areaKey(world: World, p: V2): string {
  const k = settlementAt(world, p);
  if (k >= 0) return world.objectives[k].id;
  return `field:${Math.floor(p.x / EVENTS.fieldCell)},${Math.floor(p.z / EVENTS.fieldCell)}`;
}

function tally(e: EngagementRecord, f: number): SideTally {
  return (e.sides[f] ??= { loss: 0, hp: 0, killed: 0, dealt: 0, peak: 0 });
}

// ---------------------------------------------------------------- hooks

/** Damage hook (from applyDamage): open / feed the engagement at the victim's area, charge the op. */
export function noteHit(world: World, victim: Unit, attackerOwner: number, hp: number, killed: boolean): void {
  const log = world.battle;
  if (!log.enabled || hp <= 0 || attackerOwner < 0 || attackerOwner === victim.owner) return;
  const maxHp = victim.fixed ? 1400 : victim.def.maxHp;
  const value = (victim.def.costP + victim.def.costM) * (hp / maxHp);
  const key = areaKey(world, victim.pos);
  let e = log.openEng.get(key);
  if (!e) {
    const obj = world.objectives.find((o) => o.id === key);
    e = {
      id: log.nextId++, area: key, kind: obj ? 'settlement' : 'field', pos: obj ? obj.pos : { x: victim.pos.x, z: victim.pos.z },
      t0: world.time, holder: obj ? obj.owner : -1, tLast: world.time, t1: -1, sides: {}, captureBy: -1, outcome: 'open', winner: -1,
    };
    log.openEng.set(key, e);
  }
  e.tLast = world.time;
  const v = tally(e, victim.owner);
  v.hp += hp;
  v.loss += value;
  if (killed) v.killed++;
  tally(e, attackerOwner).dealt += hp;
  if (victim.fixed) return;
  const vf = world.factions[victim.owner];
  const sec = vf ? frontById(vf, victim.frontId) : undefined;
  const op = sec ? log.activeOp.get(sec) : undefined;
  if (op) {
    op.loss += value;
    if (killed) op.lostUnits++;
  }
}

/** Capture hook (from updateObjective). */
export function noteCapture(world: World, o: Objective, from: number, to: number): void {
  const log = world.battle;
  const e = log.openEng.get(o.id);
  if (e) {
    e.captureBy = to;
    closeEngagement(world, e);
  }
  push(log.captures, { t: world.time, obj: o.id, kind: o.kind, from, to, engagement: e?.id ?? -1 });
  for (const op of log.activeOp.values()) if (op.f === to && op.target === o.id && op.capturedAt < 0) op.capturedAt = world.time;
  for (const d of log.openDir) {
    if (d.obj !== o.id || d.result !== 'open') continue;
    if (d.kind === 'defend' && d.f === from) resolveDirective(d, world.time, 'lost');
    else if (d.kind !== 'defend' && d.f === to) resolveDirective(d, world.time, 'captured');
  }
}

function resolveDirective(d: DirectiveRecord, t: number, result: DirectiveRecord['result']): void {
  d.result = result;
  d.resolvedAt = t;
}

/** Terrain on the way from the group to its target: river / pass crossings, or a town assault. */
export function terrainContext(world: World, from: V2, to: V2, targetKind: string): TerrainCtx {
  const d = dist(from, to);
  let pass = false;
  for (const c of crossings(world)) {
    if (dist(c.pos, from) + dist(c.pos, to) > d * 1.2 + 40) continue;
    if (c.kind !== 'pass') return 'river';
    pass = true;
  }
  if (pass) return 'pass';
  return targetKind === 'town' || targetKind === 'city' || targetKind === 'capital' ? 'town' : 'open';
}

/** Operation start (doctrine.runOperation re-plan). Closes the group's previous record if still open. */
export function noteOpStart(world: World, f: Faction, s: Front, units: Unit[], theirs: number, replanReason: OpOutcome): void {
  const log = world.battle;
  const prev = log.activeOp.get(s);
  if (prev) finishOp(world, prev, replanReason);
  const obj = s.targetObjective ? world.objectives.find((o) => o.id === s.targetObjective) : undefined;
  const target = obj ? obj.id : s.targetCity !== null ? `hq:${s.targetCity}` : '';
  const targetKind = obj ? obj.kind : s.targetCity !== null ? 'capital' : 'none';
  let cx = 0;
  let cz = 0;
  for (const u of units) {
    cx += u.pos.x;
    cz += u.pos.z;
  }
  const centroid = units.length ? { x: cx / units.length, z: cz / units.length } : world.hqPos(f.id);
  const mine = units.reduce((a, u) => a + valueOf(u), 0);
  const rec: OpRecord = {
    id: log.nextId++, f: f.id, front: s.id, op: s.op, doctrine: f.personality, posture: s.posture, locked: s.opLocked,
    target, targetKind, targetOwner: obj ? obj.owner : s.targetCity ?? -1, area: obj ? obj.id : areaKey(world, s.targetPos), t0: world.time,
    mine: Math.round(mine), theirs: Math.round(theirs), ratio: Math.round((mine / (theirs + 1)) * 100) / 100, units: units.length,
    terrain: terrainContext(world, centroid, s.targetPos, targetKind), distM: Math.round(dist(centroid, s.targetPos)),
    t1: -1, outcome: 'open', loss: 0, lostUnits: 0, phases: '', capturedAt: -1,
  };
  log.activeOp.set(s, rec);
  push(log.ops, rec);
}

/** Phase change of the group's running op (form → assault, dig …). */
export function noteOpPhase(world: World, s: Front, phase: string): void {
  const op = world.battle.activeOp.get(s);
  if (op && phase && !op.phases.includes(phase)) op.phases = op.phases ? `${op.phases}>${phase}` : phase;
}

/** Operation finished (doctrine.endOp / reset). */
export function noteOpEnd(world: World, s: Front, outcome: OpOutcome): void {
  const op = world.battle.activeOp.get(s);
  if (!op) return;
  finishOp(world, op, outcome);
  world.battle.activeOp.delete(s);
}

function finishOp(world: World, op: OpRecord, outcome: OpOutcome): void {
  op.t1 = world.time;
  const cityWon = op.target.startsWith('hq:') && !world.factions[Number(op.target.slice(3))]?.alive;
  op.outcome = op.capturedAt >= 0 || cityWon ? 'won' : outcome;
}

/** High-command directive issued (new garrison, occupation detachment, or a new main attack target). */
export function noteDirective(world: World, f: number, kind: DirectiveRecord['kind'], obj: string, units: readonly Unit[]): void {
  const log = world.battle;
  if (kind === 'attack') {
    if (log.lastAttack.get(f) === obj) return;
    log.lastAttack.set(f, obj);
  }
  const o = world.objectives.find((x) => x.id === obj);
  const rec: DirectiveRecord = {
    id: log.nextId++, f, kind, obj, t: world.time, n: units.length, value: Math.round(units.reduce((a, u) => a + valueOf(u), 0)),
    ownerAt: o ? o.owner : -1, resolvedAt: -1, result: 'open',
  };
  push(log.directives, rec);
  log.openDir.push(rec);
}

// ---------------------------------------------------------------- per-second upkeep

function closeEngagement(world: World, e: EngagementRecord): void {
  const log = world.battle;
  log.openEng.delete(e.area);
  e.t1 = world.time;
  const total = Object.values(e.sides).reduce((a, s) => a + s.hp, 0);
  if (total < EVENTS.minEngagementHp && e.captureBy < 0) {
    log.skirmishes++;
    return;
  }
  const sides = Object.entries(e.sides).map(([k, s]) => ({ f: Number(k), s }));
  if (e.captureBy >= 0) {
    e.outcome = 'captured';
    e.winner = e.captureBy;
  } else if (e.kind === 'settlement' && e.holder >= 0) {
    const held = world.objectives.find((o) => o.id === e.area)?.owner === e.holder;
    e.outcome = held ? 'repulsed' : 'stalemate';
    e.winner = held ? e.holder : -1;
  } else {
    sides.sort((a, b) => a.s.loss - b.s.loss);
    const [lo, hi] = [sides[0], sides[sides.length - 1]];
    const decisive = sides.length >= 2 && hi.s.loss > 0 && hi.s.loss >= Math.max(1, lo.s.loss) * 2;
    e.outcome = decisive ? 'won' : 'stalemate';
    e.winner = decisive ? lo.f : -1;
  }
  push(log.engagements, e);
}

/** Once per game second (sim.step): close quiet engagements, peaks, samples, directive expiry. */
export function battleSecond(world: World): void {
  const log = world.battle;
  if (!log.enabled) return;
  const t = world.time;
  for (const e of [...log.openEng.values()]) if (t - e.tLast > EVENTS.quietCloseS) closeEngagement(world, e);
  if (Math.round(t) % EVENTS.peakEveryS === 0) for (const e of log.openEng.values()) updatePeak(world, e);
  for (let i = log.openDir.length - 1; i >= 0; i--) {
    const d = log.openDir[i];
    const window = d.kind === 'attack' ? EVENTS.attackWindowS : EVENTS.directiveWindowS;
    if (d.result === 'open' && t - d.t > window) resolveDirective(d, t, d.kind === 'defend' ? 'held' : 'expired');
    if (d.result !== 'open') log.openDir.splice(i, 1);
  }
  if (Math.round(t) % EVENTS.sampleEveryS === 0) sample(world);
}

function updatePeak(world: World, e: EngagementRecord): void {
  const o = e.kind === 'settlement' ? world.objectives.find((x) => x.id === e.area) : undefined;
  const r = o ? o.radius + EVENTS.areaPad : EVENTS.fieldCell * 0.6;
  const now: Record<number, number> = {};
  for (const u of world.spatial.query(e.pos.x, e.pos.z, r)) if (u.hp > 0) now[u.owner] = (now[u.owner] ?? 0) + valueOf(u);
  for (const [k, v] of Object.entries(now)) {
    const s = tally(e, Number(k));
    if (v > s.peak) s.peak = Math.round(v);
  }
}

function sample(world: World): void {
  const log = world.battle;
  const out: FactionSample[] = world.factions.map(() => ({ units: 0, stuck: 0, idle: 0, fighting: 0, modes: {}, reasons: {} }));
  const seen = new Map<number, V2>();
  for (const u of world.units.values()) {
    if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck') continue;
    const s = out[u.owner];
    if (!s) continue;
    s.units++;
    const prev = log.lastPos.get(u.id);
    seen.set(u.id, { x: u.pos.x, z: u.pos.z });
    const fighting = world.time - u.lastFiredAt < EVENTS.sampleEveryS || world.time - u.lastDamagedAt < EVENTS.sampleEveryS;
    if (fighting) s.fighting++;
    const moved = prev ? dist(prev, u.pos) : 99;
    if (u.path.length > 0 && moved < 3 && !fighting) s.stuck++;
    else if (!fighting && moved < 3 && u.opRole === 'line' && u.behavior === 'advance') s.idle++;
  }
  log.lastPos.clear();
  for (const [k, v] of seen) log.lastPos.set(k, v);
  for (const f of world.factions) {
    const s = out[f.id];
    if (!f.alive) continue;
    for (const sec of f.fronts) {
      s.modes[sec.mode] = (s.modes[sec.mode] ?? 0) + 1;
      s.reasons[sec.reason] = (s.reasons[sec.reason] ?? 0) + 1;
    }
  }
  push(log.samples, { t: world.time, f: out });
}

/** End of a lab run: close everything still open so the analysis sees it. */
export function finalizeBattleLog(world: World): void {
  const log = world.battle;
  for (const e of [...log.openEng.values()]) closeEngagement(world, e);
  for (const [slot, op] of log.activeOp) {
    finishOp(world, op, 'open');
    log.activeOp.delete(slot);
  }
  for (const d of log.openDir) if (d.result === 'open') d.resolvedAt = world.time;
  log.openDir.length = 0;
}

/** Plain-JSON copy of the records (for media/stats dumps). */
export function battleRecords(log: BattleLog): Pick<BattleLog, 'ops' | 'directives' | 'engagements' | 'captures' | 'samples' | 'skirmishes'> {
  return { ops: log.ops, directives: log.directives, engagements: log.engagements, captures: log.captures, samples: log.samples, skirmishes: log.skirmishes };
}
