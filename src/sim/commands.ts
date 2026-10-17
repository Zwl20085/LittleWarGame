import { cancelOrder, placeSlots } from './production';
import { startBuilding, ECON_KINDS } from './econ';
import { placeById, placeOwner } from './settlements';
import type { EconKind } from '../data/types';
import type { Match } from './sim';
import { DIRECTIVE_KINDS, DIRECTIVE_LINE_MIN_M, setDirective } from './directive';
import { insisted } from './compliance';
import { releaseFund } from './econai';
import { applyDirectiveNow } from './theatre';
import type { DirectiveKind, Unit } from './types';
import { startRailExtension, startRailRepair, startRoadJob, type JobResult } from './transportjobs';
import { dist, type V2 } from './vec';

/**
 * Player commands = the supreme HQ's job (2.2, docs/V22_SPEC.md §1): the war effort (production,
 * economy) and ONE universal directive (offensive / advance / defend / fortify / contract, with an
 * optional axis point and, for fortify, an optional line that becomes a fortified zone). Fronts are
 * opened, merged and dissolved by the theatre; each front commander answers the directive with its
 * own order. Unit micro (move / attack-move / focus …) stays optional.
 */
export type Command =
  | { type: 'setWeight'; unitId: string; weight: number }
  | { type: 'setCap'; unitId: string; cap: number }
  | { type: 'togglePause'; unitId: string }
  /** One-off production; frontId -1 = the supreme HQ picks the front on roll-out; placeId = queue at that place (2.2). */
  | { type: 'queueUnit'; unitId: string; frontId: number; placeId?: string }
  /** 2.2: build (or rebuild on a ruin) an economic building at an owned town / city. */
  | { type: 'buildEcon'; placeId: string; kind: EconKind }
  | { type: 'cancelOrder'; orderId: number }
  | { type: 'setAlloc'; alloc: [number, number, number] }
  | { type: 'setAuto'; on: boolean }
  /** 2.2.1: automatic investment in economic buildings (off returns the money set aside). */
  | { type: 'setAutoInvest'; on: boolean }
  | { type: 'setLock'; index: number; locked: boolean }
  | { type: 'resetAlloc' }
  /**
   * 2.2 universal directive. `axis` = main effort (offensive) / threatened place (defend, fortify);
   * `line` (fortify only) becomes a permanent fortified zone held by the front nearest it.
   */
  /** 3.0 `force`: the HUD Force toggle (true / false); unset = forced when the same directive is re-issued within insist_window_s. */
  | { type: 'setDirective'; kind: DirectiveKind; axis?: V2; line?: { a: V2; b: V2 }; force?: boolean }
  /** 2.1: stop a fortified-zone project (works already standing remain). */
  | { type: 'cancelZone'; zoneId: number }
  | { type: 'unitOrder'; unitIds: number[]; order: 'move' | 'moveHold' | 'attackMove' | 'retreat' | 'hold' | 'resume'; pos?: V2; queue?: boolean }
  | { type: 'focus'; unitIds: number[]; targetId: number }
  /** 3.0 engineers: lay a road a -> b (<= road_job.max_len_m; bridges short gaps). */
  | { type: 'buildRoad'; a: V2; b: V2 }
  /** 3.0 engineers: rebuild a cut rail line the faction holds at both ends. */
  | { type: 'repairRail'; lineId: number }
  /** 3.0 engineers: extend the rail from own station `stationIdx` to own town / city `to` (objective index). */
  | { type: 'extendRail'; stationIdx: number; to: number };

export type CommandFail =
  | 'FACTION_DEAD' | 'NOT_OWNER' | 'STALE_TARGET' | 'UNREACHABLE' | 'BAD_VALUE' | 'ROUTING'
  | 'LOCKED' | 'INSUFFICIENT_M' | 'INSUFFICIENT_P' | 'OUT_OF_BOUNDS' | 'NO_ORDER' | 'NO_FRONT' | 'NO_SLOT' | 'CONTESTED'
  | 'LINE_SHORT' | 'LINE_ONLY_FORTIFY'
  | 'TOO_LONG' | 'BAD_TERRAIN' | 'NOT_CUT' | 'JOB_BUSY' | 'NOT_HELD' | 'HAS_STATION' | 'TRANSPORT_OFF';

export interface CommandEnvelope {
  readonly commandId: number;
  readonly issuedTick: number;
  readonly actor: number;
  readonly cmd: Command;
}

export type CommandOutcome = { ok: true } | { ok: false; reason: CommandFail };

/** Validates and applies commands at the start of the next tick; records a replayable log. */
export class CommandBus {
  private pending: CommandEnvelope[] = [];
  readonly history: CommandEnvelope[] = [];
  private nextId = 1;
  onResult: ((env: CommandEnvelope, out: CommandOutcome) => void) | null = null;

  issue(match: Match, actor: number, cmd: Command): number {
    const env = { commandId: this.nextId++, issuedTick: match.world.tick, actor, cmd };
    this.pending.push(env);
    return env.commandId;
  }

