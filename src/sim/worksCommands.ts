import type { Command, CommandFail, CommandOutcome } from './commands';
import { startZone, upgradeZone, zoneById, type ZoneFail } from './econZones';
import { startMinefield, tierRules } from './minefields';
import type { Match } from './sim';
import type { Faction } from './types';
import { startUpgrade } from './worksTiers';

/**
 * 3.0 player commands for economic zones and defensive works (V30 §7, §8), validated here so
 * commands.ts keeps a one-line hook. The HQ's engineers do the work (fortplans.planStructures).
 */
type WorksCommand = Extract<Command, { type: 'buildZone' | 'upgradeZone' | 'upgradeWork' | 'layMines' }>;

const OK: CommandOutcome = { ok: true };
const fail = (reason: CommandFail): CommandOutcome => ({ ok: false, reason });

function zoneFail(r: ZoneFail): CommandOutcome {
  switch (r) {
    case 'INSUFFICIENT_P': case 'INSUFFICIENT_M': case 'NOT_OWNER': case 'MAX_LEVEL': case 'BUSY':
      return fail(r);
    case 'OUT_OF_BOUNDS':
      return fail('OUT_OF_BOUNDS');
    case 'NO_RULES':
      return fail('BAD_VALUE');
    default:
      return fail('BAD_SITE');
  }
}

const finite = (p: { x: number; z: number } | undefined): boolean => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

export function applyWorks(match: Match, f: Faction, c: WorksCommand): CommandOutcome {
  const w = match.world;
  switch (c.type) {
    case 'buildZone': {
      if (!finite(c.pos)) return fail('BAD_VALUE');
      // Own or neutral ground only (the sim's ground-control field).
      const o = match.front.ownerAt(c.pos);
      if (o >= 0 && o !== f.id) return fail('BAD_SITE');
      const r = startZone(w, f, c.pos);
      return typeof r === 'string' ? zoneFail(r) : OK;
    }
    case 'upgradeZone': {
      const z = zoneById(w, c.zoneId);
      if (!z) return fail('STALE_TARGET');
      const r = upgradeZone(w, f, z);
      return r ? zoneFail(r) : OK;
    }
    case 'upgradeWork': {
      const fort = w.fortById(c.fortId);
      if (!fort || fort.hp <= 0) return fail('STALE_TARGET');
      const r = startUpgrade(w, f, fort);
      if (!r) return OK;
      return fail(r === 'NO_UPGRADE' ? 'MAX_LEVEL' : r);
    }
    case 'layMines': {
      if (!finite(c.pos) || !Number.isFinite(c.facing) || !tierRules(w)) return fail('BAD_VALUE');
      const o = match.front.ownerAt(c.pos);
      if (o >= 0 && o !== f.id) return fail('BAD_SITE');
      const m = tierRules(w)!.minefield;
      if (f.p < m.cost_p) return fail('INSUFFICIENT_P');
      if (f.m < m.cost_m) return fail('INSUFFICIENT_M');
      return startMinefield(w, f, c.pos, c.facing) ? OK : fail('BAD_SITE');
    }
  }
}
