export type UnitKind = 'infantry' | 'crew' | 'vehicle';
export type Facility = 'barracks' | 'vehicle' | 'support';
export type FireMode = 'hitscan' | 'direct_projectile' | 'ballistic';

export interface UnitDef {
  readonly id: string;
  readonly labelZh: string;
  readonly kind: UnitKind;
  readonly facility: Facility;
  readonly costP: number;
  readonly costM: number;
  readonly population: number;
  readonly supplyDemand: number;
  readonly buildSeconds: number;
  readonly unlockSeconds: number;
  readonly maxHp: number;
  readonly memberCount: number;
  readonly speed: number;
  readonly vision: number;
  readonly primaryWeapon: string | null;
  readonly secondaryWeapon: string | null;
  readonly armorFront: number;
  readonly armorSide: number;
  readonly armorRear: number;
  readonly maxSlopeDeg: number;
  readonly hullTurnDegps: number;
  readonly turretTurnDegps: number;
  readonly setupSeconds: number;
  readonly packSeconds: number;
}

export interface WeaponDef {
  readonly id: string;
  readonly labelZh: string;
  readonly fireMode: FireMode;
  readonly range: number;
  readonly minRange: number;
  readonly interval: number;
  readonly damage: number;
  readonly penetration: number;
  readonly accuracy: number;
  readonly blastRadius: number;
  readonly suppression: number;
  readonly canFireMoving: boolean;
  readonly ammoCost: number;
  readonly muzzleSpeed: number;
  readonly minElevationDeg: number;
  readonly maxElevationDeg: number;
}

/** Shape of docs/data/rules.json (only the fields the sim reads are typed strictly). */
export interface Rules {
  readonly proposed_defaults: {
    readonly army_scale?: number;
    readonly army_scale_resolve_factor?: number;
    readonly army_scale_stock_factor?: number;
    readonly army_scale_income_factor?: number;
    readonly tempo_move_multiplier?: number;
    readonly tempo_damage_multiplier?: number;
    readonly production_unit_weights: Record<string, number>;
    readonly production_unit_caps: Record<string, number>;
    readonly sector_reinforcement_shares: number[];
    readonly match_seconds_limit: number;
  };
  readonly simulation: {
    readonly tick_hz: number;
    readonly gravity_mps2: number;
    readonly speeds: number[];
  };
  readonly economy: {
    readonly starting_p: number;
    readonly starting_m: number;
    readonly cap_p: number;
    readonly cap_m: number;
    readonly population_cap: number;
    readonly allocation_default: [number, number, number];
    readonly base_income_p_per_min: number;
    readonly base_income_m_per_min: number;
    readonly allocated_income_per_min: number;
    readonly logistics_base: number;
    readonly logistics_per_allocation: number;
    readonly production_efficiency_base: number;
    readonly production_efficiency_per_industry: number;
    readonly facilities: Record<string, number>;
    readonly auto_min_allocation: number;
    readonly auto_max_step: number;
    readonly auto_hold_seconds: number;
    readonly protected_order_seconds: number;
    readonly spending_window_seconds: number;
    readonly spending_reference_value: number;
    readonly cancel_started_refund_ratio: number;
    readonly node_p_per_min: number;
    readonly node_m_per_min: number;
    readonly node_return_factors: number[];
    readonly node_p_bonus_cap: number;
    readonly node_m_bonus_cap: number;
    readonly node_activation_seconds: number;
    readonly initial_units: Record<string, number>;
  };
  readonly territory?: {
    readonly capital_income_share: number;
    readonly income_p_per_min: Record<string, number>;
    readonly income_m_per_min: Record<string, number>;
    readonly capture_seconds: Record<string, number>;
    readonly capital_slots: Record<string, number>;
    readonly place_slots: Record<string, Record<string, number>>;
    readonly initial_radius_m: number;
    readonly capital_pop_share?: number;
    /** Ceiling of the territory-driven population cap, as a multiple of `economy.population_cap`. */
    readonly pop_cap_max_multiplier?: number;
    readonly pop_per_place?: Record<string, number>;
    readonly resolve_loss_on_capture?: Record<string, number>;
    readonly depot_efficiency_falloff_m?: number;
    readonly depot_min_efficiency?: number;
    readonly collapse_bleed_per_second?: number;
  };
  readonly victory: {
    /** false (default since 2026-10-02): no resolve; defeat only by losing the capital. */
    readonly resolve_enabled?: boolean;
    readonly initial_resolve: number;
    readonly destroyed_population_resolve_multiplier: number;
    readonly majority_control_enemy_bleed_per_second: number;
    readonly point_radius_m: number;
    readonly point_capture_seconds: number;
    readonly command_radius_m: number;
    readonly command_capture_seconds: number;
    readonly command_defender_decay_progress_seconds_per_second: number;
    readonly command_empty_decay_progress_seconds_per_second: number;
    readonly eligible_capture_hp_ratio: number;
    readonly eliminated_evacuation_seconds: number;
    /** Enemy combat units within this distance of the capital stop its roll-outs (besieged). */
    readonly siege_blocks_production_radius_m?: number;
  };
  readonly supply: {
    readonly city_local_radius_m: number;
    readonly relay_max_path_m: number;
    readonly truck_local_radius_m: number;
    readonly ammo_regeneration_per_second: number;
    readonly main_sector_priority: number;
    readonly low_ammo_threshold: number;
    readonly critical_ammo_threshold: number;
    readonly low_ammo_interval_multiplier: number;
    readonly critical_ammo_interval_multiplier: number;
    readonly empty_vehicle_speed_multiplier: number;
    readonly city_recovery_radius_m: number;
    readonly truck_recovery_radius_m: number;
    readonly infantry_hp_recovery_ratio_per_second: number;
    readonly vehicle_hp_recovery_ratio_per_second: number;
    readonly return_hp_ratio: number;
    readonly return_morale: number;
    readonly return_ammo_ratio: number;
  };
  readonly morale: {
    readonly suppression_enter: number;
    readonly suppression_exit: number;
    readonly pinned_enter: number;
    readonly pinned_exit: number;
    readonly wavering_enter: number;
    readonly wavering_exit: number;
    readonly routing_enter: number;
    readonly routing_exit: number;
    readonly suppression_decay_delay_seconds: number;
    readonly suppression_decay_per_second: number;
    readonly safe_morale_regen_per_second: number;
    readonly city_morale_regen_per_second: number;
    readonly auto_retreat_hp_ratio: number;
  };
  readonly information: { readonly enemy_memory_seconds: number };
  readonly manual_control: {
    readonly move_completion_radius_m: number;
    readonly move_completion_hold_seconds: number;
    readonly attack_move_clear_radius_m: number;
    readonly attack_move_clear_seconds: number;
    readonly focus_max_seconds: number;
    readonly max_queued_commands: number;
  };
}

export interface GameData {
  readonly units: ReadonlyMap<string, UnitDef>;
  readonly weapons: ReadonlyMap<string, WeaponDef>;
  readonly rules: Rules;
  readonly unitOrder: readonly string[];
}
