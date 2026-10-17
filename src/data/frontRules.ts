/** 3.0 rules.json blocks for fronts (`fronts`) and directive compliance (`command.compliance`), V30_SPEC §5–6. */

/** One command tier of a front (≥ min_units combat units). Bonuses are fractions (0.05 = +5 %). */
export interface FrontTierRule {
  readonly min_units: number;
  /** Less morale lost to suppression and damage. */
  readonly morale: number;
  /** Hit probability multiplier − 1. */
  readonly accuracy: number;
  readonly supply_weight: number;
  readonly reinforce_weight: number;
}

export interface FrontRules {
  /** Perf guard only: the theatre opens no front beyond this many (no gameplay cap). */
  readonly soft_max: number;
  readonly tiers_enabled: boolean;
  readonly tiers: readonly FrontTierRule[];
  readonly hysteresis_units: number;
  readonly barrage_radius_m: number;
  readonly barrage_bonus: number;
  readonly barrage_search_m: number;
  readonly stretched_units_per_100m: number;
  readonly stretched_min_line_m: number;
  readonly stretched_accuracy: number;
  readonly stretched_morale: number;
  readonly units_per_front: number;
  readonly frontage_m_per_front: number;
  readonly stray_m: number;
  readonly stray_cell_m: number;
  readonly merge_below_units: number;
  readonly merge_after_s: number;
  readonly fronts_per_think_tick: number;
}

export interface ComplianceRules {
  readonly enabled: boolean;
  readonly base: number;
  readonly proximity_weight: number;
  readonly near_m: number;
  readonly far_m: number;
  readonly temperament_weight: number;
  readonly risk_weight: number;
  readonly ratio_ok: number;
  readonly ratio_bad: number;
  readonly expose_m: number;
  readonly expose_r: number;
  readonly expose_ratio: number;
  readonly expose_risk: number;
  readonly low_ammo: number;
  readonly ammo_risk: number;
  readonly assault_ratio: number;
  readonly assault_risk: number;
  readonly hysteresis: number;
  readonly delay_s_per_km: number;
  readonly delay_min_s: number;
  readonly delay_max_s: number;
}

/** Validate the 3.0 blocks (loader.ts): fail fast with a clear message. */
export function validateFrontRules(fronts: FrontRules | undefined, threshold: number | undefined, c: ComplianceRules | undefined): void {
  if (!fronts) throw new Error('rules.json: fronts block is required');
  if (!(fronts.soft_max >= 1)) throw new Error('rules.json: fronts.soft_max must be >= 1');
  let prev = 0;
  for (const t of fronts.tiers ?? []) {
    if (!(t.min_units > prev)) throw new Error('rules.json: fronts.tiers must have increasing min_units > 0');
    if (!(t.supply_weight > 0) || !(t.reinforce_weight > 0) || t.morale < 0 || t.morale >= 1 || t.accuracy < 0) throw new Error('rules.json: fronts.tiers bonus out of range');
    prev = t.min_units;
  }
  if (!(fronts.units_per_front > 0) || !(fronts.frontage_m_per_front > 0) || !(fronts.fronts_per_think_tick >= 1)) throw new Error('rules.json: fronts.units_per_front / frontage_m_per_front / fronts_per_think_tick must be > 0');
  if (!(threshold !== undefined && threshold >= 0 && threshold <= 1)) throw new Error('rules.json: command.compliance_threshold must be in [0, 1]');
  if (!c || !(c.far_m > c.near_m) || !(c.ratio_bad > c.ratio_ok) || c.delay_max_s < c.delay_min_s) throw new Error('rules.json: command.compliance invalid (far_m > near_m, ratio_bad > ratio_ok, delay_max_s >= delay_min_s)');
}
