/** 3.0 rules.json `doctrines` block: the AI supreme HQ's war doctrines (V30_SPEC §1, sim/doctrines.ts). */

/** How a doctrine turns a lead into an offensive (sim/doctrineai.ts). */
export type OffensiveMode = 'none' | 'late' | 'strike' | 'battle';

export interface DoctrineOffensiveRules {
  readonly mode: OffensiveMode;
  /** No doctrine offensive before this match time (s). */
  readonly after_s: number;
  /** strike: army fullness (pop ÷ cap) the strike force needs before it goes. */
  readonly min_fullness: number;
  /** An offensive is called off after this long (s) … */
  readonly max_s: number;
  /** … or when the army is down to break_share of its value at launch. */
  readonly break_share: number;
  /** Rest (re-arm) between two offensives (s). */
  readonly cooldown_s: number;
  /** strike: after this long consolidating, go at force_ratio instead of attack_ratio (s, 0 = never). */
  readonly force_after_s: number;
  readonly force_ratio: number;
  /** Directive between offensives once after_s has passed ('advance' or 'defend' = a compact perimeter). */
  readonly between: 'advance' | 'defend';
}

export interface DoctrineRaidTargets {
  /** Economic buildings (econwar.ts parties). */
  readonly econ: number;
  /** Convoys and the enemy rear (operations.ts raids). */
  readonly convoy: number;
  /** Seams: railways (WP-D) and engineer-built economic zones (WP-F); read once those systems exist. */
  readonly rail: number;
  readonly zone: number;
}

export interface DoctrineProfileRules {
  /** Production flavour under the doctrine (cityai personalityWeights). */
  readonly personality: 'armor' | 'infantry' | 'artillery' | 'balanced' | 'mechanized';
  /** Unit weight multipliers on top of the personality mix. */
  readonly production: Readonly<Record<string, number>>;
  /** Unit cap multipliers (production_unit_caps). */
  readonly caps: Readonly<Record<string, number>>;
  /** Investment appetite multiplier (econai.ts). */
  readonly invest: number;
  /** Occupation detachments multiplier (command.ts assignOccupations). */
  readonly occupy: number;
  /** Occupation multiplier once the strongest enemy army is below broken_ratio × ours (maneuver: towns after the battle). */
  readonly occupy_broken: number;
  readonly broken_ratio: number;
  /** Army ratio the doctrine's offensive needs (strike: vs the target's army; battle: main body vs the enemy front). */
  readonly attack_ratio: number;
  /** Directive: defend below this army ratio (ours ÷ strongest known), back above defend_exit. */
  readonly defend_below: number;
  readonly defend_exit: number;
  /** What "defend" means for this doctrine when outmatched. */
  readonly defend_kind: 'defend' | 'fortify' | 'contract';
  /** Contract (give ground) below this ratio (0 = never). */
  readonly contract_below: number;
  /** Hit-point share at which a damaged unit leaves the line to recover (rules morale.auto_retreat_hp_ratio otherwise). */
  readonly retreat_hp: number;
  /** Raid rate multiplier (1 = the 2.2 cadence) and the weight of each target kind (0 = never). */
  readonly raid_rate: number;
  readonly raid_targets: DoctrineRaidTargets;
  /** Raids also under defend / fortify directives (attrition interdicts while it holds). */
  readonly raid_on_defence: boolean;
  /** Troops per front multiplier (> 1 = fewer, denser fronts). */
  readonly front_density: number;
  /** Picket spacing multiplier (pickets.ts; < 1 = tighter pickets, > 1 = looser; absent = 1). */
  readonly picket_gap?: number;
  /** Compliance temperament bias (−0.5 … 0.5; + = bolder front commanders). */
  readonly temperament: number;
  /** Reinforcement share multiplier of the main effort (cityai.balanceReserves). */
  readonly main_share: number;
  /** Share of the faction's tanks the main front may hold under advance (armour.armourFront). */
  readonly armour_main_share: number;
  readonly offensive: DoctrineOffensiveRules;
  /** Upgrade priorities (placeholder for WP-H, unit upgrades). */
  readonly upgrades: readonly string[];
}

export interface DoctrineRules {
  readonly enabled: boolean;
  /** An enemy doctrine is shown on the faction card after the first battle with it or after reveal_s. */
  readonly reveal_s: number;
  readonly profiles: Readonly<Record<'builder' | 'blitz' | 'attrition' | 'maneuver', DoctrineProfileRules>>;
}

const IDS = ['builder', 'blitz', 'attrition', 'maneuver'] as const;
const PERSONALITIES = new Set(['armor', 'infantry', 'artillery', 'balanced', 'mechanized']);
const MODES = new Set(['none', 'late', 'strike', 'battle']);

/** Validate the doctrines block (loader.ts). Absent = doctrines off (old rules files). */
export function validateDoctrineRules(d: DoctrineRules | undefined, units: ReadonlySet<string>): void {
  if (!d) return;
  if (!(d.reveal_s >= 0)) throw new Error('rules.json: doctrines.reveal_s must be >= 0');
  for (const id of IDS) {
    const p = d.profiles?.[id];
    if (!p) throw new Error(`rules.json: doctrines.profiles.${id} is required`);
    const at = `rules.json: doctrines.profiles.${id}`;
    if (!PERSONALITIES.has(p.personality)) throw new Error(`${at}.personality is not a known personality`);
    for (const [k, v] of [...Object.entries(p.production), ...Object.entries(p.caps)]) {
      if (!units.has(k)) throw new Error(`${at}: unknown unit "${k}"`);
      if (!(v >= 0)) throw new Error(`${at}: multiplier for "${k}" must be >= 0`);
    }
    const pos = [p.invest, p.occupy, p.occupy_broken, p.attack_ratio, p.raid_rate, p.front_density, p.main_share];
    if (pos.some((x) => !(x > 0))) throw new Error(`${at}: invest / occupy / attack_ratio / raid_rate / front_density / main_share must be > 0`);
    if (!(p.defend_exit >= p.defend_below) || p.defend_below < 0) throw new Error(`${at}: defend_exit must be >= defend_below >= 0`);
    if (!(p.retreat_hp > 0 && p.retreat_hp < 1) || !(p.armour_main_share > 0 && p.armour_main_share <= 1)) throw new Error(`${at}: retreat_hp / armour_main_share out of range`);
    if (p.picket_gap !== undefined && !(p.picket_gap >= 0.3 && p.picket_gap <= 3)) throw new Error(`${at}.picket_gap must be within 0.3 … 3`);
    if (Math.abs(p.temperament) > 0.5) throw new Error(`${at}.temperament must be within ±0.5`);
    if (!MODES.has(p.offensive?.mode)) throw new Error(`${at}.offensive.mode must be none | late | strike | battle`);
    if (!(p.offensive.break_share >= 0 && p.offensive.break_share < 1)) throw new Error(`${at}.offensive.break_share must be in [0, 1)`);
  }
}
