import type { DefensiveStructureDef, WeaponDef } from '../data/types';
import { selectTarget } from './combat';
import { COMBAT } from './config';
import { addSuppression, applyDamage } from './damage';
import { trySpend } from './economy';
import { isCommander } from './formulas';
import { moveTo, stop } from './movement';
import { availableM } from './production';
import { hostileMask } from './spatial';
import { Ground } from './terrain';
import { dig, openWork } from './works';
import type { Faction, Fort, FortKind, Front, Unit, Zone } from './types';
import { angleDiff, DEG, dist, headingTo, type V2 } from './vec';
import type { World } from './world';

/**
 * 2.0 defensive buildings (user: "工兵可以建设筑垒区域、炮楼、堡垒，其可作为防御建筑，需要步兵/侦察/…
 * 单位进入驻防，不占人口"). A pillbox (炮楼) or bunker (堡垒) is a `Fort` built by engineers; stopped
 * eligible squads next to a finished one enter it (`fortId`, `occupants`). Occupants get all-round
 * cover, fire from a raised muzzle (a pillbox occupant fires its built-in MG), stay concealed until
 * they fire, and are off the population count. Direct hits are partly taken by the concrete; when
 * it collapses the occupants are thrown out, suppressed and hurt. Numbers: rules.json
 * `construction.defensive`; AI layout and builder assignment: fortplans.ts.
 */
export const STRUCT = {
  /** Per-unit garrison check cadence (ticks) and phase (offset from works cover's phase 0). */
  garrisonCheckTicks: 10,
  garrisonCheckPhase: 5,
  /** Engineers within this of a building site work on it, standing at its rear (beyond the enter radius). */
  buildRadiusM: 10,
  rearStandM: 7.5,
  /** Nobody starts or works a site with a known armed enemy this close. */
  noBuildEnemyM: 150,
  /** A builder assignment lapses unless the planner renews it within this. */
  jobSeconds: 30,
  /** Holding troops look for a building every this many seconds; a claim on one lasts this long. */
  seekEverySeconds: 4,
  claimSeconds: 60,
  /** Line troops stay in / go to buildings within this of their front's battle line (hold / fortify)… */
  frontHoldM: 300,
  /** …and stay while attacking only if the line is still this close. */
  frontAttackStayM: 150,
  /** Garrison-role troops (capital / town garrisons) use buildings within this of their place. */
  placeHoldM: 280,
  /** A site needs this much clear ground: no building raster cell, no water, no other work. */
  siteClearM: 7,
  maxSiteSlopeDeg: 14,
  /** One new building per faction at most this often (M budget pacing). */
  startEverySeconds: 10,
  /** Bunker slots: occupants sit this far apart along the front face. */
  slotSpreadM: 2.4,
  /** 2.1: a steady front mans works within this of its fortified zones' lines (and `frontHoldM` of its battle line). */
  zoneManM: 80,
  /** Manning points: works within this of a zone's line belong to it (`zoneSlots`). */
  zoneSlotM: 60,
  /** Trench manning points: two per trench bay, at these fractions of its length, this far behind the parapet. */
  trenchSlotT: [0.3, 0.7],
  trenchSlotBackM: 2,
} as const;

export type StructureKind = Extract<FortKind, 'pillbox' | 'bunker'>;

export const isStructure = (k: FortKind): k is StructureKind => k === 'pillbox' || k === 'bunker';

/** Rules entry for a building kind. */
export function structureDef(world: World, kind: StructureKind): DefensiveStructureDef {
  const d = world.data.rules.construction.defensive.structures.find((s) => s.id === kind);
  if (!d) throw new Error(`rules.json: no defensive structure "${kind}"`);
  return d;
}

const garrisonRules = (world: World): World['data']['rules']['construction']['defensive']['garrison'] => world.data.rules.construction.defensive.garrison;

// ---------------------------------------------------------------- garrison state

interface Garrison {
  readonly fort: Fort;
  readonly def: DefensiveStructureDef;
  readonly weapon: WeaponDef | null;
}

