import type { EconKind } from '../data/types';
import type { Match } from './sim';
import { applyWorks } from './worksCommands';
import type { DirectiveKind } from './types';
import type { V2 } from './vec';
import {
  applyBuildEcon, applyCancelOrder, applyQueueUnit, applyResetAlloc, applySetAlloc, applySetAuto, applySetAutoInvest,
  applySetCap, applySetLock, applySetWeight, applyTogglePause,
} from './commands/production';
import { applyCancelZone, applySetDirective } from './commands/directive';
import { applyFocus, applyUnitOrder } from './commands/units';
import { applyBuildRoad, applyExtendRail, applyRepairRail } from './commands/transport';
import { applyCancelResearch, applyResearch } from './commands/upgrades';
import { applySetAutoCommand, applySetAutoEngineering, applySetAutoResearch } from './commands/auto';
import { fail } from './commands/shared';

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
  /** 3.0.1: the HQ staff run research / engineering / the directive for the player (default on; off = take over). */
  | { type: 'setAutoResearch'; on: boolean }
  | { type: 'setAutoEngineering'; on: boolean }
  | { type: 'setAutoCommand'; on: boolean }
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
  /** 3.0: found an economic zone at a point / raise or rebuild one (econZones.ts); upgrade a work or lay a minefield (worksTiers.ts). */
  | { type: 'buildZone'; pos: V2 }
  | { type: 'upgradeZone'; zoneId: number }
  | { type: 'upgradeWork'; fortId: number }
  | { type: 'layMines'; pos: V2; facing: number }
  | { type: 'unitOrder'; unitIds: number[]; order: 'move' | 'moveHold' | 'attackMove' | 'retreat' | 'hold' | 'resume'; pos?: V2; queue?: boolean }
  | { type: 'focus'; unitIds: number[]; targetId: number }
  /** 3.0 unit upgrades: pay for and start researching an item at the capital; cancel the research under way. */
  | { type: 'research'; upgradeId: string }
  | { type: 'cancelResearch' }
  /** 3.0 engineers: lay a road a -> b (<= road_job.max_len_m; bridges short gaps). */
  | { type: 'buildRoad'; a: V2; b: V2 }
  /** 3.0 engineers: rebuild a cut rail line the faction holds at both ends. */
  | { type: 'repairRail'; lineId: number }
  /** 3.0 engineers: extend the rail from own station `stationIdx` to own town / city `to` (objective index). */
  | { type: 'extendRail'; stationIdx: number; to: number };

export type CommandFail =
  | 'FACTION_DEAD' | 'NOT_OWNER' | 'STALE_TARGET' | 'UNREACHABLE' | 'BAD_VALUE' | 'ROUTING'
  | 'LOCKED' | 'INSUFFICIENT_M' | 'INSUFFICIENT_P' | 'OUT_OF_BOUNDS' | 'NO_ORDER' | 'NO_FRONT' | 'NO_SLOT' | 'CONTESTED'
  | 'LINE_SHORT' | 'LINE_ONLY_FORTIFY' | 'BAD_SITE' | 'MAX_LEVEL' | 'BUSY'
  | 'TOO_LONG' | 'BAD_TERRAIN' | 'NOT_CUT' | 'JOB_BUSY' | 'NOT_HELD' | 'HAS_STATION' | 'TRANSPORT_OFF'
  | 'DISABLED' | 'OWNED' | 'RESEARCH_BUSY' | 'NO_RESEARCH';

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

/** Validates and dispatches one command to its handler module (src/sim/commands/*.ts); validation order is per handler. */
function apply(match: Match, env: CommandEnvelope): CommandOutcome {
  const f = match.world.factions[env.actor];
  if (!f || !f.alive) return fail('FACTION_DEAD');
  const c = env.cmd;
  const actor = env.actor;
  switch (c.type) {
    case 'setWeight': return applySetWeight(match, f, c);
    case 'setCap': return applySetCap(match, f, c);
    case 'togglePause': return applyTogglePause(match, f, c);
    case 'queueUnit': return applyQueueUnit(match, f, c, actor);
    case 'buildEcon': return applyBuildEcon(match, f, c);
    case 'buildZone':
    case 'upgradeZone':
    case 'upgradeWork':
    case 'layMines':
      return applyWorks(match, f, c);
    case 'cancelOrder': return applyCancelOrder(match, f, c);
    case 'research': return applyResearch(match, f, c);
    case 'cancelResearch': return applyCancelResearch(match, f);
    case 'setAlloc': return applySetAlloc(f, c);
    case 'setAutoInvest': return applySetAutoInvest(match, f, c);
    case 'setAuto': return applySetAuto(f, c);
    case 'setAutoResearch': return applySetAutoResearch(f, c);
    case 'setAutoEngineering': return applySetAutoEngineering(f, c);
    case 'setAutoCommand': return applySetAutoCommand(f, c);
    case 'setLock': return applySetLock(f, c);
    case 'resetAlloc': return applyResetAlloc(match, f);
    case 'setDirective': return applySetDirective(match, f, c);
    case 'cancelZone': return applyCancelZone(f, c);
    case 'unitOrder': return applyUnitOrder(match, c, actor);
    case 'buildRoad': return applyBuildRoad(match, c, actor);
    case 'repairRail': return applyRepairRail(match, c, actor);
    case 'extendRail': return applyExtendRail(match, c, actor);
    case 'focus': return applyFocus(match, c, actor);
  }
}
