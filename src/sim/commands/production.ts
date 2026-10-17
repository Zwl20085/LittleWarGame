import { cancelOrder, placeSlots } from '../production';
import { startBuilding, ECON_KINDS } from '../econ';
import { placeById, placeOwner } from '../settlements';
import { releaseFund } from '../econai';
import type { Command, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import type { Faction } from '../types';
import { OK, fail, producibleId } from './shared';

type C<T extends Command['type']> = Extract<Command, { type: T }>;

export function applySetWeight(match: Match, f: Faction, c: C<'setWeight'>): CommandOutcome {
  if (!Number.isFinite(c.weight) || c.weight < 0 || !producibleId(match.world, c.unitId)) return fail('BAD_VALUE');
  f.weights = { ...f.weights, [c.unitId]: c.weight };
  return OK;
}

export function applySetCap(match: Match, f: Faction, c: C<'setCap'>): CommandOutcome {
  const w = match.world;
  if (!Number.isFinite(c.cap) || c.cap < 0 || !w.data.units.has(c.unitId) || !producibleId(w, c.unitId)) return fail('BAD_VALUE');
  f.caps = { ...f.caps, [c.unitId]: Math.round(c.cap) };
  return OK;
}

export function applyTogglePause(match: Match, f: Faction, c: C<'togglePause'>): CommandOutcome {
  const w = match.world;
  if (!w.data.units.has(c.unitId) || !producibleId(w, c.unitId)) return fail('BAD_VALUE');
  f.paused = { ...f.paused, [c.unitId]: !f.paused[c.unitId] };
  return OK;
}

export function applyQueueUnit(match: Match, f: Faction, c: C<'queueUnit'>, actor: number): CommandOutcome {
  const w = match.world;
  // Front commanders are appointed by the supreme HQ, never bought.
  if (!w.data.units.get(c.unitId)?.producible || c.unitId === w.data.rules.command.commander_unit) return fail('BAD_VALUE');
  if (c.frontId !== -1 && !f.fronts.some((x) => x.id === c.frontId)) return fail('NO_FRONT');
  if (c.placeId !== undefined) {
    // 2.2: queue at a chosen place, which must be ours and have a slot of the unit's facility.
    const p = placeById(w, c.placeId);
    if (!p) return fail('BAD_VALUE');
    if (placeOwner(w, p) !== actor) return fail('NOT_OWNER');
    if (placeSlots(w, p, w.data.units.get(c.unitId)!.facility) <= 0) return fail('NO_SLOT');
    f.manualQueue = [...f.manualQueue, { unitId: c.unitId, frontId: c.frontId, placeId: c.placeId }];
    return OK;
  }
  f.manualQueue = [...f.manualQueue, { unitId: c.unitId, frontId: c.frontId }];
  return OK;
}

export function applyBuildEcon(match: Match, f: Faction, c: C<'buildEcon'>): CommandOutcome {
  if (!ECON_KINDS.includes(c.kind)) return fail('BAD_VALUE');
  const r = startBuilding(match.world, f, c.placeId, c.kind);
  if (typeof r !== 'string') return OK;
  return fail(r === 'INSUFFICIENT_P' || r === 'INSUFFICIENT_M' || r === 'NOT_OWNER' || r === 'NO_SLOT' ? r : r === 'CONTESTED' ? 'CONTESTED' : 'BAD_VALUE');
}

export function applyCancelOrder(match: Match, f: Faction, c: C<'cancelOrder'>): CommandOutcome {
  return cancelOrder(match.world, f, c.orderId) ? OK : fail('NO_ORDER');
}

export function applySetAlloc(f: Faction, c: C<'setAlloc'>): CommandOutcome {
  if (!Array.isArray(c.alloc) || c.alloc.length !== 3 || c.alloc.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return fail('BAD_VALUE');
  const sum = c.alloc[0] + c.alloc[1] + c.alloc[2];
  if (!Number.isFinite(sum) || !(sum > 0)) return fail('BAD_VALUE');
  f.alloc = [c.alloc[0] / sum, c.alloc[1] / sum, c.alloc[2] / sum];
  return OK;
}

export function applySetAutoInvest(match: Match, f: Faction, c: C<'setAutoInvest'>): CommandOutcome {
  if (typeof c.on !== 'boolean') return fail('BAD_VALUE');
  f.autoInvest = c.on;
  if (!c.on) releaseFund(match.world, f);
  return OK;
}

export function applySetAuto(f: Faction, c: C<'setAuto'>): CommandOutcome {
  if (typeof c.on !== 'boolean') return fail('BAD_VALUE');
  f.autoEconomy = c.on;
  return OK;
}

export function applySetLock(f: Faction, c: C<'setLock'>): CommandOutcome {
  if (![0, 1, 2].includes(c.index) || typeof c.locked !== 'boolean') return fail('BAD_VALUE');
  const locks: [boolean, boolean, boolean] = [...f.locks];
  locks[c.index] = c.locked;
  f.locks = locks;
  return OK;
}

export function applyResetAlloc(match: Match, f: Faction): CommandOutcome {
  f.alloc = [...match.world.data.rules.economy.allocation_default] as [number, number, number];
  return OK;
}
