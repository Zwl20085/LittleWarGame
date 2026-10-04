/**
 * Adaptive strategy layer, tuned from the strategy lab (docs/STRATEGY_LAB.md, scripts/strategy.ts).
 * Each constant cites the measurement that motivated it. `adaptive` exists so the lab can A/B
 * the same code with the layer off (`--baseline`); the game always runs with it on.
 */
export const STRATEGY_AI = {
  adaptive: true,
  /** Round 2 eagerness layer (EAGER below); only active with `adaptive`. Off = round-1 behaviour, for A/B. */
  eager: true,
  /** Round 3 home defence and fortification (homeguard.ts); only active with `eager`. Off = round-2 all-or-nothing recall, for A/B. */
  homeDefence: true,
  /** Round 4: capital siege-and-storm, recall spares assaults, crew weapons deploy where the fighting is (storm.ts, crewai.ts). Off = round 3, for A/B. */
  storm: true,
  /** 2.0: the AI supreme HQ's dynamic fronts and orders (theatre.ts). Off = the opening fronts stay and pick their own objectives (1.x), for A/B. */
  theatre: true,
};

export const ADAPT = {
  /**
   * Frontal attacks on lightly held targets were the least productive op: 0.05 captures per
   * group-minute vs 0.10 pincer / 0.07 infiltrate / 0.05 flank, 22 % success (baseline, 6 seeds).
   * When the target's known defenders are below this share of the group, frontal loses score.
   */
  unopposedShare: 0.25,
  frontalUnopposedPenalty: 0.45,
  /** 22 % of all ops launched with too few free troops ('noForce', 206 of 945): only pick launchable ops. */
  requireLaunchable: true,
  /** Pincers that failed to form are not re-tried for this long (pincer churn: 128 noForce, mean 22 s). */
  pincerRetryS: 90,
  /** Siege only with numbers: group value ≥ this × the defenders (baseline sieges: 1 of 4 won). */
  siegeMinRatio: 1.5,
  /**
   * Abort hopeless assaults: 'timeout' + 'spent' ops cost 1 000–1 200 value each and won nothing.
   * After `abortGraceS` in the assault, if the group is down to `abortLeft` of its start value and
   * the defenders outweigh what is left by `abortRatio`, call it off.
   */
  abortGraceS: 45,
  abortLeft: 0.6,
  abortRatio: 1.2,
  /**
   * Front push threshold (local ratio) for cautious groups. Lab experiment 1.4 → 1.2 (8 seeds):
   * +15 units lost per match for no clear capture gain (captures / 100 lost +2 vs +10 without it),
   * so it stays at the baseline 1.4 (assault posture keeps 1.0).
   */
  pushRatio: 1.4,
  /** Routed / pinned enemies count at this weight when a group decides whether to push (exploit routs). */
  brokenEnemyWeight: 0.35,
  /** Occupy detachments: 31 % expired after the fixed 240 s; budget the march by distance instead. */
  occupyBaseS: 120,
  occupySecondsPerM: 0.28,
  /** Undefended enemy villages / points (no known enemy within the threat radius) can be occupied too. */
  occupyEnemyHeld: true,
} as const;

/**
 * Round 2 (docs/STRATEGY_LAB.md "Round 2: eagerness and engagement"). Balance lab, 3 seeds × 30 min:
 * 7 % of combat units firing, groups in `hold` 60–74 % of the time, howitzers in `rally` 60–72 %
 * of the time and value killed / spent 0.06, occupation capped at 3 × 3 units whatever the army.
 */