/** Unit → the building it mans (a cache of `fortId` + `occupants`, rebuilt from them on every check). */
const garrisons = new WeakMap<Unit, Garrison>();

/** The intact building `u` is inside, or null. */
export function garrisonOf(u: Unit): Garrison | null {
  const g = garrisons.get(u);
  if (!g) return null;
  if (u.fortId !== g.fort.id || g.fort.hp <= 0) {
    garrisons.delete(u);
    return null;
  }
  return g;
}

export const isGarrisoned = (u: Unit): boolean => garrisonOf(u) !== null;

/** Weapon the unit fires: the building's built-in gun, its own primary through the slits (bunker), or its primary. */
export const weaponOf = (u: Unit): WeaponDef | null => {
  const g = garrisonOf(u);
  return g ? g.weapon : u.primary;
};

/** Extra muzzle / eye height inside a building (fires over the parapet, sees farther). */
export const garrisonRaise = (u: Unit): number => garrisonOf(u)?.def.muzzle_raise_m ?? 0;

/** Occupant cover level against any direction (null = not in a building). */
export function garrisonCover(u: Unit): 0 | 1 | 2 | 3 | null {
  const g = garrisonOf(u);
  return g && g.fort.progress >= 1 ? g.def.cover : null;
}

/** Blast damage multiplier for an occupant (null = not in a building: use the cover level's). */
export const garrisonBlastMul = (u: Unit): number | null => garrisonOf(u)?.def.occupant_blast_mul ?? null;

/** Concealed like troops in a forest until they fire (terrainrules.forestConcealed). */
export const garrisonConcealed = (u: Unit): boolean => garrisonOf(u) !== null;

/** Target at `at` lies in the building's blind rear arc (pillbox embrasures face front and flanks). */
export function garrisonBlind(u: Unit, at: V2): boolean {
  const g = garrisonOf(u);
  if (!g || g.def.blind_rear_deg <= 0) return false;
  const rear = g.fort.facing + Math.PI;
  return Math.abs(angleDiff(headingTo(g.fort.pos, at), rear)) < (g.def.blind_rear_deg * DEG) / 2;
}

function accepts(def: DefensiveStructureDef, u: Unit): boolean {
  return !u.fixed && !u.mounted && !isCommander(u.def) && def.accepts.includes(u.def.id);
}

/** Drop dead / departed occupants (immutably) and keep the single-occupant mirror in step. */
function prune(world: World, fort: Fort): readonly number[] {
  const cur = fort.occupants ?? [];
  const occ = cur.every((id) => world.unitAlive(id)?.fortId === fort.id) ? cur : cur.filter((id) => world.unitAlive(id)?.fortId === fort.id);
  fort.occupants = occ;
  fort.occupant = occ[0] ?? null;
  return occ;
}

/** Room for `u` (capacity, and at most `max_crews` crews). */
function hasRoom(world: World, fort: Fort, def: DefensiveStructureDef, u: Unit, pending = 0): boolean {
  const occ = prune(world, fort);
  if (occ.length + pending >= def.capacity) return false;
  if (u.def.kind !== 'crew') return true;
  let crews = 0;
  for (const id of occ) if (world.unitAlive(id)?.def.kind === 'crew') crews++;
  return crews < def.max_crews;
}

/** Scaled copies of unit weapons fired through a building's slits (2.1 `fire_mul`), one per weapon and multiplier. */
const slitWeapons = new WeakMap<WeaponDef, Map<string, WeaponDef>>();

/**
 * The weapon an occupant fires: the building's built-in gun (pillbox `pillbox_mg`), else its own
 * primary with the building's `fire_mul` (bunker firing slits: +damage, +range).
 */
