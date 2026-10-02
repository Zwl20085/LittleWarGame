import { cancelAir, requestAir } from './air';
import { cancelOrder } from './production';
import type { Match } from './sim';
import type { Posture, Unit } from './types';
import type { V2 } from './vec';

export type Command =
  | { type: 'setWeight'; unitId: string; weight: number }
  | { type: 'setCap'; unitId: string; cap: number }
  | { type: 'togglePause'; unitId: string }
  | { type: 'setUnitSector'; unitId: string; sectorId: number }
  | { type: 'queueUnit'; unitId: string; sectorId: number }
  | { type: 'cancelOrder'; orderId: number }
  | { type: 'setAlloc'; alloc: [number, number, number] }
  | { type: 'setAuto'; on: boolean }
  | { type: 'setLock'; index: number; locked: boolean }
  | { type: 'resetAlloc' }
  | { type: 'setPosture'; sectorId: number; posture: Posture }
  | { type: 'setSectorTarget'; sectorId: number; pos: V2 | null }
  | { type: 'setMainSector'; sectorId: number }
  | { type: 'setShares'; shares: [number, number, number] }
  | { type: 'regroupSector'; sectorId: number }
  | { type: 'unitOrder'; unitIds: number[]; order: 'move' | 'moveHold' | 'attackMove' | 'retreat' | 'hold' | 'resume'; pos?: V2; queue?: boolean }
  | { type: 'focus'; unitIds: number[]; targetId: number }
  | { type: 'air'; missionId: string; pos: V2 }
  | { type: 'cancelAir' };

export type CommandFail =
  | 'FACTION_DEAD' | 'NOT_OWNER' | 'STALE_TARGET' | 'UNREACHABLE' | 'BAD_VALUE' | 'ROUTING'
  | 'LOCKED' | 'BUSY' | 'INSUFFICIENT_M' | 'UNKNOWN_MISSION' | 'OUT_OF_BOUNDS' | 'NO_ORDER';

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
    case 'setUnitSector':
      if (c.sectorId !== -1 && !f.sectors[c.sectorId]) return fail('BAD_VALUE');
      f.unitSector = { ...f.unitSector, [c.unitId]: c.sectorId };
      return OK;
    case 'queueUnit':
      if (!w.data.units.has(c.unitId) || !f.sectors[c.sectorId]) return fail('BAD_VALUE');
      f.manualQueue = [...f.manualQueue, { unitId: c.unitId, sectorId: c.sectorId }];
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
    case 'setPosture':
      if (!f.sectors[c.sectorId]) return fail('BAD_VALUE');
      f.sectors[c.sectorId].posture = c.posture;
      return OK;
    case 'setSectorTarget': {
      const s = f.sectors[c.sectorId];
      if (!s) return fail('BAD_VALUE');
      if (c.pos === null) {
        s.manualTarget = false;
        s.lastRetarget = -999;
        return OK;
      }
      const p = w.nav(false, 35).nearestPassable(c.pos, 30);
      if (!p) return fail('UNREACHABLE');
      s.manualTarget = true;
      s.targetPos = { ...p };
      const obj = w.objectives.find((o) => Math.hypot(o.pos.x - p.x, o.pos.z - p.z) < 40);
      s.targetObjective = obj?.id ?? null;
      s.targetCity = null;
      s.reason = 'reason.playerTarget';
      s.reasonParams = {};
      const exit = w.cityOf(f.id).exit;
      s.rally = { x: exit.x + (p.x - exit.x) * 0.35, z: exit.z + (p.z - exit.z) * 0.35 };
      return OK;
    }
    case 'setMainSector':
      if (!f.sectors[c.sectorId]) return fail('BAD_VALUE');
      f.mainSector = c.sectorId;
      return OK;
    case 'setShares': {
      const sum = c.shares.reduce((a, b) => a + b, 0);
      if (!(sum > 0) || c.shares.some((v) => !Number.isFinite(v) || v < 0)) return fail('BAD_VALUE');
      f.sectors.forEach((s, i) => (s.share = c.shares[i] / sum));
      return OK;
    }
    case 'regroupSector': {
      // Re-assign existing units to match shares (only on explicit request, §4.3).
      const units = [...w.units.values()].filter((u) => u.owner === f.id && u.hp > 0 && !u.fixed);
      let k = 0;
      for (const u of units) {
        const r = (k++ % 20) / 20;
        let acc = 0;
        for (const s of f.sectors) {
          acc += s.share;
          if (r < acc) {
            u.sectorId = s.id;
            break;
          }
        }
        u.behavior = 'rally';
      }
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
    case 'air': {
      const r = requestAir(w, f, c.missionId, c.pos);
      return r === null ? OK : fail(r);
    }
    case 'cancelAir':
      return cancelAir(w, f) ? OK : fail('NO_ORDER');
  }
}

function formationOffset(i: number, n: number): V2 {
  if (n <= 1) return { x: 0, z: 0 };
  const ring = Math.floor(Math.sqrt(i));
  const a = i * 2.399963; // golden angle
  const r = 12 * Math.sqrt(i) + ring;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
