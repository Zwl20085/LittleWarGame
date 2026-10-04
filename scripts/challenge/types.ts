// Challenge lab: shared types. A strategy is a scripted supreme HQ that plays one faction purely
// through the public command API (CommandBus.issue), like the UI would.
import type { Command } from '../../src/sim/commands';
import type { Match } from '../../src/sim/sim';
import type { Faction } from '../../src/sim/types';
import type { World } from '../../src/sim/world';

export interface ChallengeParams {
  /** Seconds after which `rush` launches its capital attack. */
  readonly rushAt: number;
}

/** What a strategy may use: the world (read-only by convention), its faction, and `issue`. */
export interface StrategyCtx {
  readonly match: Match;
  readonly world: World;
  readonly me: number;
  readonly params: ChallengeParams;
  /** Queue a command for the challenger (applied at the next tick's flush). */
  issue(cmd: Command): void;
  /** Record that the strategy launched its capital attack on `target` (first call wins). */
  markAttack(target: number): void;
  /** Free-form per-match state for the strategy. */
  readonly state: Record<string, unknown>;
}

export interface Strategy {
  readonly id: string;
  readonly summary: string;
  /** Called once before the first tick. */
  setup(ctx: StrategyCtx): void;
  /** Called once per game second. */
  tick(ctx: StrategyCtx): void;
}

export const faction = (ctx: StrategyCtx): Faction => ctx.world.factions[ctx.me];

/** Per-AI-faction defence metrics. */
export interface AiDefence {
  readonly id: number;
  readonly personality: string;
  readonly capitalDistM: number;
  firstAlarmS: number;
  firstAlarmAfterAttackS: number;
  maxLevel: number;
  /** Distinct fronts recalled home (any time) and the peak number recalled at once. */
  groupsRecalled: number;
  peakRecalled: number;
  /** Finished works within 300 m of its capital: peak count and by kind at the peak. */
  worksPeak: number;
  worksKinds: Record<string, number>;
  /** First time any of its fronts targeted the challenger's capital (targetCity / op hq:<me>), -1 = never. */
  counterAttackS: number;
  /** First time after the challenger's capital attack was launched that one of its fronts targeted the challenger's capital. */
  counterAfterAttackS: number;
  /** When the challenger first stood at its capital (hqProgress > 0, or ≥ 300 value within 600 m), -1 = never. */
  arrivalS: number;
  /** At arrival: capitalDefence() as the challenger sees it, garrison ≤ 250 m, own value ≤ 1 500 m, challenger value ≤ 600 m. */
  defenceAtArrival: number;
  garrisonAtArrival: number;
  homeValueAtArrival: number;
  attackerAtArrival: number;
  alarmActiveAtArrival: boolean;
  recalledAtArrival: number;
  /** Eligible AI infantry inside the HQ capture radius at arrival. */
  holdersAtArrival: number;
  /** Capital lost: when, and to whom (-1 = held). */
  lostS: number;
  lostTo: number;
  unitsLost: number;
  /** Share of its alive seconds with homeThreat.active, and alarm onsets. */
  alarmShare: number;
  alarmOnsets: number;
  /** Peak challenger value within 600 m of its capital after the attack (and when), max / seconds of challenger capture progress. */
  peakAttacker: number;
  peakAttackerS: number;
  maxProgress: number;
  progressS: number;
  /** Every 30 s while alive. */
  trace: TracePoint[];
}

export interface TracePoint {
  t: number;
  level: number;
  on: boolean;
  recalled: number;
  garrison: number;
  /** homeThreat.enemy (forecast attacking value) and eta. */
  forecast: number;
  eta: number;
  /** capitalDefence as the challenger sees it; challenger value within 600 / 1 500 m; own value within 1 500 m; own army; challenger army. */
  defence: number;
  att600: number;
  att1500: number;
  home1500: number;
  army: number;
  myArmy: number;
  progress: number;
  works: number;
  /** Eligible infantry of the AI / of the challenger inside the HQ capture radius (rules.victory.command_radius_m). */
  holders: number;
  raiders: number;
}

export interface CapitalEvent {
  readonly capital: number;
  readonly by: number;
  readonly t: number;
}

export interface ChallengeReport {
  readonly strategy: string;
  readonly seed: number;
  readonly challenger: number;
  readonly minutes: number;
  readonly wallS: number;
  /** When the strategy launched its capital attack (-1 = it never did), and on whom. */
  readonly attackS: number;
  readonly attackTarget: number;
  /** The AI faction whose capital is nearest the challenger's. */
  readonly nearestAi: number;
  /** Capitals the challenger took / its own capital fall (-1 = held). */
  readonly captures: CapitalEvent[];
  readonly ownLostS: number;
  readonly ownLostTo: number;
  readonly allFalls: CapitalEvent[];
  readonly ai: AiDefence[];
  readonly challengerUnitsLost: number;
  readonly challengerUnitsBuilt: number;
  /** Settlements held per faction every 5 min (index = faction). */
  readonly held: { t: number; byFaction: number[] }[];
  readonly result: { winners: number[]; reason: string; t: number } | null;
  readonly commandsIssued: number;
  readonly commandsFailed: Record<string, number>;
  /** rules.victory.command_capture_seconds / command_radius_m. */
  readonly captureSeconds: number;
  readonly captureRadiusM: number;
}
