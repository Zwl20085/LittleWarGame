import { parseCsv, num, bool, type CsvRow } from './csv';
import type { FireMode, GameData, Rules, UnitDef, UnitKind, WeaponDef, Facility } from './types';

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
  return { units, weapons, rules, unitOrder: unitList.map((u) => u.id) };
}
