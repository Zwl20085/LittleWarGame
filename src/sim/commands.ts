import { cancelOrder } from './production';
import type { Match } from './sim';
import { issueFrontOrder } from './fronts';
import { frontForOrder } from './frontops';
import type { OrderKind, Unit } from './types';
import type { V2 } from './vec';

const ORDERS: OrderKind[] = ['auto', 'attack', 'defend', 'fortify', 'fallBack'];

/**
 * Player commands = the supreme HQ's job (2.0): the war effort (production, economy) and one
 * high-level order per front (attack / defend / fortify / fall back, on a place or a line).
 * Postures, battle plans, reinforcement shares and group targets are the front commanders'
 * business and are no longer commands. Unit micro (move / attack-move / focus …) stays optional.
 */
export type Command =
  | { type: 'setWeight'; unitId: string; weight: number }
  | { type: 'setCap'; unitId: string; cap: number }
  | { type: 'togglePause'; unitId: string }
  /** One-off production; frontId -1 = the supreme HQ picks the front on roll-out. */
  | { type: 'queueUnit'; unitId: string; frontId: number }
  | { type: 'cancelOrder'; orderId: number }
  | { type: 'setAlloc'; alloc: [number, number, number] }
  | { type: 'setAuto'; on: boolean }
  | { type: 'setLock'; index: number; locked: boolean }
  | { type: 'resetAlloc' }
  /**
   * Supreme-HQ order for a front. `frontId` null = the front whose line is nearest to `a`.
   * `b` makes it a line order (defend / fortify / fallBack hold the line a–b; attack assaults along it).
   */
  | { type: 'frontOrder'; frontId: number | null; kind: OrderKind; a: V2; b?: V2 }
  /** The main effort: reinforcement and supply priority. */
  | { type: 'setMainFront'; frontId: number }
  | { type: 'unitOrder'; unitIds: number[]; order: 'move' | 'moveHold' | 'attackMove' | 'retreat' | 'hold' | 'resume'; pos?: V2; queue?: boolean }
  | { type: 'focus'; unitIds: number[]; targetId: number };

export type CommandFail =
  | 'FACTION_DEAD' | 'NOT_OWNER' | 'STALE_TARGET' | 'UNREACHABLE' | 'BAD_VALUE' | 'ROUTING'
  | 'LOCKED' | 'INSUFFICIENT_M' | 'OUT_OF_BOUNDS' | 'NO_ORDER' | 'NO_FRONT';

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
      if (!w.data.units.has(c.unitId) || c.unitId === w.data.rules.command.commander_unit) return fail('BAD_VALUE');
      if (c.frontId !== -1 && !f.fronts.some((x) => x.id === c.frontId)) return fail('NO_FRONT');
      f.manualQueue = [...f.manualQueue, { unitId: c.unitId, frontId: c.frontId }];
      return OK;
    case 'cancelOrder':
      return cancelOrder(w, f, c.orderId) ? OK : fail('NO_ORDER');
    case 'setAlloc': {
      const sum = c.alloc[0] + c.alloc[1] + c.alloc[2];
      if (c.alloc.some((v) => !Number.isFinite(v) || v < 0) || !(sum > 0)) return fail('BAD_VALUE');
      f.alloc = [c.alloc[0] / sum, c.alloc[1] / sum, c.alloc[2] / sum];
      return OK;
    }
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
    case 'frontOrder': {
      if (!ORDERS.includes(c.kind) || !finiteV2(c.a) || (c.b !== undefined && !finiteV2(c.b))) return fail('BAD_VALUE');
      if (!w.terrain.inBounds(c.a.x, c.a.z) || (c.b && !w.terrain.inBounds(c.b.x, c.b.z))) return fail('OUT_OF_BOUNDS');
      if (c.frontId !== null && !f.fronts.some((x) => x.id === c.frontId)) return fail('NO_FRONT');
      // Infantry must be able to stand there (a point in a lake or on a cliff is no objective).
      const a = w.nav(false, 35).nearestPassable(c.a, 30);
      const b = c.b ? w.nav(false, 35).nearestPassable(c.b, 30) : null;
      if (!a || (c.b && !b)) return fail('UNREACHABLE');
      // No front given: the nearest one, or a new front for an order far from every front (frontops.ts).
      const front = c.frontId === null ? frontForOrder(w, f, a) : f.fronts.find((x) => x.id === c.frontId);
      if (!front) return fail('NO_FRONT');
      issueFrontOrder(w, f, front, { kind: c.kind, a: { ...a }, b: b ? { ...b } : null, issuedAt: w.time, manual: true });
      return OK;
    }
    case 'setMainFront':
      if (!f.fronts.some((x) => x.id === c.frontId)) return fail('NO_FRONT');
      f.mainFront = c.frontId;
      return OK;
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

function formationOffset(i: number, n: number): V2 {
  if (n <= 1) return { x: 0, z: 0 };
  const ring = Math.floor(Math.sqrt(i));
  const a = i * 2.399963; // golden angle
  const r = 12 * Math.sqrt(i) + ring;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