function garrisonWeapon(world: World, u: Unit, def: DefensiveStructureDef): WeaponDef | null {
  if (def.weapon) return world.data.weapons.get(def.weapon) ?? null;
  const w = u.primary;
  const m = def.fire_mul;
  if (!w || !m || (m.damage === 1 && m.range === 1)) return w;
  const key = `${m.damage}:${m.range}`;
  let byMul = slitWeapons.get(w);
  if (!byMul) slitWeapons.set(w, (byMul = new Map()));
  let out = byMul.get(key);
  if (!out) byMul.set(key, (out = { ...w, damage: w.damage * m.damage, range: w.range * m.range }));
  return out;
}

function enter(world: World, u: Unit, fort: Fort, def: DefensiveStructureDef): void {
  fort.occupants = [...prune(world, fort), u.id];
  fort.occupant = fort.occupants[0];
  u.fortId = fort.id;
  u.cover = def.cover;
  garrisons.set(u, { fort, def, weapon: garrisonWeapon(world, u, def) });
  claims.delete(u);
  snapToSlot(u, fort, def);
}

/** Leave a building (walked out, ordered away, or thrown out by its collapse). */
export function leaveStructure(world: World, u: Unit): void {
  const g = garrisons.get(u);
  garrisons.delete(u);
  const fort = g?.fort ?? world.fortById(u.fortId);
  u.fortId = null;
  if (fort) prune(world, fort);
}

/** Occupant slot `i` of a building (bunkers: side by side along the front face). */
export function slotPos(fort: Fort, capacity: number, i: number): V2 {
  const off = capacity > 1 ? (i - (capacity - 1) / 2) * STRUCT.slotSpreadM * 2 : 0;
  const along = fort.facing + Math.PI / 2;
  return { x: fort.pos.x + Math.cos(along) * off, z: fort.pos.z + Math.sin(along) * off };
}

/** Occupants sit at fixed slots. */
function snapToSlot(u: Unit, fort: Fort, def: DefensiveStructureDef): void {
  const p = slotPos(fort, def.capacity, Math.max(0, (fort.occupants ?? []).indexOf(u.id)));
  if (Math.hypot(u.pos.x - p.x, u.pos.z - p.z) > 0.8) {
    u.pos.x = p.x;
    u.pos.z = p.z;
  }
}

/** Finished, standing buildings of this world, recomputed once per tick (per-unit scans stay short). */
const structureCache = new WeakMap<World, { tick: number; list: Fort[] }>();
export function structuresOf(world: World): readonly Fort[] {
  let c = structureCache.get(world);
  if (!c || c.tick !== world.tick) {
    c = { tick: world.tick, list: world.forts.filter((f) => isStructure(f.kind) && f.hp > 0) };
    structureCache.set(world, c);
    // Occupants that died or left outside the garrison path (elimination, evacuation) drop out at once.
    for (const f of c.list) if (f.occupant !== null || (f.occupants?.length ?? 0) > 0) prune(world, f);
  }
  return c.list;
}

/**
 * Per-unit garrison check (movement.updateHeight), staggered: every `garrisonCheckTicks`th tick
 * per unit. Occupants that moved away leave; stopped eligible squads next to a finished friendly
 * building with room enter it.
 */
export function updateStructureGarrison(world: World, u: Unit): void {
  if ((world.tick + u.id) % STRUCT.garrisonCheckTicks !== STRUCT.garrisonCheckPhase) return;
  if (u.def.kind === 'vehicle' || u.fixed) return;
  const gr = garrisonRules(world);
  if (u.fortId !== null) {
    const g = garrisonOf(u) ?? rebind(world, u);
    if (!g) return;
    if (dist(u.pos, g.fort.pos) > gr.leave_radius_m) leaveStructure(world, u);
    else if (!u.moving) snapToSlot(u, g.fort, g.def);
    return;
  }
  // Builders keep building (an engineer at a finished pillbox next door must not move in).
  if (u.moving || u.mounted || jobOf(world, u) !== null) return;
  for (const fort of structuresOf(world)) {
    if (fort.owner !== u.owner || fort.progress < 1 || dist(fort.pos, u.pos) > gr.enter_radius_m) continue;
    const def = structureDef(world, fort.kind as StructureKind);
    if (accepts(def, u) && hasRoom(world, fort, def, u)) {
      enter(world, u, fort, def);
      return;
    }
  }
}

