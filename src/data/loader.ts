import { parseCsv, num, bool, type CsvRow } from './csv';
import { validateFrontRules } from './frontRules';
import type { DefensiveRules, FireMode, GameData, Rules, UnitDef, UnitKind, WeaponDef, Facility } from './types';

const KINDS: readonly UnitKind[] = ['infantry', 'crew', 'vehicle'];
const FACILITIES: readonly Facility[] = ['barracks', 'vehicle', 'support'];
const FIRE_MODES: readonly FireMode[] = ['hitscan', 'direct_projectile', 'ballistic'];

function oneOf<T extends string>(row: CsvRow, field: string, allowed: readonly T[]): T {
  const v = row[field] as T;
  if (!allowed.includes(v)) {
    throw new Error(`line ${row.__line}: field "${field}" must be one of ${allowed.join('/')} ("${v}")`);
  }
  return v;
}

function parseWeapon(row: CsvRow): WeaponDef {
  const w: WeaponDef = {
    id: row.id,
    labelZh: row.label_zh,
    fireMode: oneOf(row, 'fire_mode', FIRE_MODES),
    range: num(row, 'range_m'),
    minRange: num(row, 'min_range_m'),
    interval: num(row, 'interval_seconds'),
    damage: num(row, 'damage'),
    penetration: num(row, 'penetration'),
    accuracy: num(row, 'accuracy'),
    blastRadius: num(row, 'blast_radius_m'),
    suppression: num(row, 'suppression'),
    canFireMoving: bool(row, 'can_fire_moving'),
    ammoCost: num(row, 'ammo_cost'),
    muzzleSpeed: num(row, 'muzzle_speed_mps'),
    minElevationDeg: num(row, 'min_elevation_deg'),
    maxElevationDeg: num(row, 'max_elevation_deg'),
  };
  if (w.range < w.minRange) throw new Error(`weapons line ${row.__line}: range_m < min_range_m`);
  if (w.interval <= 0) throw new Error(`weapons line ${row.__line}: interval_seconds must be > 0`);
  if (w.fireMode !== 'hitscan' && w.muzzleSpeed <= 0) {
    throw new Error(`weapons line ${row.__line}: projectile weapon needs muzzle_speed_mps > 0`);
  }
  return w;
}

function parseUnit(row: CsvRow): UnitDef {
  const u: UnitDef = {
    id: row.id,
    labelZh: row.label_zh,
    kind: oneOf(row, 'kind', KINDS),
    facility: oneOf(row, 'facility', FACILITIES),
    costP: num(row, 'cost_p'),
    costM: num(row, 'cost_m'),
    population: num(row, 'population'),
    supplyDemand: num(row, 'supply_demand'),
    buildSeconds: num(row, 'build_seconds'),
    unlockSeconds: num(row, 'unlock_seconds'),
    maxHp: num(row, 'max_hp'),
    memberCount: num(row, 'member_count'),
    speed: num(row, 'speed_mps'),
    vision: num(row, 'vision_m'),
    primaryWeapon: row.primary_weapon || null,
    secondaryWeapon: row.secondary_weapon || null,
    armorFront: num(row, 'armor_front'),
    armorSide: num(row, 'armor_side'),
    armorRear: num(row, 'armor_rear'),
    maxSlopeDeg: num(row, 'max_slope_deg'),
    hullTurnDegps: num(row, 'hull_turn_degps'),
    turretTurnDegps: num(row, 'turret_turn_degps'),
    setupSeconds: num(row, 'setup_seconds'),
    packSeconds: num(row, 'pack_seconds'),
  };
  if (u.costP < 0 || u.costM < 0) throw new Error(`units line ${row.__line}: negative cost`);
  if (u.maxHp <= 0) throw new Error(`units line ${row.__line}: max_hp must be > 0`);
  if (u.population <= 0) throw new Error(`units line ${row.__line}: population must be > 0`);
  return u;
}

function indexUnique<T extends { id: string }>(items: T[], table: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const it of items) {
    if (!it.id) throw new Error(`${table}: empty id`);
    if (map.has(it.id)) throw new Error(`${table}: duplicate id "${it.id}"`);
    map.set(it.id, it);
  }
  return map;
}

