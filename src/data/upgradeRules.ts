/** rules.json `upgrades` (3.0 unit upgrades, V30_SPEC §9, docs/UPGRADES.md). */
export interface UpgradeItemRules {
  /** Price at army_scale × army_scale_income_factor = 1 (multiplied by that product in play). */
  readonly p_k: number;
  readonly m_k: number;
  /** Research time at the capital (s). */
  readonly seconds: number;
  /** Items that must be owned first (armour II needs armour I …). */
  readonly requires?: readonly string[];
}

export interface UpgradeEffectRules {
  /** Armour-piercing grenades: close-in hit on a vehicle. */
  readonly ap_grenade: {
    readonly range_m: number;
    readonly interval_s: number;
    readonly damage: number;
    readonly penetration: number;
    readonly ammo_cost: number;
  };
  /** Per armour level: armour plates ×(1+armour), hit points ×(1+hp), speed ×(1+speed). */
  readonly armour_per_level: { readonly armour: number; readonly hp: number; readonly speed: number };
  /** Per gun level: penetration +pen, damage ×(1+damage), range ×(1+range). */
  readonly gun_per_level: { readonly pen: number; readonly damage: number; readonly range: number };
  readonly arty_range_mul: number;
  readonly truck_capacity_mul: number;
  readonly eng_build_mul: number;
  /** Front tier thresholds × this with the staff upgrade. */
  readonly staff_threshold_mul: number;
}

export interface UpgradeAiRules {
  readonly enabled: boolean;
  readonly think_seconds: number;
  /** No AI research before this match time (s). */
  readonly start_s: number;
  /** Stock kept back after paying (× army_scale × income factor). */
  readonly reserve_p_k: number;
  readonly reserve_m_k: number;
  /** Total income (P + M per minute, × the same scale) below which the AI does not research. */
  readonly income_floor_k: number;
  /** Income must not have fallen by more than this share over the last trend window. */
  readonly trend_drop: number;
  readonly trend_window_s: number;
  /** Share of income set aside for the wanted item while the AI is eligible. */
  readonly fund_share: number;
}

export interface UpgradeRules {
  readonly enabled: boolean;
  /** Each owned upgrade makes the next one dearer by this share (rising costs). */
  readonly escalation: number;
  /** Share of the price returned when a research is cancelled. */
  readonly cancel_refund_ratio: number;
  readonly items: Readonly<Record<string, UpgradeItemRules>>;
  readonly effects: UpgradeEffectRules;
  readonly ai: UpgradeAiRules;
}