  flush(match: Match): void {
    const batch = this.pending;
    this.pending = [];
    for (const env of batch) {
      const out = apply(match, env);
      this.history.push(env);
      this.onResult?.(env, out);
    }
  }
}

function ownedUnits(match: Match, actor: number, ids: number[]): Unit[] {
  const out: Unit[] = [];
  for (const id of ids) {
    const u = match.world.unitAlive(id);
    if (u && u.owner === actor && !u.fixed) out.push(u);
  }
  return out;
}

const fail = (reason: CommandFail): CommandOutcome => ({ ok: false, reason });
const OK: CommandOutcome = { ok: true };

const finiteV2 = (p: V2 | undefined): p is V2 => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

function apply(match: Match, env: CommandEnvelope): CommandOutcome {
  const w = match.world;
  const f = w.factions[env.actor];
  if (!f || !f.alive) return fail('FACTION_DEAD');
  const c = env.cmd;
  switch (c.type) {
    case 'setWeight':
      if (!Number.isFinite(c.weight) || c.weight < 0 || !w.data.units.has(c.unitId)) return fail('BAD_VALUE');
      f.weights = { ...f.weights, [c.unitId]: c.weight };
      return OK;
    case 'setCap':
      if (!Number.isFinite(c.cap) || c.cap < 0) return fail('BAD_VALUE');
      f.caps = { ...f.caps, [c.unitId]: Math.round(c.cap) };
      return OK;
    case 'togglePause':
      f.paused = { ...f.paused, [c.unitId]: !f.paused[c.unitId] };
      return OK;
    case 'queueUnit':
      // Front commanders are appointed by the supreme HQ, never bought.
      if (!w.data.units.get(c.unitId)?.producible || c.unitId === w.data.rules.command.commander_unit) return fail('BAD_VALUE');
      if (c.frontId !== -1 && !f.fronts.some((x) => x.id === c.frontId)) return fail('NO_FRONT');
      if (c.placeId !== undefined) {
        // 2.2: queue at a chosen place, which must be ours and have a slot of the unit's facility.
        const p = placeById(w, c.placeId);
        if (!p) return fail('BAD_VALUE');
        if (placeOwner(w, p) !== env.actor) return fail('NOT_OWNER');
        if (placeSlots(w, p, w.data.units.get(c.unitId)!.facility) <= 0) return fail('NO_SLOT');
        f.manualQueue = [...f.manualQueue, { unitId: c.unitId, frontId: c.frontId, placeId: c.placeId }];
        return OK;
      }
      f.manualQueue = [...f.manualQueue, { unitId: c.unitId, frontId: c.frontId }];
      return OK;
    case 'buildEcon': {
      if (!ECON_KINDS.includes(c.kind)) return fail('BAD_VALUE');
      const r = startBuilding(w, f, c.placeId, c.kind);
      if (typeof r !== 'string') return OK;
      return fail(r === 'INSUFFICIENT_P' || r === 'INSUFFICIENT_M' || r === 'NOT_OWNER' || r === 'NO_SLOT' ? r : r === 'CONTESTED' ? 'CONTESTED' : 'BAD_VALUE');
    }
    case 'cancelOrder':
      return cancelOrder(w, f, c.orderId) ? OK : fail('NO_ORDER');
    case 'setAlloc': {
      const sum = c.alloc[0] + c.alloc[1] + c.alloc[2];
      if (c.alloc.some((v) => !Number.isFinite(v) || v < 0) || !(sum > 0)) return fail('BAD_VALUE');
      f.alloc = [c.alloc[0] / sum, c.alloc[1] / sum, c.alloc[2] / sum];
      return OK;
    }
    case 'setAutoInvest':
      f.autoInvest = c.on;
      if (!c.on) releaseFund(w, f);
      return OK;
    case 'setAuto':
      f.autoEconomy = c.on;
      return OK;
    case 'setLock': {
      if (![0, 1, 2].includes(c.index)) return fail('BAD_VALUE');
      const locks: [boolean, boolean, boolean] = [...f.locks];
      locks[c.index] = c.locked;
      f.locks = locks;
      return OK;
    }
    case 'resetAlloc':
      f.alloc = [...w.data.rules.economy.allocation_default] as [number, number, number];
      return OK;
    case 'setDirective': {
      if (!DIRECTIVE_KINDS.includes(c.kind)) return fail('BAD_VALUE');
      if (c.force !== undefined && typeof c.force !== 'boolean') return fail('BAD_VALUE');
      if ((c.axis !== undefined && !finiteV2(c.axis)) || (c.line !== undefined && (!finiteV2(c.line?.a) || !finiteV2(c.line?.b)))) return fail('BAD_VALUE');
      if (c.line && c.kind !== 'fortify') return fail('LINE_ONLY_FORTIFY');
      const pts = [c.axis, c.line?.a, c.line?.b].filter((p): p is V2 => !!p);
      if (pts.some((p) => !w.terrain.inBounds(p.x, p.z))) return fail('OUT_OF_BOUNDS');
      // Infantry must be able to stand there (a point in a lake or on a cliff is no objective).
      const nav = w.nav(false, 35);
      const axis = c.axis ? nav.nearestPassable(c.axis, 80) : null;
      const la = c.line ? nav.nearestPassable(c.line.a, 30) : null;
      const lb = c.line ? nav.nearestPassable(c.line.b, 30) : null;
      if ((c.axis && !axis) || (c.line && (!la || !lb))) return fail('UNREACHABLE');
      if (la && lb && dist(la, lb) < DIRECTIVE_LINE_MIN_M) return fail('LINE_SHORT');
      const line = la && lb ? { a: { ...la }, b: { ...lb } } : null;
      const forced = insisted(w, f, { kind: c.kind, axis, line }, c.force);
      setDirective(w, f, c.kind, axis ? { ...axis } : null, line, true, forced);
      applyDirectiveNow(w, f);
      return OK;
    }
    case 'cancelZone': {
      const z = f.zones.find((x) => x.id === c.zoneId && !x.cancelled);
      if (!z) return fail('NO_ORDER');
      z.cancelled = true;
      return OK;
    }
    case 'unitOrder': {
      const units = ownedUnits(match, env.actor, c.unitIds);
      if (units.length === 0) return fail('NOT_OWNER');
      let any = false;
      units.forEach((u, i) => {
        if (c.order === 'resume') {
          u.manual = null;
          u.queue = [];
          u.behavior = 'advance';
          any = true;
          return;
        }
        if (u.routing && c.order !== 'retreat') return;
        // Formation offsets so a group does not converge on one point.
        const off = c.pos ? formationOffset(i, units.length) : { x: 0, z: 0 };
        const dest = c.pos ? { x: c.pos.x + off.x, z: c.pos.z + off.z } : u.pos;
        const task =
          c.order === 'move' ? { type: 'move' as const, dest, arrivedAt: null, hold: false }
          : c.order === 'moveHold' ? { type: 'move' as const, dest, arrivedAt: null, hold: true }
          : c.order === 'attackMove' ? { type: 'attackMove' as const, dest, clearSince: null }
          : c.order === 'retreat' ? { type: 'retreat' as const }
          : { type: 'hold' as const, pos: { ...u.pos } };
        if (c.queue && u.manual && u.queue.length < w.data.rules.manual_control.max_queued_commands) u.queue.push(task);
        else {
          u.manual = task;
          u.queue = [];
          u.thinkAt = 0;
          u.repathAt = 0;
        }
        any = true;
      });
      return any ? OK : fail('ROUTING');
    }
    case 'buildRoad': {
      if (!finiteV2(c.a) || !finiteV2(c.b)) return fail('BAD_VALUE');
      if (!w.terrain.inBounds(c.a.x, c.a.z) || !w.terrain.inBounds(c.b.x, c.b.z)) return fail('OUT_OF_BOUNDS');
      return jobOutcome(startRoadJob(w, env.actor, { x: c.a.x, z: c.a.z }, { x: c.b.x, z: c.b.z }));
    }
    case 'repairRail':
      if (!Number.isInteger(c.lineId)) return fail('BAD_VALUE');
      return jobOutcome(startRailRepair(w, env.actor, c.lineId));
    case 'extendRail':
      if (!Number.isInteger(c.stationIdx) || !Number.isInteger(c.to)) return fail('BAD_VALUE');
      return jobOutcome(startRailExtension(w, env.actor, c.stationIdx, c.to));
    case 'focus': {
      const t = w.unitAlive(c.targetId);
      if (!t || !w.knows(env.actor, t)) return fail('STALE_TARGET');
      const units = ownedUnits(match, env.actor, c.unitIds);
      if (units.length === 0) return fail('NOT_OWNER');
      for (const u of units) {
        u.manual = { type: 'focus', targetId: t.id, startedAt: w.time };
        u.thinkAt = 0;
      }
      return OK;
    }
  }
}

const JOB_FAIL: Record<string, CommandFail> = {
  DISABLED: 'TRANSPORT_OFF', LENGTH: 'TOO_LONG', WATER: 'BAD_TERRAIN', SLOPE: 'BAD_TERRAIN', OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  NO_BUDGET: 'INSUFFICIENT_M', NOT_CUT: 'NOT_CUT', NOT_HELD: 'NOT_HELD', BUSY: 'JOB_BUSY', HAS_STATION: 'HAS_STATION', BAD_TARGET: 'BAD_VALUE',
};

/** Map an engineer-job refusal (transportjobs.ts) to a structured command failure. */
function jobOutcome(r: JobResult): CommandOutcome {
  return r.ok ? OK : fail(JOB_FAIL[r.reason] ?? 'BAD_VALUE');
}

function formationOffset(i: number, n: number): V2 {
  if (n <= 1) return { x: 0, z: 0 };
  const ring = Math.floor(Math.sqrt(i));
  const a = i * 2.399963; // golden angle
  const r = 12 * Math.sqrt(i) + ring;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