/** Rebuild the cache entry from `fortId` (e.g. after a snapshot restore). */
function rebind(world: World, u: Unit): Garrison | null {
  const fort = world.fortById(u.fortId);
  if (!fort || !isStructure(fort.kind)) return null;
  if (fort.hp <= 0 || !(fort.occupants ?? []).includes(u.id)) {
    u.fortId = null;
    return null;
  }
  const def = structureDef(world, fort.kind);
  const g = { fort, def, weapon: garrisonWeapon(world, u, def) };
  garrisons.set(u, g);
  return g;
}

// ---------------------------------------------------------------- hits and collapse

/**
 * Direct hit on an occupant: the building takes `absorb_share` of it. Small arms cannot hurt the
 * concrete (their share is simply stopped); guns damage it. Returns the damage left for the squad.
 */
export function absorbHit(world: World, u: Unit, dmg: number, penetration: number, attackerOwner: number): number {
  const g = garrisonOf(u);
  if (!g || dmg <= 0) return dmg;
  const taken = dmg * garrisonRules(world).absorb_share;
  if (penetration > COMBAT.smallArmsPenCutoff) damageStructure(world, g.fort, taken, attackerOwner);
  return dmg - taken;
}

export function damageStructure(world: World, fort: Fort, amount: number, attackerOwner: number): void {
  if (fort.hp <= 0 || amount <= 0) return;
  // 2.0 attack-side round: concrete takes the same tempo multiplier as units (it was 1.8× tougher than its HP said).
  fort.hp = Math.max(0, fort.hp - amount * (world.data.rules.proposed_defaults.tempo_damage_multiplier ?? 1));
  if (fort.hp <= 0) collapseStructure(world, fort, attackerOwner);
}

/** The building is gone: occupants are thrown out, suppressed and hurt. */
export function collapseStructure(world: World, fort: Fort, attackerOwner: number): void {
  const gr = garrisonRules(world);
  const occ = fort.occupants ?? (fort.occupant !== null ? [fort.occupant] : []);
  fort.occupants = [];
  fort.occupant = null;
  for (const id of occ) {
    const u = world.unitAlive(id);
    if (!u || u.fortId !== fort.id) continue;
    garrisons.delete(u);
    u.fortId = null;
    addSuppression(world, u, gr.collapse_suppression);
    applyDamage(world, u, u.def.maxHp * gr.collapse_damage_ratio, attackerOwner, 'collapse');
  }
  if (fort.progress >= 1) world.note(fort.owner, 'log.structureLost', { kind: fort.kind }, 'warn');
}

// ---------------------------------------------------------------- construction

/** Last building start per faction (pacing). */
const startedAt = new WeakMap<Faction, number>();

/** Ground a building can stand on: in bounds, dry, gentle, walkable, clear of houses and other works. */
export function structureSiteOk(world: World, p: V2): boolean {
  const t = world.terrain;
  const r = STRUCT.siteClearM * 0.6;
  for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
    const x = p.x + dx;
    const z = p.z + dz;
    if (!t.inBounds(x, z) || t.buildingH(x, z) > 0) return false;
    const g = t.groundAt(x, z);
    if (g === Ground.Water || g === Ground.Ford) return false;
  }
  if (t.slopeAt(p.x, p.z) > STRUCT.maxSiteSlopeDeg) return false;
  if (!world.nav(false, 35).walkableXZ(p.x, p.z)) return false;
  for (const f of world.forts) {
    if (f.hp <= 0) continue;
    const d = f.start && f.end ? segDistance(p, f.start, f.end) : dist(p, f.pos);
    if (d < STRUCT.siteClearM) return false;
  }
  return true;
}

