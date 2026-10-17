/** 3.0 rules.json `infiltration` block (V30_SPEC §11, WP-E): zone of control, pickets, rear screen and hunts. */
export interface InfiltrationRules {
  /** Master switch (the lab A/B flag `INFILTRATION_AB.on` also has to be on). */
  readonly enabled: boolean;
  /** Zone of control: an enemy within zoc_m of a front's line unit moves at zoc_speed_mul for zoc_hold_s and is revealed / engaged. */
  readonly zoc_m: number;
  readonly zoc_speed_mul: number;
  readonly zoc_hold_s: number;
  /** Crossing the segment between two own line units closer than contact_gap_m is a line crossing (contact). */
  readonly contact_gap_m: number;
  /** A line unit chases an intruder in its zone of control at most engage_leash_m from where it stood, for engage_s; at most engage_per_intruder of them. */
  readonly engage_leash_m: number;
  readonly engage_s: number;
  readonly engage_per_intruder: number;
  /** Pickets: spare infantry spread along the front's stretch at <= picket_gap_m x picket_tier_mul[tier], at most picket_max_share of its infantry. */
  readonly picket_gap_m: number;
  readonly picket_tier_mul: readonly number[];
  readonly picket_max_share: number;
  readonly picket_lean_m: number;
  /** Reaction group: reaction_share of the front's combat units (motorized first, then tanks), reaction_back_m behind the line. */
  readonly reaction_share: number;
  readonly reaction_min_units: number;
  readonly reaction_max_units: number;
  readonly reaction_back_m: number;
  readonly reaction_leash_m: number;
  /** Rear reports: a known enemy report_depth_m inside the line, away from its own line units (report_isolated_m). */
  readonly report_depth_m: number;
  readonly report_isolated_m: number;
  readonly report_min_value: number;
  readonly report_cluster_m: number;
  readonly report_match_m: number;
  readonly report_forget_s: number;
  /** Hunters + screens of a faction at most this share of its combat units. */
  readonly response_max_share: number;
  /** Rear screen: own towns / cities / economic towns / the capital within screen_radius_m of a report get squads. */
  readonly screen_radius_m: number;
  readonly screen_squads_town: number;
  readonly screen_squads_city: number;
  readonly screen_max_places: number;
  readonly screen_pick_m: number;
  readonly screen_hold_s: number;
  readonly screen_post_m: number;
  /** Hunt: the nearest free units within hunt_radius_m until hunt_ratio x the report's value (at most hunt_max_units), for hunt_max_s. */
  readonly hunt_radius_m: number;
  readonly hunt_ratio: number;
  readonly hunt_max_units: number;
  readonly hunt_max_s: number;
  /** A far chase keeps its aim (the report position on the 128 m field lattice) at most this long while the target stays within 150 m of it. */
  readonly hunt_repath_s: number;
}

/** Validate the block (loader.ts): fail fast with a clear message. */
export function validateInfiltrationRules(r: InfiltrationRules | undefined): void {
  if (!r) throw new Error('rules.json: infiltration block is required');
  const pos = ['zoc_m', 'zoc_hold_s', 'contact_gap_m', 'engage_leash_m', 'engage_s', 'picket_gap_m', 'reaction_back_m', 'reaction_leash_m',
    'report_cluster_m', 'report_match_m', 'report_forget_s', 'screen_radius_m', 'screen_pick_m', 'hunt_radius_m', 'hunt_max_s', 'hunt_repath_s'] as const;
  for (const k of pos) if (!(r[k] > 0)) throw new Error(`rules.json: infiltration.${k} must be > 0`);
  if (!(r.zoc_speed_mul > 0 && r.zoc_speed_mul <= 1)) throw new Error('rules.json: infiltration.zoc_speed_mul must be in (0, 1]');
  if (!(r.picket_max_share >= 0 && r.picket_max_share <= 1) || !(r.reaction_share >= 0 && r.reaction_share <= 1)) throw new Error('rules.json: infiltration shares must be in [0, 1]');
  if (!Array.isArray(r.picket_tier_mul) || r.picket_tier_mul.length === 0 || r.picket_tier_mul.some((m) => !(m > 0))) throw new Error('rules.json: infiltration.picket_tier_mul must be a list of positive factors');
  if (!(r.response_max_share >= 0 && r.response_max_share <= 1)) throw new Error('rules.json: infiltration.response_max_share must be in [0, 1]');
  if (!(r.reaction_max_units >= r.reaction_min_units)) throw new Error('rules.json: infiltration.reaction_max_units must be >= reaction_min_units');
}
