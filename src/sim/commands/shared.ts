import type { CommandFail, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import type { V2 } from '../vec';

/** Shared validators / result helpers for the command handler modules. */
export const fail = (reason: CommandFail): CommandOutcome => ({ ok: false, reason });
export const OK: CommandOutcome = { ok: true };

export const finiteV2 = (p: V2 | undefined): p is V2 => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

/** Most units one order may name (a drag-select never needs more; bounds the work per command). */
const MAX_ORDER_UNITS = 64;
export const validUnitIds = (ids: unknown): ids is number[] => Array.isArray(ids) && ids.length <= MAX_ORDER_UNITS && ids.every((i) => Number.isInteger(i));

/** A unit the player may produce (review HIGH 3: not the train, not a front commander). */
export const producibleId = (w: Match['world'], id: string): boolean => !!w.data.units.get(id)?.producible && id !== w.data.rules.command.commander_unit;
