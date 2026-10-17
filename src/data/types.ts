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
/** One engineer-built defensive building (rules.json `construction.defensive.structures`). */
export interface DefensiveStructureDef {
  /** 3.0 (V30 §8): fortress (bunker tier 3), at_emplacement (dug-in AT gun), strongpoint (capital perimeter). */
  readonly id: 'pillbox' | 'bunker' | 'fortress' | 'at_emplacement' | 'strongpoint';
  readonly label_zh: string;
  readonly cost_p: number;
  readonly cost_m: number;
  readonly work_seconds: number;
  readonly max_hp: number;
  /** Squads it holds, and how many of them may be crews (MG / AT gun). */
  readonly capacity: number;
  readonly max_crews: number;
  /** Unit ids that may garrison it. */
  readonly accepts: readonly string[];
  /** Cover level the occupants get from every direction while it stands. */
  readonly cover: 0 | 1 | 2 | 3;
  /** Built-in weapon (weapons.csv id) the occupant fires instead of its own; null = own weapon. */
  readonly weapon: string | null;
  /**
   * 2.1: firing-slit bonus to the occupants' own weapons (damage and range multipliers; a built-in
   * `weapon` is used as it is). Optional: absent = 1 / 1.
   */
  readonly fire_mul?: { readonly damage: number; readonly range: number; readonly accuracy?: number };
  /** 3.0: share of a direct hit on an occupant the building takes (default `garrison.absorb_share`; AT emplacement / fortress: armour). */
  readonly absorb_share?: number;
  /** Rear arc (deg, centred on the back) the occupants cannot fire into; 0 = none. */
  readonly blind_rear_deg: number;
  /** Blast damage multiplier for the occupants (replaces the cover level's blast factor). */
  readonly occupant_blast_mul: number;
  /** Occupants fire and observe from this much above their normal muzzle height. */
  readonly muzzle_raise_m: number;
}

/** 3.0 (V30 §8) in-place upgrade of a work by engineers (pillbox → bunker → fortress, trench → fortified trench). */
export interface WorkUpgradeDef {
  readonly from: string;
  /** Target kind; for a trench the same kind with `tier` + 1. */
  readonly to: string;
  readonly cost_p: number;
  readonly cost_m: number;
  readonly work_seconds: number;
  /** Trench tiers only: max HP multiplier and cover radius (m) of the fortified trench. */
  readonly hp_mul?: number;
  readonly cover_radius_m?: number;
}

/** 3.0 defensive works tiers, minefields and the manned-works bonus (`construction.defensive.tiers`). */
export interface DefenceTierRules {
  readonly enabled: boolean;
  readonly upgrades: readonly WorkUpgradeDef[];
  readonly minefield: {
    readonly cost_p: number;
    readonly cost_m: number;
    readonly work_seconds: number;
    /** Rectangle: `length_m` along the line, `depth_m` toward the enemy. */
    readonly length_m: number;
    readonly depth_m: number;
    /** Density: one detonation costs `charge_hp`; engineers clear `clear_hp_per_second` each. */
    readonly max_hp: number;
    readonly charge_hp: number;
    readonly clear_hp_per_second: number;
    readonly vehicle_speed_mul: number;
    /** Chance per second a hostile vehicle inside sets off a mine, and the damage (× its max HP). */
    readonly trigger_chance_per_second: number;
    readonly damage_ratio: number;
  };
  readonly manned: {
    /** Observation range added for occupants of a finished work (m), and whether they spot for artillery. */
    readonly observation_bonus_m: number;
    readonly artillery_spotting: boolean;
  };
}

/** 3.0 absolute defence perimeter (绝对国防圈) and the capital observation ring (V23 §1.3, V30 §8). */
export interface CapitalDefenceRules {
  readonly enabled: boolean;
  readonly radius_m: number;
  readonly strongpoints: number;
  /** Fixed crew (units.csv id) bound into each strongpoint, and the capital's artillery position. */
  readonly crew_unit: string;
  readonly artillery_unit: string;
  readonly artillery_back_m: number;
  /** A dead crew is replaced after this when its strongpoint stands at ≥ `crew_min_hp_ratio` and no enemy is within `quiet_m`. */
  readonly crew_respawn_seconds: number;
  readonly crew_min_hp_ratio: number;
  readonly quiet_m: number;
  /** Engineers restore this much HP per second each. */
  readonly repair_hp_per_second: number;
  readonly observation: { readonly enabled: boolean; readonly radius_m: number };
}

/** 3.0 engineer-built economic zones (经济区, V30 §7): one entry per level 1..3. */
export interface EconZoneLevelDef {
  readonly cost_p: number;
  readonly cost_m: number;
  readonly work_seconds: number;
  readonly max_hp: number;
  readonly p_per_min_k: number;
  readonly m_per_min_k: number;
}

export interface EconZoneRules {
  readonly enabled: boolean;
  readonly levels: readonly EconZoneLevelDef[];
  /** Clearance (m) beyond a town / city's radius, a village's radius, and a capital (+100). */
  readonly min_town_distance_m: number;
  readonly min_village_distance_m: number;
  readonly min_zone_distance_m: number;
  /** Hostile ground at least this far away to start a zone. */
  readonly min_enemy_distance_m: number;
  /** Output share without a road link to an own town. */
  readonly unlinked_output: number;
  /** A zone within this of a road counts as on it (fallback road test until roadnet lands). */
  readonly road_link_m: number;
  readonly captured_hp_ratio: number;
  readonly rebuild_cost_ratio: number;
  readonly max_per_faction: number;
  /** Engineers working one zone job. */
  readonly builders: number;
}

