import { startRailExtension, startRailRepair, startRoadJob, type JobResult } from '../transportjobs';
import type { Command, CommandFail, CommandOutcome } from '../commands';
import type { Match } from '../sim';
import { OK, fail, finiteV2 } from './shared';

const JOB_FAIL: Record<string, CommandFail> = {
  DISABLED: 'TRANSPORT_OFF', LENGTH: 'TOO_LONG', WATER: 'BAD_TERRAIN', SLOPE: 'BAD_TERRAIN', OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  NO_BUDGET: 'INSUFFICIENT_M', NOT_CUT: 'NOT_CUT', NOT_HELD: 'NOT_HELD', BUSY: 'JOB_BUSY', NO_SUCH: 'STALE_TARGET', HAS_STATION: 'HAS_STATION', BAD_TARGET: 'BAD_VALUE',
};

/** Map an engineer-job refusal (transportjobs.ts) to a structured command failure. */
function jobOutcome(r: JobResult): CommandOutcome {
  return r.ok ? OK : fail(JOB_FAIL[r.reason] ?? 'BAD_VALUE');
}

export function applyBuildRoad(match: Match, c: Extract<Command, { type: 'buildRoad' }>, actor: number): CommandOutcome {
  const w = match.world;
  if (!finiteV2(c.a) || !finiteV2(c.b)) return fail('BAD_VALUE');
  if (!w.terrain.inBounds(c.a.x, c.a.z) || !w.terrain.inBounds(c.b.x, c.b.z)) return fail('OUT_OF_BOUNDS');
  return jobOutcome(startRoadJob(w, actor, { x: c.a.x, z: c.a.z }, { x: c.b.x, z: c.b.z }));
}

export function applyRepairRail(match: Match, c: Extract<Command, { type: 'repairRail' }>, actor: number): CommandOutcome {
  if (!Number.isInteger(c.lineId) || c.lineId < 0) return fail('BAD_VALUE');
  return jobOutcome(startRailRepair(match.world, actor, c.lineId));
}

export function applyExtendRail(match: Match, c: Extract<Command, { type: 'extendRail' }>, actor: number): CommandOutcome {
  if (!Number.isInteger(c.stationIdx) || !Number.isInteger(c.to) || c.stationIdx < 0 || c.to < 0) return fail('BAD_VALUE');
  return jobOutcome(startRailExtension(match.world, actor, c.stationIdx, c.to));
}
