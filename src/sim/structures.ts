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
import type { Faction, Fort, FortKind, Front, Unit } from './types';
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

/** Weapon the unit fires: the building's built-in gun when it has one, else its own primary. */
export const weaponOf = (u: Unit): WeaponDef | null => garrisonOf(u)?.weapon ?? u.primary;

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
  const occ = (fort.occupants ?? []).filter((id) => world.unitAlive(id)?.fortId === fort.id);
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

function enter(world: World, u: Unit, fort: Fort, def: DefensiveStructureDef): void {
  fort.occupants = [...prune(world, fort), u.id];
  fort.occupant = fort.occupants[0];
  u.fortId = fort.id;
  u.cover = def.cover;
  garrisons.set(u, { fort, def, weapon: def.weapon ? world.data.weapons.get(def.weapon) ?? null : null });
  claims.delete(u);
  snapToSlot(u, fort, def);
}

/** Leave a building (walked out, ordered away, or thrown out by its collapse). */
export function leaveStructure(world: World, u: Unit): void {
  const g = garrisons.get(u);
  garrisons.delete(u);
  const fort = g?.fort ?? (u.fortId !== null ? world.forts.find((x) => x.id === u.fortId) : undefined);
  u.fortId = null;
  if (fort) prune(world, fort);
}

/** Occupants sit at fixed slots (bunkers: side by side along the front face). */
function snapToSlot(u: Unit, fort: Fort, def: DefensiveStructureDef): void {
  const i = (fort.occupants ?? []).indexOf(u.id);
  const off = def.capacity > 1 ? (i - (def.capacity - 1) / 2) * STRUCT.slotSpreadM * 2 : 0;
  const along = fort.facing + Math.PI / 2;
  const x = fort.pos.x + Math.cos(along) * off;
  const z = fort.pos.z + Math.sin(along) * off;
  if (Math.hypot(u.pos.x - x, u.pos.z - z) > 0.8) {
    u.pos.x = x;
    u.pos.z = z;
  }
}

/** Finished, standing buildings of this world, recomputed once per tick (per-unit scans stay short). */
const structureCache = new WeakMap<World, { tick: number; list: Fort[] }>();
export function structuresOf(world: World): readonly Fort[] {
  let c = structureCache.get(world);
  if (!c || c.tick !== world.tick) {
    c = { tick: world.tick, list: world.forts.filter((f) => isStructure(f.kind) && f.hp > 0) };
    structureCache.set(world, c);
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
  const fort = world.forts.find((x) => x.id === u.fortId);
  if (!fort || !isStructure(fort.kind)) return null;
  if (fort.hp <= 0 || !(fort.occupants ?? []).includes(u.id)) {
    u.fortId = null;
    return null;
  }
  const def = structureDef(world, fort.kind);
  const g = { fort, def, weapon: def.weapon ? world.data.weapons.get(def.weapon) ?? null : null };
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
  fort.hp = Math.max(0, fort.hp - amount);
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

/** Where a holding unit may man buildings: its garrison place or its front's battle line. */
function holdAnchor(world: World, u: Unit, s: Front): { at: V2; r: number } | null {
  if (u.spearhead) return null;
  if (u.opRole === 'garrison') {
    if (u.opObjective === `hq:${u.owner}`) return { at: world.hqPos(u.owner), r: STRUCT.placeHoldM };
    const o = world.objectives.find((x) => x.id === u.opObjective);
    return o ? { at: o.pos, r: o.radius + STRUCT.placeHoldM * 0.5 } : null;
  }
  if (u.opRole !== 'line') return null;
  if (s.posture === 'hold' || s.posture === 'fortify') return { at: s.front, r: STRUCT.frontHoldM };
  if (s.posture === 'cautious' || s.posture === 'assault') return { at: s.front, r: STRUCT.frontAttackStayM };
  return null;
}

/** Occupant: hold the building (fight from it) while its orders keep it here. */
function holdGarrison(world: World, u: Unit, s: Front, g: Garrison): boolean {
  const anchor = holdAnchor(world, u, s);
  if (!anchor || dist(anchor.at, g.fort.pos) > anchor.r) return false;
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
    const anchor = s.posture === 'cautious' || s.posture === 'assault' ? null : holdAnchor(world, u, s);
    if (!anchor || digsFirst(world, u)) return false;
    fort = pickBuilding(world, u, anchor);
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

function pickBuilding(world: World, u: Unit, anchor: { at: V2; r: number }): Fort | null {
  const seekR = garrisonRules(world).seek_radius_m;
  let best: Fort | null = null;
  let bd = seekR;
  for (const fort of structuresOf(world)) {
    if (fort.owner !== u.owner || fort.progress < 1 || dist(fort.pos, anchor.at) > anchor.r) continue;
    const d = dist(fort.pos, u.pos);
    if (d >= bd) continue;
    const def = structureDef(world, fort.kind as StructureKind);
    if (!accepts(def, u) || !hasRoom(world, fort, def, u, pendingFor(world, fort))) continue;
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
    const fort = world.forts.find((x) => x.id === jobId);
    if (!fort || fort.hp <= 0 || fort.progress >= 1 || enemyNear(world, u.owner, fort.pos, STRUCT.noBuildEnemyM)) dropJob(u);
    else if (work(world, u, fort)) {
      selectTarget(world, u, null);
      return true;
    } else dropJob(u);
  }
  return seekGarrison(world, u, s);
}
