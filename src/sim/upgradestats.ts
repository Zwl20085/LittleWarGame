import type { UnitDef, WeaponDef } from '../data/types';
import type { UpgradeEffectRules, UpgradeRules } from '../data/upgradeRules';
import type { Unit } from './types';
import type { World } from './world';

/**
 * 3.0 unit upgrades — the stat layer (V30_SPEC §9, docs/UPGRADES.md). `UnitDef` / `WeaponDef` are
 * shared and readonly, so an upgraded unit points at a *variant* def built once per (unit type,
 * upgrade bits) and cached; every existing read site (`u.def.speed`, `u.def.maxHp`, armour,
 * `u.primary.range` …) sees the upgraded numbers with no per-tick work. A unit carries the bits it
 * has been refitted with (`u.upg`): new units roll out with all of their faction's upgrades
 * (`refitOnSpawn`); existing units take armour / gun / motorization at a town
 * rearm (`refitAtTown`, settlements.drawSecond) and the "field" items at once (`refitNow`).
 */

/** The upgrade tree in bit order (bit k = UPGRADE_IDS[k]). 12 items (3.0.1: the attached gun team was removed). */
export const UPGRADE_IDS = [
  'ap_grenades', 'motorization',
  'armour_1', 'armour_2', 'armour_3',
  'gun_1', 'gun_2', 'gun_3',
  'arty_range', 'truck_capacity', 'eng_speed', 'staff',
] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];

export const UPG = Object.fromEntries(UPGRADE_IDS.map((id, k) => [id, 1 << k])) as Record<UpgradeId, number>;
export const upgradeBit = (id: string): number => UPG[id as UpgradeId] ?? 0;

const ARMOUR = UPG.armour_1 | UPG.armour_2 | UPG.armour_3;
const GUN = UPG.gun_1 | UPG.gun_2 | UPG.gun_3;
const TANK = ARMOUR | GUN;
const SQUAD = UPG.ap_grenades;
/** Squad kit items fired by upgradekit.ts. */
export const KIT_BITS = SQUAD;

/** Bits each unit type can carry (staff is faction-wide, read from the faction state). */
const CLASS_MASK: Readonly<Record<string, number>> = {
  infantry: SQUAD | UPG.motorization,
  motor_inf: SQUAD,
  light_tank: TANK, medium_tank: TANK, heavy_tank: TANK,
  mortar: UPG.arty_range, howitzer: UPG.arty_range,
  supply_truck: UPG.truck_capacity,
  engineer: UPG.eng_speed,
};
export const classMask = (unitId: string): number => CLASS_MASK[unitId] ?? 0;

/** Items a unit only takes at a town rearm (a refit: new plates, a new gun, trucks); the rest apply at once. */
export const REFIT_AT_TOWN = UPG.motorization | TANK;

/** Number of set bits (levels of a tiered item). */
function bitCount(x: number): number {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
}
export const armourLevel = (bits: number): number => bitCount(bits & ARMOUR);
export const gunLevel = (bits: number): number => bitCount(bits & GUN);

const TANK_GUNS = new Set(['light_cannon', 'medium_cannon', 'heavy_cannon']);
const ARTY_SHELLS = new Set(['mortar_shell', 'howitzer_shell']);

/** Rules of the system, or null when off (old rule sets, `upgrades.enabled=false`). */
export function upgradeRules(world: World): UpgradeRules | null {
  const r = world.data.rules.upgrades;
  return r && r.enabled ? r : null;
}

// ------------------------------------------------------------------ variant cache

/** Variants per effect-rules object (one per loaded data set), keyed by `type|bits`. */
const defCache = new WeakMap<UpgradeEffectRules, Map<string, UnitDef>>();
const weaponCache = new WeakMap<UpgradeEffectRules, Map<string, WeaponDef>>();

/** A variant def may carry the engineer work-rate multiplier (eng_speed). */
type UpgradedDef = UnitDef & { readonly workMul?: number };

function variantDef(fx: UpgradeEffectRules, base: UnitDef, bits: number): UnitDef {
  const lvl = armourLevel(bits);
  const eng = (bits & UPG.eng_speed) !== 0;
  if (lvl === 0 && !eng) return base;
  let m = defCache.get(fx);
  if (!m) defCache.set(fx, (m = new Map()));
  const key = `${base.id}|${lvl}|${eng ? 1 : 0}`;
  let d = m.get(key);
  if (!d) {
    const a = fx.armour_per_level;
    const v: UpgradedDef = {
      ...base,
      workMul: eng ? fx.eng_build_mul : 1,
      armorFront: Math.round(base.armorFront * (1 + a.armour * lvl)),
      armorSide: Math.round(base.armorSide * (1 + a.armour * lvl)),
      armorRear: Math.round(base.armorRear * (1 + a.armour * lvl)),
      maxHp: Math.round(base.maxHp * (1 + a.hp * lvl)),
      speed: base.speed * Math.max(0.5, 1 + a.speed * lvl),
    };
    d = v;
    m.set(key, d);
  }
  return d;
}

