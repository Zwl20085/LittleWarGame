import type { MoveClass, TransportRules, UnitDef } from './types';

/**
 * rules.json `transport` (3.0 roads and railways): movement classes, off-road factors, road jobs,
 * rail numbers. Fails loudly with the key name (review MEDIUM 8).
 */

const CLASSES: readonly MoveClass[] = ['tracked', 'wheeled', 'infantry', 'towed'];
/** Unit kinds moveClassOf maps without a class_of entry. */
const KIND_DEFAULT = new Set(['vehicle', 'crew', 'infantry']);

const bad = (key: string, why: string): Error => new Error(`rules.json: transport.${key} ${why}`);

function positive(o: object, prefix: string, keys: readonly string[]): void {
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !(v > 0)) throw bad(`${prefix}${k}`, 'must be a number > 0');
  }
}

function nonNegative(o: object, prefix: string, keys: readonly string[]): void {
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !(v >= 0)) throw bad(`${prefix}${k}`, 'must be a number >= 0');
  }
}

export function validateTransportRules(t: TransportRules | undefined, units: ReadonlyMap<string, UnitDef>): void {
  if (!t) return;
  positive(t, '', ['on_road']);
  if (!t.off_road || typeof t.off_road !== 'object') throw bad('off_road', 'must list the four movement classes');
  for (const k of Object.keys(t.off_road)) if (!CLASSES.includes(k as MoveClass)) throw bad(`off_road.${k}`, `is not a movement class (${CLASSES.join(', ')})`);
  positive(t.off_road, 'off_road.', CLASSES);
  for (const [id, cls] of Object.entries(t.class_of ?? {})) {
    if (!units.has(id)) throw bad(`class_of.${id}`, 'names an unknown unit');
    if (!CLASSES.includes(cls)) throw bad(`class_of.${id}`, `must be one of ${CLASSES.join(', ')}`);
  }
  for (const u of units.values()) {
    if (!t.class_of?.[u.id] && !KIND_DEFAULT.has(u.kind)) throw bad(`class_of.${u.id}`, `is missing (kind "${u.kind}" has no default class)`);
  }
  if (t.ford_nav_cost !== undefined) positive(t, '', ['ford_nav_cost']);
  if (!t.road_job) throw bad('road_job', 'is required');
  positive(t.road_job, 'road_job.', ['max_len_m', 'seconds_per_100m', 'half_width_m', 'max_slope_deg', 'bridge_max_span_m']);
  nonNegative(t.road_job, 'road_job.', ['cost_m_k_per_100m']);
  const r = t.rail;
  if (!r) throw bad('rail', 'is required');
  positive(r, 'rail.', ['capacity', 'board_radius_m', 'min_trip_m', 'depart_wait_s', 'unload_s', 'trains_per_faction', 'city_link_max_m', 'check_seconds', 'frontline_sample_m']);
  nonNegative(r, 'rail.', ['stock_transfer_per_min_k']);
  if (!(r.min_saving >= 0 && r.min_saving < 1)) throw bad('rail.min_saving', 'must be in [0, 1)');
  if (!r.repair) throw bad('rail.repair', 'is required');
  positive(r.repair, 'rail.repair.', ['work_seconds']);
  nonNegative(r.repair, 'rail.repair.', ['cost_p_k', 'cost_m_k']);
  if (!r.extend) throw bad('rail.extend', 'is required');
  positive(r.extend, 'rail.extend.', ['max_len_m', 'seconds_per_100m']);
  nonNegative(r.extend, 'rail.extend.', ['cost_m_k_per_100m']);
  if (t.ai) positive(t.ai, 'ai.', ['think_seconds', 'link_max_m', 'max_open_jobs']);
}