export interface DefensiveRules {
  readonly structures: readonly DefensiveStructureDef[];
  readonly tiers?: DefenceTierRules;
  readonly garrison: {
    /** A stopped eligible squad this close to a finished building with room enters it. */
    readonly enter_radius_m: number;
    /** An occupant moved farther than this from it has left. */
    readonly leave_radius_m: number;
    /** Holding troops look for an empty building this far away. */
    readonly seek_radius_m: number;
    /** Share of a direct hit on an occupant that the building takes instead (small arms: absorbed, no structural damage). */
    readonly absorb_share: number;
    /** On collapse the occupants are thrown out with this suppression and this share of max HP as damage. */
    readonly collapse_suppression: number;
    readonly collapse_damage_ratio: number;
  };
}

export type PlaceKind = 'capital' | 'city' | 'town';
export type EconKind = 'factory' | 'recruit' | 'depot';

export interface LogisticsRules {
  readonly ammo_cost_multiplier: number;
  readonly stock_cap_k: Record<PlaceKind, number>;
  readonly initial_stock_ratio: number;
  readonly draw_radius_m: Record<PlaceKind, number>;
  readonly rearm_per_second: number;
  readonly crowd_free: number;
  readonly crowd_penalty: number;
  readonly place_handover_per_second_k: number;
  readonly convoy_area_cell_m: number;
  readonly convoy_area_cap_per_second_k: number;
  readonly rearm_below: number;
  readonly rearm_until: number;
  readonly truck_seek_radius_m: number;
  readonly stock_seek_radius_m: number;
  readonly contested_refund_seconds: number;
  /**
   * 2.2 wave 2: a place refills at most this × its share (cap ÷ the faction's total cap) of the
   * logistics flow per second — a drained front town no longer soaks up the whole flow. Absent = no limit.
   */
  readonly place_fill_burst?: number;
  /** 2.2 wave 2: the steward asks for logistics while the stocks are below this share of their caps (absent = 2.1 demand rule). */
  readonly steward_stock_target?: number;
  /**
   * 2.2 supply round: a unit that fired within this many seconds draws from a place only inside its
   * core (the settlement radius × draw_core_ratio: the town's defenders), and takes nothing from a
   * truck — rearming is a pause in the fight, not a trickle while shooting. Absent = no rule.
   */
  readonly draw_contact_seconds?: number;
  readonly draw_core_ratio?: number;
  /** Convoy truck: cargo carried and cargo handed over per second (absent = convoy.ts defaults 40 / 8). */
  readonly truck_capacity?: number;
  readonly truck_unload_per_second?: number;
  /** Convoy truck hand-over radius (m; absent = convoy.ts default 190): units come to the truck. */
  readonly truck_handover_radius_m?: number;
}

export interface EconBuildingRules {
  readonly cost_p: number;
  readonly cost_m: number;
  readonly build_seconds: number;
  readonly max_hp: number;
  readonly m_per_min_k: number;
  readonly p_per_min_k: number;
  readonly stock_cap_k?: number;
  readonly fill_per_min_k?: number;
}

export interface EconRules {
  readonly slots: Record<string, number>;
  readonly captured_hp_ratio: number;
  readonly rebuild_cost_ratio: number;
  readonly demolish_hp_per_second: Record<'engineer' | 'infantry' | 'vehicle', number>;
  readonly demolish_radius_m: number;
  readonly buildings: Record<EconKind, EconBuildingRules>;
}

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
  /** 2.2 settlement supply stocks, gradual rearming, crowding (V22_SPEC §3; optional for old rule sets). */
  readonly logistics?: LogisticsRules;
  /** 2.2 economic buildings (V22_SPEC §5). */
  readonly econ?: EconRules;
  /** 3.0 economic zones (V30 §7). */
  readonly econ_zones?: EconZoneRules;
  /** 3.0 absolute defence perimeter + capital observation ring (V30 §8). */
  readonly capital_defence?: CapitalDefenceRules;
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
  /** 2.0 command hierarchy: supreme HQ orders executed by front commander units (docs/COMMAND_V2.md). */
  readonly command: {
    /** Unit id of the front commander (appointed by the supreme HQ, never produced). */
    readonly commander_unit: string;
    readonly fronts_initial: number;
    readonly fronts_max: number;
    /** A lost commander is replaced after this long; until then the front holds without cohesion. */
    readonly commander_respawn_seconds: number;
    readonly commander_lost_hold_seconds: number;
    /** The commander posts at the nearest own settlement within this of the front's line. */
    readonly commander_post_radius_m: number;
    /** Squads always kept at the capital, and the works its engineers build there early (user rule). */
    readonly capital_standing_garrison: number;
    readonly capital_line_works: Record<string, number>;
  };
  /** Engineer construction; `defensive` = 2.0 pillboxes / bunkers (structures.ts, BALANCE_SPEC §10). */
  readonly construction: {
    readonly defensive: DefensiveRules;
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