function variantWeapon(fx: UpgradeEffectRules, base: WeaponDef | null, bits: number): WeaponDef | null {
  if (!base) return null;
  const gl = TANK_GUNS.has(base.id) ? gunLevel(bits) : 0;
  const arty = ARTY_SHELLS.has(base.id) && (bits & UPG.arty_range) !== 0;
  if (gl === 0 && !arty) return base;
  let m = weaponCache.get(fx);
  if (!m) weaponCache.set(fx, (m = new Map()));
  const key = `${base.id}|${gl}|${arty ? 1 : 0}`;
  let w = m.get(key);
  if (!w) {
    const g = fx.gun_per_level;
    w = {
      ...base,
      penetration: base.penetration + g.pen * gl,
      damage: base.damage * (1 + g.damage * gl),
      range: base.range * (1 + g.range * gl) * (arty ? fx.arty_range_mul : 1),
    };
    m.set(key, w);
  }
  return w;
}

// ------------------------------------------------------------------ refits

/** Bits faction `owner` can give this unit now. */
export function targetBits(world: World, u: Unit): number {
  const f = world.factions[u.owner];
  if (!f?.upgrades || !upgradeRules(world)) return 0;
  return f.upgrades.owned & classMask(u.def.id);
}

/** Give `u` exactly `bits`: swap in the variant def / weapons, keep its hit-point ratio. */
export function refit(world: World, u: Unit, bits: number): void {
  if (u.fixed || bits === u.upg) return;
  const fx = world.data.rules.upgrades?.effects;
  const base = world.data.units.get(u.def.id);
  if (!fx || !base) return;
  const ratio = u.def.maxHp > 0 ? u.hp / u.def.maxHp : 1;
  const def = variantDef(fx, base, bits);
  u.def = def;
  u.primary = variantWeapon(fx, base.primaryWeapon ? world.data.weapons.get(base.primaryWeapon) ?? null : null, bits);
  u.secondary = variantWeapon(fx, base.secondaryWeapon ? world.data.weapons.get(base.secondaryWeapon) ?? null : null, bits);
  if (u.hp > 0) u.hp = Math.max(1, ratio * def.maxHp);
  u.upg = bits;
}

/** World.spawnUnit hook: fresh from the factory with every upgrade the faction owns. */
export function refitOnSpawn(world: World, u: Unit): void {
  const bits = targetBits(world, u);
  if (bits !== 0) refit(world, u, bits);
}

/** At an own settlement stock (settlements.drawSecond): take every upgrade still missing. */
export function refitAtTown(world: World, u: Unit): void {
  if (u.upg === targetBits(world, u)) return;
  refit(world, u, targetBits(world, u));
}

/** A finished "field" item (grenades, range tables, truck beds, tools) reaches every unit at once. */
export function refitNow(world: World, owner: number, bit: number): void {
  if ((bit & REFIT_AT_TOWN) !== 0) return;
  for (const u of world.aliveUnits) {
    if (u.owner !== owner || u.hp <= 0 || u.fixed || (classMask(u.def.id) & bit) === 0) continue;
    refit(world, u, u.upg | bit);
  }
}

// ------------------------------------------------------------------ faction-wide effects

/** Faction owns `id` (and the system is on). */
export function hasUpgrade(world: World, owner: number, id: UpgradeId): boolean {
  const f = world.factions[owner];
  return !!f?.upgrades && (f.upgrades.owned & UPG[id]) !== 0 && upgradeRules(world) !== null;
}

/** Supply-truck load multiplier (convoy.ts truck capacity). */
export function truckCapacityMul(world: World, owner: number): number {
  return hasUpgrade(world, owner, 'truck_capacity') ? world.data.rules.upgrades!.effects.truck_capacity_mul : 1;
}

/** Engineer work-rate multiplier (works, structures, bridges, road and rail jobs): carried by the variant def. */
export function workMul(u: Unit): number {
  return (u.def as UpgradedDef).workMul ?? 1;
}

/** Front tier threshold multiplier (frontTiers.ts): the staff upgrade lowers them. */
export function staffThresholdMul(world: World, owner: number): number {
  return hasUpgrade(world, owner, 'staff') ? world.data.rules.upgrades!.effects.staff_threshold_mul : 1;
}

/** Motorized: rides trucks on long safe trips (movement.handleMount). */
export const isMotorized = (u: Unit): boolean => u.def.id === 'motor_inf' || (u.upg & UPG.motorization) !== 0;

/** Stat read through the layer (equivalent to `u.def[stat]`, which already holds the variant). */
export type UnitStat = 'speed' | 'maxHp' | 'armorFront' | 'armorSide' | 'armorRear';
export const statOf = (u: Unit, stat: UnitStat): number => u.def[stat];