export const EAGER = {
  /** Army fullness (pop / popCap) where the commander starts to feel "too many idle troops" (0) … fully (1). */
  fullLo: 0.6,
  fullHi: 0.85,
  /** Known own ÷ strongest neighbour army value: 0 at `relLo`, 1 at `relHi`. */
  relLo: 0.7,
  relHi: 1.3,
  /** Line units that have not fired for this long count as idle. */
  idleS: 30,
  /** Replacement time (army value ÷ income per min) where territory becomes urgent: 0 at lo, 1 at hi. */
  rebuildLo: 8,
  rebuildHi: 24,
  /** Occupation: base detachments, one more per this many free occupiers (× (0.5 + need)), hard cap. */
  occupyBase: 3,
  occupyPerUnits: 8,
  occupyCap: 10,
  /** Unescorted occupation needs this much distance to enemy ground, minus `occupySafeNeedCut` × need. */
  occupySafeDist: 220,
  occupySafeNeedCut: 20,
  /** Extra march budget for occupation detachments (more, smaller detachments expired 33 % vs 19 %). */
  occupyExtraS: 60,
  /** Aggression ≥ these: the main group / every attacking group takes the assault posture (cityai). */
  assaultMain: 0.35,
  assaultAll: 0.7,
  /** Push threshold for cautious groups falls from ADAPT.pushRatio by this × aggression. */
  pushAggressionCut: 0.3,
  /** Holding costs: after this long in `hold`, with the whole group ≥ `holdPushRatio` × the enemy at the anchor and aggression > 0, push. */
  holdPatienceS: 60,
  holdPushRatio: 1.5,
  /** Schwerpunkt: share of the line massed on the axis toward the target (rest screens the segment). */
  massShare: 0.5,
  massShareAggr: 0.3,
  /** Screen only the stretches of the front with known enemies within this radius. */
  activeRadius: 300,
  /** Holding line leans forward by this × aggression (from 35 m behind the contact cells). */
  holdLeanAggr: 45,
  /** Frontal attacks mass first: this share of the mass within `massRadius` of the anchor, or `massWaitS`. */
  frontalMassShare: 0.6,
  massRadius: 260,
  massWaitS: 50,
  /** Mountain passes on the way to a target (13–36 % op success vs 64–80 % open) cost this much score. */
  passPenalty: 0.35,
  /** Decisive offensive (command.ts chooseFinishTarget): dominant = held share ≥ this, or fullness ≥ `dominantFull` with stock ≥ `dominantStock` of the caps. */
  dominantShare: 0.27,
  /** …or a ready army: aggression ≥ this with fullness ≥ `finishFullness`. */
  finishAggression: 0.6,
  finishFullness: 0.65,
  dominantFull: 0.9,
  dominantStock: 0.6,
  /** A broken enemy (≤ `brokenHeld` places and we hold `brokenLead` × as many, or army < `brokenArmy` × ours) is finished off by anyone with fullness ≥ fullLo. */
  brokenHeld: 6,
  brokenLead: 4,
  brokenArmy: 0.4,
  finishKeepS: 120,
  /** Round 4: our population ≥ this × an enemy's → finish it now (lead: a 2–4× richer side should roll over). */
  dwarfPop: 2,
  finishSpearheadM: 2200,
  /** Local ratio for a spearhead toward the target capital (2.2 otherwise), every 60 s instead of 120 s. */
  finishSpearRatio: 1.3,
  /** 2.0 attack-side round: local ratio for an ordinary spearhead (was a fixed 2.2), every `spearEveryS`. */
  spearRatio: 2.2,
  spearEveryS: 120,
  /** An armoured / motorized front (≥ armorSpearMobile fresh tanks + motor_inf free for the thrust) breaks through at this ratio, every armorSpearEveryS. */
  armorSpearRatio: 1.5,
  armorSpearMobile: 3,
  armorSpearEveryS: 75,
  /** Spearhead size: this share of the front (tanks and motorized first), at least 4. */
  spearShare: 0.3,
  /** Guns deploy this × range behind the group's line and at least this far from enemy ground (was 0.55 / 0.6 and 300 / 180 m). */
  /** Rear guard share while no convoy was hit for `rearGuardAlertS` (OPS.rearGuardShare 0.1 otherwise). */
  rearGuardQuiet: 0.04,
  rearGuardAlertS: 90,
  howitzerBack: 0.35,
  mortarBack: 0.3,
  howitzerSafe: 180,
  mortarSafe: 100,
} as const;

export const adaptive = (): boolean => STRATEGY_AI.adaptive;
export const eagerOn = (): boolean => STRATEGY_AI.adaptive && STRATEGY_AI.eager;
export const stormOn = (): boolean => eagerOn() && STRATEGY_AI.storm;