export function buildGameData(unitsCsv: string, weaponsCsv: string, rulesJson: string): GameData {
  const weapons = indexUnique(parseCsv(weaponsCsv).map(parseWeapon), 'weapons.csv');
  const unitList = parseCsv(unitsCsv).map(parseUnit);
  const units = indexUnique(unitList, 'units.csv');
  for (const u of unitList) {
    for (const ref of [u.primaryWeapon, u.secondaryWeapon]) {
      if (ref && !weapons.has(ref)) throw new Error(`units.csv: unit "${u.id}" references unknown weapon "${ref}"`);
    }
  }
  const rules = JSON.parse(rulesJson) as Rules;
  if (!(rules.simulation?.gravity_mps2 > 0)) throw new Error('rules.json: simulation.gravity_mps2 must be > 0');
  if (!(rules.simulation?.tick_hz > 0)) throw new Error('rules.json: simulation.tick_hz must be > 0');
  for (const id of Object.keys(rules.proposed_defaults.production_unit_weights)) {
    if (!units.has(id)) throw new Error(`rules.json: production weight for unknown unit "${id}"`);
  }
  if (!rules.command || !units.has(rules.command.commander_unit)) throw new Error('rules.json: command.commander_unit must name a unit in units.csv');
  validateDefensive(rules.construction?.defensive, units, weapons);
  validateLogistics(rules);
  validateFrontRules(rules.fronts, rules.command.compliance_threshold, rules.command.compliance);
  // 2.2 endurance (V22_SPEC §3.1): one documented lever, every weapon's ammo cost × multiplier.
  const ammoMul = rules.logistics?.ammo_cost_multiplier ?? 1;
  const effWeapons = ammoMul === 1 ? weapons : new Map([...weapons].map(([id, w]) => [id, { ...w, ammoCost: w.ammoCost * ammoMul }]));
  return { units, weapons: effWeapons, rules, unitOrder: unitList.map((u) => u.id) };
}

/** rules.json `logistics` / `econ` (2.2): positive caps, rates and costs. */
function validateLogistics(rules: Rules): void {
  const l = rules.logistics;
  if (l) {
    if (!(l.ammo_cost_multiplier > 0)) throw new Error('rules.json: logistics.ammo_cost_multiplier must be > 0');
    for (const k of ['capital', 'city', 'town'] as const) {
      if (!(l.stock_cap_k?.[k] > 0) || !(l.draw_radius_m?.[k] > 0)) throw new Error(`rules.json: logistics stock_cap_k / draw_radius_m missing for ${k}`);
    }
    if (!(l.rearm_per_second > 0) || !(l.rearm_until > l.rearm_below)) throw new Error('rules.json: logistics rearm rates invalid');
    if (l.place_fill_burst !== undefined && !(l.place_fill_burst > 0)) throw new Error('rules.json: logistics.place_fill_burst must be > 0');
    if (l.steward_stock_target !== undefined && !(l.steward_stock_target > 0 && l.steward_stock_target <= 1)) throw new Error('rules.json: logistics.steward_stock_target must be in (0, 1]');
  }
  const e = rules.econ;
  if (e) {
    for (const k of ['factory', 'recruit', 'depot'] as const) {
      const b = e.buildings?.[k];
      if (!b || !(b.max_hp > 0) || !(b.build_seconds > 0) || b.cost_p < 0 || b.cost_m < 0) throw new Error(`rules.json: econ.buildings.${k} invalid`);
    }
    if (!(e.captured_hp_ratio > 0 && e.captured_hp_ratio <= 1)) throw new Error('rules.json: econ.captured_hp_ratio must be in (0, 1]');
  }
}

/** rules.json `construction.defensive`: unique ids, positive HP / work, known units and weapons. */
function validateDefensive(d: DefensiveRules | undefined, units: Map<string, UnitDef>, weapons: Map<string, WeaponDef>): void {
  if (!d || !Array.isArray(d.structures)) throw new Error('rules.json: construction.defensive.structures is required');
  const seen = new Set<string>();
  for (const s of d.structures) {
    if (s.id !== 'pillbox' && s.id !== 'bunker') throw new Error(`rules.json: unknown defensive structure "${s.id}"`);
    if (seen.has(s.id)) throw new Error(`rules.json: duplicate defensive structure "${s.id}"`);
    seen.add(s.id);
    if (!(s.max_hp > 0) || !(s.work_seconds > 0)) throw new Error(`rules.json: ${s.id} needs max_hp > 0 and work_seconds > 0`);
    if (s.cost_p < 0 || s.cost_m < 0) throw new Error(`rules.json: ${s.id} has a negative cost`);
    if (!(s.capacity >= 1) || s.max_crews < 0 || s.max_crews > s.capacity) throw new Error(`rules.json: ${s.id} capacity / max_crews invalid`);
    if (s.weapon !== null && !weapons.has(s.weapon)) throw new Error(`rules.json: ${s.id} references unknown weapon "${s.weapon}"`);
    if (s.fire_mul && !(s.fire_mul.damage > 0 && s.fire_mul.range > 0)) throw new Error(`rules.json: ${s.id} fire_mul needs damage > 0 and range > 0`);
    for (const id of s.accepts) if (!units.has(id)) throw new Error(`rules.json: ${s.id} accepts unknown unit "${id}"`);
  }
  const g = d.garrison;
  if (!g || !(g.enter_radius_m > 0) || !(g.leave_radius_m >= g.enter_radius_m) || g.absorb_share < 0 || g.absorb_share > 1) {
    throw new Error('rules.json: construction.defensive.garrison invalid');
  }
}