function segDistance(p: V2, a: V2, b: V2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

/** Can the faction pay for `kind` and still keep `reserveMul` × its cost for production? */
export function canAfford(world: World, f: Faction, kind: StructureKind, reserveMul: number): boolean {
  const d = structureDef(world, kind);
  return f.p >= d.cost_p * (1 + reserveMul) && availableM(world, f) >= d.cost_m * (1 + reserveMul);
}

/**
 * Pay for and register a building site (progress 0) if the ground, the pacing and the budget
 * allow (`reserveMul` × the cost is kept back for production). Returns null otherwise.
 */
export function startStructure(world: World, f: Faction, kind: StructureKind, pos: V2, facing: number, reserveMul: number): Fort | null {
  if (world.time - (startedAt.get(f) ?? -1e9) < STRUCT.startEverySeconds) return null;
  if (!structureSiteOk(world, pos) || !canAfford(world, f, kind, reserveMul)) return null;
  const d = structureDef(world, kind);
  if (!trySpend(f, d.cost_p, d.cost_m).ok) return null;
  const fort: Fort = {
    id: world.newId(), owner: f.id, kind, pos: { ...pos }, facing, hp: d.max_hp, maxHp: d.max_hp,
    progress: 0, occupant: null, capacity: d.capacity, occupants: [],
  };
  world.forts.push(fort);
  startedAt.set(f, world.time);
  return fort;
}

/**
 * A finished building placed for free (2.1: each capital starts with pillboxes at its map
 * strongpoints), on the nearest good ground within `searchM` of `pos`. Null when there is none.
 */
export function placeStructure(world: World, owner: number, kind: StructureKind, pos: V2, facing: number, searchM = 36): Fort | null {
  let at: V2 | null = structureSiteOk(world, pos) ? pos : null;
  for (let r = 6; !at && r <= searchM; r += 6) {
    for (let k = 0; k < 12 && !at; k++) {
      const q = { x: pos.x + Math.cos((k * Math.PI) / 6) * r, z: pos.z + Math.sin((k * Math.PI) / 6) * r };
      if (structureSiteOk(world, q)) at = q;
    }
  }
  if (!at) return null;
  const d = structureDef(world, kind);
  const fort: Fort = {
    id: world.newId(), owner, kind, pos: { ...at }, facing, hp: d.max_hp, maxHp: d.max_hp,
    progress: 1, occupant: null, capacity: d.capacity, occupants: [],
  };
  world.forts.push(fort);
  return fort;
}

/** Any known armed enemy within r of p. */
export function enemyNear(world: World, owner: number, p: V2, r: number): boolean {
  return world.spatial.findOwner(p.x, p.z, r, hostileMask(world, owner), (e) => e.hp > 0 && e.primary !== null && world.knows(owner, e)) !== null;
}

/** One construction step by an engineer (unit executor, ~0.4 s). Returns true while busy. */
export function buildStep(world: World, u: Unit, fort: Fort): boolean {
  if (fort.progress >= 1 || fort.hp <= 0 || u.def.id !== 'engineer' || !isStructure(fort.kind)) return false;
  const def = structureDef(world, fort.kind);
  const stand = { x: fort.pos.x - Math.cos(fort.facing) * STRUCT.rearStandM, z: fort.pos.z - Math.sin(fort.facing) * STRUCT.rearStandM };
  if (dist(u.pos, fort.pos) > STRUCT.buildRadiusM) {
    // A site this engineer cannot path to is left (soak: "stuck diggers").
    if (u.pathFailed && u.dest && dist(u.dest, stand) < 20) return false;
    moveTo(world, u, stand);
  } else {
    stop(u);
    if (u.moraleState === 'normal') {
      fort.progress = Math.min(1, fort.progress + 0.4 / def.work_seconds);
      if (fort.progress >= 1) completeStructure(world, fort);
    }
  }
  u.status = fort.kind === 'pillbox' ? 'status.buildingPillbox' : 'status.buildingBunker';
  return true;
}

function completeStructure(world: World, fort: Fort): void {
  world.note(fort.owner, fort.kind === 'pillbox' ? 'log.pillboxBuilt' : 'log.bunkerBuilt', {}, 'info');
}

// ---------------------------------------------------------------- jobs and claims

interface Job { readonly fortId: number; readonly until: number }

/** Builder assignments made by the planners (fortplans.ts), renewed every HQ think. */
const jobs = new WeakMap<Unit, Job>();

export function assignJob(world: World, u: Unit, fort: Fort): void {
  jobs.set(u, { fortId: fort.id, until: world.time + STRUCT.jobSeconds });
}

/** Current (unexpired) job site id of a unit, or null. */
export function jobOf(world: World, u: Unit): number | null {
  const j = jobs.get(u);
  if (!j || world.time > j.until) return null;
  return j.fortId;
}

export function dropJob(u: Unit): void {
  jobs.delete(u);
}

interface Claim { readonly fortId: number; readonly until: number }
/** Troops on their way into a building (so two squads don't race for one slot). */
const claims = new WeakMap<Unit, Claim>();
const nextSeek = new WeakMap<Unit, number>();

/** Squads already walking to `fort` (valid claims among its owner's units nearby). */
function pendingFor(world: World, fort: Fort): number {
  let n = 0;
  for (const u of world.spatial.queryOwners(fort.pos.x, fort.pos.z, garrisonRules(world).seek_radius_m + 20, 1 << fort.owner)) {
    const c = claims.get(u);
    if (c && c.fortId === fort.id && world.time <= c.until && u.fortId === null) n++;
  }
  return n;
}

/**
 * 2.1: a front that is not pushing mans its works — hold / fortify postures, and a cautious front
 * whose commander is holding its line (`mode === 'hold'`). Soak 2.0 at 30 min: 2 garrisoned
 * squads per seed, because only hold / fortify fronts looked for buildings at all.
 */
const steadyFront = (s: Front): boolean => s.posture === 'hold' || s.posture === 'fortify' || (s.posture === 'cautious' && s.mode === 'hold');

/** A non-cancelled fortified zone of the unit's faction held by this front (or by no front) runs within `zoneManM` of p. */
function inFrontZone(world: World, owner: number, s: Front, p: V2): boolean {
  for (const z of world.factions[owner]?.zones ?? []) {
    if (z.cancelled || (z.frontId !== null && z.frontId !== s.id)) continue;
    if (segDistance(p, z.a, z.b) <= STRUCT.zoneManM) return true;
  }
  return false;
}

/**
 * May `u` man `fort` under its current orders? Garrisons: buildings around their place. Line
 * troops of a steady front: around the battle line or along the front's fortified zones; of an
 * attacking front: only right at the line (they stay while it is still close).
 */
function mayHold(world: World, u: Unit, s: Front, fort: Fort): boolean {
  if (u.spearhead) return false;
  if (u.opRole === 'garrison') {
    if (u.opObjective === `hq:${u.owner}`) return dist(world.hqPos(u.owner), fort.pos) <= STRUCT.placeHoldM;
    const o = world.objectives.find((x) => x.id === u.opObjective);
    return !!o && dist(o.pos, fort.pos) <= o.radius + STRUCT.placeHoldM * 0.5;
  }
  if (u.opRole !== 'line') return false;
  if (steadyFront(s)) return dist(s.front, fort.pos) <= STRUCT.frontHoldM || inFrontZone(world, u.owner, s, fort.pos);
  if (s.posture === 'cautious' || s.posture === 'assault') return dist(s.front, fort.pos) <= STRUCT.frontAttackStayM;
  return false;
}

/** Occupant: hold the building (fight from it) while its orders keep it here. */
function holdGarrison(world: World, u: Unit, s: Front, g: Garrison): boolean {
  if (!mayHold(world, u, s, g.fort)) return false;
  stop(u);
  u.status = 'status.garrisoned';
  selectTarget(world, u, null);
  return true;
}

/** Holding troops (hold / fortify fronts, garrisons) go to a free building near their post. */
function seekGarrison(world: World, u: Unit, s: Front): boolean {
  if (u.def.kind === 'vehicle' || u.def.id === 'engineer' || u.mounted || u.fixed || isCommander(u.def)) return false;
  const c = claims.get(u);
  let fort = c && world.time <= c.until ? structuresOf(world).find((x) => x.id === c.fortId) ?? null : null;
  if (!fort) {
    claims.delete(u);
    if (world.time < (nextSeek.get(u) ?? -1)) return false;
    nextSeek.set(u, world.time + STRUCT.seekEverySeconds);
    if (u.spearhead || (u.opRole !== 'garrison' && !(u.opRole === 'line' && steadyFront(s))) || digsFirst(world, u)) return false;
    fort = pickBuilding(world, u, s);
    if (!fort) return false;
    claims.set(u, { fortId: fort.id, until: world.time + STRUCT.claimSeconds });
  }
  // Filled by someone else, or unreachable: give the claim up.
  if (!hasRoom(world, fort, structureDef(world, fort.kind as StructureKind), u) || (u.pathFailed && u.dest && dist(u.dest, fort.pos) < 20)) {
    claims.delete(u);
    return false;
  }
  if (dist(u.pos, fort.pos) > garrisonRules(world).enter_radius_m * 0.6) moveTo(world, u, fort.pos);
  else stop(u);
  u.status = 'status.enteringStructure';
  selectTarget(world, u, null);
  return true;
}

function pickBuilding(world: World, u: Unit, s: Front): Fort | null {
  const seekR = garrisonRules(world).seek_radius_m;
  let best: Fort | null = null;
  let bd = seekR;
  for (const fort of structuresOf(world)) {
    if (fort.owner !== u.owner || fort.progress < 1) continue;
    const d = dist(fort.pos, u.pos);
    if (d >= bd) continue;
    const def = structureDef(world, fort.kind as StructureKind);
    if (!accepts(def, u) || !mayHold(world, u, s, fort) || !hasRoom(world, fort, def, u, pendingFor(world, fort))) continue;
    bd = d;
    best = fort;
  }
  return best;
}

/**
 * Home-guard riflemen dig open capital works before they man buildings (homeguard.ensureDiggers
 * counts on them) — unless a finished capital building stands empty (every one gets a squad first).
 */
function digsFirst(world: World, u: Unit): boolean {
  if (u.def.kind !== 'infantry' || u.opObjective !== `hq:${u.owner}`) return false;
  const hq = world.hqPos(u.owner);
  for (const f of structuresOf(world)) {
    if (f.owner === u.owner && f.progress >= 1 && dist(f.pos, hq) <= STRUCT.placeHoldM && prune(world, f).length === 0) return false;
  }
  return openWork(world, u.owner, hq, STRUCT.placeHoldM) !== null;
}

/** Work an assigned site: trench / sandbag (works.dig, riflemen too) or a building (engineers). */
function work(world: World, u: Unit, fort: Fort): boolean {
  if (isStructure(fort.kind)) return buildStep(world, u, fort);
  if (fort.kind !== 'trench' && fort.kind !== 'sandbag') return false;
  return dig(u, fort, (p) => moveTo(world, u, p), () => stop(u));
}

/**
 * Unit-executor hook (behavior.thinkUnit, before roles and rally): man a building, work an
 * assigned building / trench site, or walk into a free building near the post.
 */
export function structureDuty(world: World, u: Unit, s: Front): boolean {
  if (u.fortId !== null) {
    const g = garrisonOf(u);
    if (g) return holdGarrison(world, u, s, g);
  }
  const jobId = jobOf(world, u);
  const onCall = u.opRole === 'line' || (u.opRole === 'garrison' && u.opObjective === `hq:${u.owner}`);
  if (jobId !== null && !onCall) dropJob(u);
  else if (jobId !== null && !u.routing && !u.spearhead && !u.manual) {
    const fort = world.fortById(jobId);
    if (!fort || fort.hp <= 0 || fort.progress >= 1 || enemyNear(world, u.owner, fort.pos, STRUCT.noBuildEnemyM)) dropJob(u);
    else if (work(world, u, fort)) {
      selectTarget(world, u, null);
      return true;
    } else dropJob(u);
  }
  return seekGarrison(world, u, s);
}

// ---------------------------------------------------------------- manning points (2.1, for the front planner)

/** One place a squad can fight from in a finished own work. */
export interface ManningSlot {
  readonly pos: V2;
  /** Direction the work faces (the enemy side). */
  readonly facing: number;
  readonly fortId: number;
  readonly kind: FortKind;
  /** Building slot already taken (by an occupant); trench points are never marked taken. */
  readonly taken: boolean;
}

/**
 * Manning points of the finished, standing works of `owner` within `r` of the segment a–b (b null:
 * of the point a): one per building slot (pillbox 1, bunker 2, where the occupant snaps to) and
 * two per trench bay, just behind the parapet. Buildings first (fill them before the trenches),
 * then trenches, each nearest the segment's centre first. O(works); call it per front think, not
 * per unit.
 */
export function structureSlots(world: World, owner: number, a: V2, b: V2 | null, r: number): ManningSlot[] {
  const end = b ?? a;
  const c = { x: (a.x + end.x) / 2, z: (a.z + end.z) / 2 };
  const bld: { s: ManningSlot; d: number }[] = [];
  const tr: { s: ManningSlot; d: number }[] = [];
  for (const w of world.forts) {
    if (w.owner !== owner || w.hp <= 0 || w.progress < 1 || segDistance(w.pos, a, end) > r) continue;
    const d = dist(w.pos, c);
    if (isStructure(w.kind)) {
      const cap = structureDef(world, w.kind).capacity;
      const occ = prune(world, w).length;
      for (let i = 0; i < cap; i++) bld.push({ s: { pos: slotPos(w, cap, i), facing: w.facing, fortId: w.id, kind: w.kind, taken: i < occ }, d });
    } else if (w.kind === 'trench' && w.start && w.end) {
      const st = w.start;
      const en = w.end;
      for (const t of STRUCT.trenchSlotT) {
        const pos = {
          x: st.x + (en.x - st.x) * t - Math.cos(w.facing) * STRUCT.trenchSlotBackM,
          z: st.z + (en.z - st.z) * t - Math.sin(w.facing) * STRUCT.trenchSlotBackM,
        };
        tr.push({ s: { pos, facing: w.facing, fortId: w.id, kind: w.kind, taken: false }, d });
      }
    }
  }
  const order = (x: { d: number; s: ManningSlot }, y: { d: number; s: ManningSlot }): number => x.d - y.d || x.s.fortId - y.s.fortId;
  return [...bld.sort(order), ...tr.sort(order)].map((x) => x.s);
}

/** Manning points of a fortified zone's finished works (buildings first, then trench bays). */
export function zoneSlots(world: World, f: Faction, zone: Zone): ManningSlot[] {
  return structureSlots(world, f.id, zone.a, zone.b, STRUCT.zoneSlotM);
}

/** Slots of the finished own buildings around the capital (where its garrison mans them). */
export function capitalBuildingSlots(world: World, owner: number): number {
  const hq = world.hqPos(owner);
  let n = 0;
  for (const w of structuresOf(world)) {
    if (w.owner === owner && w.progress >= 1 && dist(w.pos, hq) <= STRUCT.placeHoldM) n += structureDef(world, w.kind as StructureKind).capacity;
  }
  return n;
}

/** Share of the finished building slots of `owner` that are manned (soak metric; 1 when none). */
export function mannedShare(world: World, owner: number): { slots: number; manned: number } {
  let slots = 0;
  let manned = 0;
  for (const w of structuresOf(world)) {
    if (w.owner !== owner || w.progress < 1) continue;
    slots += structureDef(world, w.kind as StructureKind).capacity;
    manned += prune(world, w).length;
  }
  return { slots, manned };
}
