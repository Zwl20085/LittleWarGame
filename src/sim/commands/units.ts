import type { Command, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import type { Unit } from '../types';
import type { V2 } from '../vec';
import { OK, fail, finiteV2, validUnitIds } from './shared';

const UNIT_ORDERS: readonly string[] = ['move', 'moveHold', 'attackMove', 'retreat', 'hold', 'resume'];

function ownedUnits(match: Match, actor: number, ids: number[]): Unit[] {
  const out: Unit[] = [];
  for (const id of ids) {
    const u = match.world.unitAlive(id);
    if (u && u.owner === actor && !u.fixed) out.push(u);
  }
  return out;
}

function formationOffset(i: number, n: number): V2 {
  if (n <= 1) return { x: 0, z: 0 };
  const ring = Math.floor(Math.sqrt(i));
  const a = i * 2.399963; // golden angle
  const r = 12 * Math.sqrt(i) + ring;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

export function applyUnitOrder(match: Match, c: Extract<Command, { type: 'unitOrder' }>, actor: number): CommandOutcome {
  const w = match.world;
  if (!validUnitIds(c.unitIds) || !UNIT_ORDERS.includes(c.order)) return fail('BAD_VALUE');
  if (c.queue !== undefined && typeof c.queue !== 'boolean') return fail('BAD_VALUE');
  if (c.pos !== undefined) {
    if (!finiteV2(c.pos)) return fail('BAD_VALUE');
    if (!w.terrain.inBounds(c.pos.x, c.pos.z)) return fail('OUT_OF_BOUNDS');
  }
  const units = ownedUnits(match, actor, c.unitIds);
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

export function applyFocus(match: Match, c: Extract<Command, { type: 'focus' }>, actor: number): CommandOutcome {
  const w = match.world;
  if (!validUnitIds(c.unitIds) || !Number.isInteger(c.targetId)) return fail('BAD_VALUE');
  const t = w.unitAlive(c.targetId);
  if (!t || !w.knows(actor, t)) return fail('STALE_TARGET');
  const units = ownedUnits(match, actor, c.unitIds);
  if (units.length === 0) return fail('NOT_OWNER');
  for (const u of units) {
    u.manual = { type: 'focus', targetId: t.id, startedAt: w.time };
    u.thinkAt = 0;
  }
  return OK;
}
