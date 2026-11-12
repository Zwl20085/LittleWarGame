import type { GameData, Rules } from '../data/types';

/**
 * Army scale (user decision 2026-10-02: "at least 10× units"). Multiplies every
 * quantity that bounds force size — population, income, stock, production slots,
 * caps, initial forces and campaign resolve — so per-unit balance (costs, damage,
 * build times) stays exactly as in BALANCE_SPEC while armies are k times larger.
 */
export function scaleRules(rules: Rules, k: number): Rules {
  if (k === 1) {
    return rules.proposed_defaults.army_scale === 1
      ? rules
      : { ...rules, proposed_defaults: { ...rules.proposed_defaults, army_scale: 1 } };
  }
  const e = rules.economy;
  const scale40 = k > 10;
  const incomeFactor = scale40 ? 0.34 : (rules.proposed_defaults.army_scale_income_factor ?? 1);
  const stockFactor = scale40 ? 0.5 : (rules.proposed_defaults.army_scale_stock_factor ?? 1);
  const ks = k * stockFactor;
  const kr = k * (rules.proposed_defaults.army_scale_resolve_factor ?? 1);
  const ki = k * incomeFactor;
  const truckCountMul = k > 10 ? 10 * Math.pow(k / 10, 0.45) : k;
  const truckCapMul = k > 10 ? k / truckCountMul : 1;
  const mulRec = (r: Record<string, number>): Record<string, number> =>
    Object.fromEntries(
      Object.entries(r).map(([key, v]) => [key, Math.round(v * (key === 'supply_truck' ? truckCountMul : k))]),
    );
  return {
    ...rules,
    proposed_defaults: {
      ...rules.proposed_defaults,
      army_scale: k,
      army_scale_income_factor: incomeFactor,
      army_scale_stock_factor: stockFactor,
      production_unit_caps: mulRec(rules.proposed_defaults.production_unit_caps),
    },
    territory:
      scale40 && rules.territory
        ? {
            ...rules.territory,
            income_p_per_min: { village: 1.6, town: 4.8, city: 8.5, point: 2.4 },
            income_m_per_min: { village: 0.65, town: 6.4, city: 15.5, point: 1.9 },
            capital_pop_share: 0.22,
            pop_cap_max_multiplier: 1.6,
            pop_per_place: { village: 0.2, town: 0.85, city: 1.8, point: 0.4 },
          }
        : rules.territory,
    transport:
      scale40 && rules.transport
        ? {
            ...rules.transport,
            off_road: { ...rules.transport.off_road, tracked: 0.78 },
          }
        : rules.transport,
    economy: {
      ...e,
      starting_p: e.starting_p * ks,
      starting_m: e.starting_m * ks,
      cap_p: e.cap_p * ks,
      cap_m: e.cap_m * ks,
      population_cap: e.population_cap * k,
      // Income scales less than force size: armies are bounded by money, so losses matter.
      base_income_p_per_min: e.base_income_p_per_min * ki,
      base_income_m_per_min: e.base_income_m_per_min * ki,
      allocated_income_per_min: e.allocated_income_per_min * ki,
      logistics_base: e.logistics_base * k,
      logistics_per_allocation: e.logistics_per_allocation * k,
      facilities: mulRec(e.facilities),
      spending_reference_value: e.spending_reference_value * k,
      node_p_per_min: e.node_p_per_min * k,
      node_m_per_min: e.node_m_per_min * k,
      node_p_bonus_cap: e.node_p_bonus_cap * k,
      node_m_bonus_cap: e.node_m_bonus_cap * k,
      initial_units: mulRec(e.initial_units),
    },
    logistics:
      k > 10 && rules.logistics
        ? {
            ...rules.logistics,
            crowd_free: Math.round(rules.logistics.crowd_free * Math.sqrt(k / 10)),
            truck_capacity: Math.round((rules.logistics.truck_capacity ?? 25) * truckCapMul),
            truck_unload_per_second: +((rules.logistics.truck_unload_per_second ?? 4) * truckCapMul).toFixed(2),
          }
        : rules.logistics,
    victory: {
      ...rules.victory,
      initial_resolve: rules.victory.initial_resolve * kr,
      majority_control_enemy_bleed_per_second: rules.victory.majority_control_enemy_bleed_per_second * kr,
    },
  };
}

export function scaledData(data: GameData, k: number): GameData {
  return { ...data, rules: scaleRules(data.rules, k) };
}
