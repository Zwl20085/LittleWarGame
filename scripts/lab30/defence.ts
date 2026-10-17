// 3.0 `defence` lab suite (V30_SPEC §8, WP-G). Three experiments:
//
//  assault  — equal-cost tank-led assault (extends scripts/lab/at-assault.ts) against a defended
//             line at each works tier: open, trenches, pillboxes, bunkers, fortress line (fortresses
//             + AT emplacements + fortified trenches + a minefield). The attacker's force costs what
//             the defenders' units AND works cost. Acceptance: fortress line < 40 % attacker wins.
//  mines    — an armour raid (4 medium tanks + 2 motor infantry) through a corridor held by 2 AT guns,
//             with 0 / 1 / 2 minefield rows in front of the guns.
//  cheapwin — the 2.3 probes in a real AI war (4-FFA, warm-up W min): a backdoor detachment (15 % of
//             the challenger's army) and a big armour raid (20 tanks + 10 motor infantry) sent at the
//             nearest enemy capital, perimeter ON vs OFF. Acceptance: the backdoor never takes a
//             ringed capital; the armour raid still can, with real losses.
//
//   npx tsx scripts/lab30/defence.ts [--suite assault,mines,cheapwin] [--trials 8] [--seeds 7,11,13]
//                                    [--warmup 15] [--jobs 4]
import type { GameData } from '../../src/data/types';
import { perimeterOf } from '../../src/sim/capitalDefence';
import { startMinefield } from '../../src/sim/minefields';
import { createMatch, step } from '../../src/sim/sim';
import { bindOccupant, placeStructure, structureDef, type StructureKind } from '../../src/sim/structures';
import { Ground } from '../../src/sim/terrain';
import type { Fort, Unit } from '../../src/sim/types';
import { dist, type V2 } from '../../src/sim/vec';
import { WORKS } from '../../src/sim/works';
import type { World } from '../../src/sim/world';
import { arg, childTask, fanOut, labData, mulberry, reply, writeReport } from './fgkit';

const TANKS = new Set(['light_tank', 'medium_tank', 'heavy_tank']);
const NO_PERIMETER = ['capital_defence.enabled=false'];

const cost = (data: GameData, id: string): number => {
  const d = data.units.get(id)!;
  return d.costP + d.costM;
};
const value = (data: GameData, us: readonly Unit[]): number => us.reduce((s, u) => s + (u.hp > 0 && !u.routing ? cost(data, u.def.id) * (u.hp / u.def.maxHp) : 0), 0);

/** An open, gentle corridor `len` m long (no water, forest, town, buildings), at least 300 m from any capital. */
function findSite(w: World, rand: () => number, len: number): { def: V2; dir: V2 } | null {
  const t = w.terrain;
  for (let tries = 0; tries < 4000; tries++) {
    const p = { x: 300 + rand() * (t.width - 600), z: 300 + rand() * (t.depth - 600) };
    if (w.factions.some((f) => dist(w.hqPos(f.id), p) < 350)) continue;
    const a = rand() * Math.PI * 2;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    let ok = true;
    let steep = 0;
    let n = 0;
    for (let s = -60; s <= len + 40 && ok; s += 20) {
      for (let l = -60; l <= 60 && ok; l += 20) {
        const x = p.x + dir.x * s - dir.z * l;
        const z = p.z + dir.z * s + dir.x * l;
        if (!t.inBounds(x, z)) { ok = false; break; }
        const g = t.groundAt(x, z);
        if (g === Ground.Water || g === Ground.Ford || g === Ground.Forest || g === Ground.Town || t.buildingH(x, z) !== 0) ok = false;
        n++;
        if (t.slopeAt(x, z) > 14) steep++;
      }
    }
    if (ok && steep <= n * 0.1) return { def: p, dir };
  }
  return null;
}

/** A 2-faction map with a test corridor: the seed's map, else the next few seeds' (same trial → same map). */
function siteMatch(data: GameData, seed: number, len: number): { m: ReturnType<typeof createMatch>; site: { def: V2; dir: V2 } } | null {
  for (let k = 0; k < 6; k++) {
    const s = seed + k * 53;
    const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed: s, difficulty: 'normal', playerSlot: 0, spectate: false });
    const site = findSite(m.world, mulberry(s * 977 + 13), len);
    if (site) return { m, site };
  }
  return null;
}

// ---------------------------------------------------------------- assault vs tiers

type Tier = 'open' | 'trenches' | 'pillboxes' | 'bunkers' | 'fortress';
const TIERS: readonly Tier[] = ['open', 'trenches', 'pillboxes', 'bunkers', 'fortress'];
const DEFENDERS = ['at_gun', 'at_gun', 'infantry', 'infantry', 'infantry', 'infantry', 'mg', 'mg'];
const START_GAP = 480;
const DEPLOY_S = 25;
const LEAD_M = 40;

interface AssaultTask { kind: 'assault'; tier: Tier; seed: number; minutes: number }
interface AssaultResult { tier: Tier; ok: boolean; won: boolean; atkLeft: number; defLeft: number; tanksLost: number; tanks: number; atkCost: number; defCost: number; worksCost: number; defKills?: Record<string, number> }

/** Upgrade path cost of a building kind (pillbox → bunker → fortress) from the rules. */
function buildingCost(data: GameData, kind: StructureKind): number {
  const s = data.rules.construction.defensive.structures;
  const base = (id: string): number => { const d = s.find((x) => x.id === id)!; return d.cost_p + d.cost_m; };
  const up = (from: string): number => { const u = data.rules.construction.defensive.tiers!.upgrades.find((x) => x.from === from)!; return u.cost_p + u.cost_m; };
  if (kind === 'bunker') return base('pillbox') + up('pillbox');
  if (kind === 'fortress') return base('pillbox') + up('pillbox') + up('bunker');
  return base(kind);
}

function trench(w: World, owner: number, c: V2, facing: number, tier: number): Fort {
  const along = facing + Math.PI / 2;
  const h = WORKS.trench.length / 2;
  const mul = tier > 0 ? w.data.rules.construction.defensive.tiers!.upgrades.find((x) => x.from === 'trench')!.hp_mul ?? 1 : 1;
  const f: Fort = {
    id: w.newId(), owner, kind: 'trench', pos: { ...c }, facing, tier,
    start: { x: c.x - Math.cos(along) * h, z: c.z - Math.sin(along) * h }, end: { x: c.x + Math.cos(along) * h, z: c.z + Math.sin(along) * h },
    length: WORKS.trench.length, hp: WORKS.trench.hp * mul, maxHp: WORKS.trench.hp * mul, progress: 1, occupant: null,
  };
  w.forts.push(f);
  return f;
}

function runAssault(t: AssaultTask): AssaultResult {
  const data = labData(NO_PERIMETER);
  const empty: AssaultResult = { tier: t.tier, ok: false, won: false, atkLeft: 0, defLeft: 0, tanksLost: 0, tanks: 0, atkCost: 0, defCost: 0, worksCost: 0 };
  const found = siteMatch(data, t.seed, START_GAP);
  if (!found) return empty;
  const { m, site } = found;
  const w = m.world;
  for (const u of w.units.values()) u.hp = 0;
  w.removeDead();
  w.forts.length = 0;
  const { def, dir } = site;
  const side = { x: -dir.z, z: dir.x };
  const at = (s: number, l: number): V2 => ({ x: def.x + dir.x * s + side.x * l, z: def.z + dir.z * s + side.z * l });
  const facing = Math.atan2(dir.z, dir.x);
  const k = data.rules.proposed_defaults.army_scale ?? 1;
  const spawn = (owner: number, id: string, p: V2, face: V2): Unit => {
    const u = w.spawnUnit(owner, id, p, w.factions[owner].fronts[0]?.id ?? 0, { facingDeg: (Math.atan2(face.z - p.z, face.x - p.x) * 180) / Math.PI });
    u.behavior = 'advance';
    return u;
  };
  const atkPos = at(START_GAP, 0);
  // Works for the tier.
  let worksCost = 0;
  const buildings: Fort[] = [];
  const addBuilding = (kind: StructureKind, p: V2): void => {
    const f = placeStructure(w, 1, kind, p, facing, 12);
    if (f) { buildings.push(f); worksCost += buildingCost(data, kind); }
  };
  const trenchCost = WORKS.trench.costP * k;
  const fortTrench = data.rules.construction.defensive.tiers!.upgrades.find((x) => x.from === 'trench')!;
  if (t.tier !== 'open') {
    const tierN = t.tier === 'fortress' ? 1 : 0;
    for (const l of [-50, 50]) { trench(w, 1, at(10, l), facing, tierN); worksCost += trenchCost + (tierN ? fortTrench.cost_p + fortTrench.cost_m : 0); }
  }
  if (t.tier === 'pillboxes') for (const l of [-90, 0, 90]) addBuilding('pillbox', at(-4, l));
  if (t.tier === 'bunkers') for (const l of [-90, 0, 90]) addBuilding('bunker', at(-4, l));
  if (t.tier === 'fortress') {
    for (const l of [-90, 90]) addBuilding('fortress', at(-4, l));
    for (const l of [-30, 30]) addBuilding('at_emplacement', at(-10, l));
    const f = w.factions[1];
    f.p = 1e5; f.m = 1e5;
    if (startMinefield(w, f, at(90, 0), facing)) {
      const mf = data.rules.construction.defensive.tiers!.minefield;
      worksCost += mf.cost_p + mf.cost_m;
      w.forts[w.forts.length - 1].progress = 1;
    }
  }
  // Defenders: into the buildings that take them, the rest along the trenches / line.
  const defs: Unit[] = [];
  DEFENDERS.forEach((id, i) => defs.push(spawn(1, id, at(18, (i - (DEFENDERS.length - 1) / 2) * 22), atkPos)));
  for (const u of defs) {
    const b = buildings.find((f) => structureDef(w, f.kind as StructureKind).accepts.includes(u.def.id) && (f.occupants?.length ?? 0) < structureDef(w, f.kind as StructureKind).capacity
      && (u.def.kind !== 'crew' || (f.occupants ?? []).filter((id) => w.unitAlive(id)?.def.kind === 'crew').length < structureDef(w, f.kind as StructureKind).max_crews));
    if (b) { u.pos = { ...b.pos }; bindOccupant(w, u, b); }
    u.manual = { type: 'hold', pos: { ...u.pos } };
  }
  const defCost = DEFENDERS.reduce((s, id) => s + cost(data, id), 0);
  // Attacker of equal cost: tank-led (tank, rifle, rifle, …).
  const atkIds: string[] = [];
  const cycle = ['medium_tank', 'infantry', 'infantry'];
  let ac = 0;
  for (let i = 0; ac < defCost + worksCost; i++) { atkIds.push(cycle[i % 3]); ac += cost(data, cycle[i % 3]); }
  const tanks = atkIds.filter((id) => TANKS.has(id));
  const inf = atkIds.filter((id) => !TANKS.has(id));
  const atks: Unit[] = [];
  tanks.forEach((id, i) => atks.push(spawn(0, id, at(START_GAP, (i - (tanks.length - 1) / 2) * 26), def)));
  inf.forEach((id, i) => atks.push(spawn(0, id, at(START_GAP + 25, (i - (inf.length - 1) / 2) * 22), def)));
  for (const u of atks) u.manual = { type: 'hold', pos: { ...u.pos } };
  w.spatial.rebuild(w.aliveUnits);
  const v0a = value(data, atks);
  const v0d = value(data, defs);
  const ticks = t.minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    if (w.time > DEPLOY_S && i % w.tickHz === 0) {
      const liveInf = atks.filter((u) => u.hp > 0 && !TANKS.has(u.def.id));
      const c = liveInf.length ? { x: liveInf.reduce((s, u) => s + u.pos.x, 0) / liveInf.length, z: liveInf.reduce((s, u) => s + u.pos.z, 0) / liveInf.length } : def;
      for (const u of atks) {
        if (u.hp <= 0 || u.routing) continue;
        if (!TANKS.has(u.def.id) || !liveInf.length) { u.manual = { type: 'attackMove', dest: { ...def }, clearSince: null }; continue; }
        const d = Math.hypot(def.x - c.x, def.z - c.z) || 1;
        const lead = Math.min(d, LEAD_M);
        u.manual = { type: 'attackMove', dest: { x: c.x + ((def.x - c.x) / d) * lead + side.x * ((u.id % 3) - 1) * 20, z: c.z + ((def.z - c.z) / d) * lead + side.z * ((u.id % 3) - 1) * 20 }, clearSince: null };
      }
    }
    step(m);
    w.fx.length = 0;
    if (i % w.tickHz === 0 && (value(data, atks) === 0 || value(data, defs) === 0)) break;
  }
  const atkLeft = value(data, atks) / v0a;
  const defLeft = value(data, defs) / v0d;
  return {
    tier: t.tier, ok: true, won: atkLeft > defLeft, atkLeft, defLeft,
    tanksLost: atks.filter((u) => TANKS.has(u.def.id) && u.hp <= 0).length, tanks: tanks.length, atkCost: ac, defCost, worksCost,
    // Kill value by defender type (which part of the line does the killing).
    defKills: Object.fromEntries(Object.entries(w.stats.byType[1] ?? {}).map(([k, v]) => [k, Math.round(v.killValue)])),
    // Per side and type: shots / damage dealt / damage taken (diagnosis; LAB_TASK single runs).
    sides: [0, 1].map((f) => Object.fromEntries(Object.entries(w.stats.byType[f] ?? {}).map(([k, v]) => [k, [v.shots, Math.round(v.dmgDealt), Math.round(v.dmgTaken)]]))),
  };
}

// ---------------------------------------------------------------- raids vs minefields

interface MinesTask { kind: 'mines'; rows: number; seed: number }
interface MinesResult { rows: number; ok: boolean; arrived: number; arriveS: number; tankHpLost: number; tanksLost: number; gunsLost: number; detonations: number; fields?: number }

function runMines(t: MinesTask): MinesResult {
  const data = labData(NO_PERIMETER);
  const empty: MinesResult = { rows: t.rows, ok: false, arrived: 0, arriveS: 0, tankHpLost: 0, tanksLost: 0, gunsLost: 0, detonations: 0 };
  const found = siteMatch(data, t.seed, 500);
  if (!found) return empty;
  const { m, site } = found;
  const w = m.world;
  for (const u of w.units.values()) u.hp = 0;
  w.removeDead();
  w.forts.length = 0;
  const { def, dir } = site;
  const side = { x: -dir.z, z: dir.x };
  const at = (s: number, l: number): V2 => ({ x: def.x + dir.x * s + side.x * l, z: def.z + dir.z * s + side.z * l });
  const facing = Math.atan2(dir.z, dir.x);
  const f1 = w.factions[1];
  f1.p = 1e5; f1.m = 1e5;
  const lenM = data.rules.construction.defensive.tiers!.minefield.length_m;
  for (let r = 0; r < t.rows; r++) for (const l of [-lenM, 0, lenM]) {
    if (startMinefield(w, f1, at(150 + r * 40, l), facing)) w.forts[w.forts.length - 1].progress = 1;
  }
  const guns = [-40, 40].map((l) => { const u = w.spawnUnit(1, 'at_gun', at(60, l), f1.fronts[0].id); u.manual = { type: 'hold', pos: { ...u.pos } }; return u; });
  const raid: Unit[] = [];
  for (let i = 0; i < 4; i++) raid.push(w.spawnUnit(0, 'medium_tank', at(480, (i - 1.5) * 25), w.factions[0].fronts[0].id));
  for (let i = 0; i < 2; i++) raid.push(w.spawnUnit(0, 'motor_inf', at(500, (i - 0.5) * 30), w.factions[0].fronts[0].id));
  const goal = at(-40, 0);
  for (const u of raid) u.manual = { type: 'attackMove', dest: { ...goal }, clearSince: null };
  w.spatial.rebuild(w.aliveUnits);
  const tankHp0 = raid.filter((u) => TANKS.has(u.def.id)).reduce((s, u) => s + u.hp, 0);
  const mines0 = w.forts.filter((f) => f.kind === 'minefield').reduce((s, f) => s + f.hp, 0);
  let arriveS = 0;
  for (let i = 0; i < 6 * 60 * w.tickHz; i++) {
    step(m);
    w.fx.length = 0;
    if (i % w.tickHz === 0 && !arriveS && raid.some((u) => u.hp > 0 && TANKS.has(u.def.id) && dist(u.pos, goal) < 60)) arriveS = w.time;
    if (i % w.tickHz === 0 && raid.every((u) => u.hp <= 0)) break;
  }
  const tanks = raid.filter((u) => TANKS.has(u.def.id));
  const charge = data.rules.construction.defensive.tiers!.minefield.charge_hp;
  return {
    rows: t.rows, ok: true, fields: w.forts.filter((f) => f.kind === 'minefield').length, arrived: tanks.filter((u) => u.hp > 0).length, arriveS,
    tankHpLost: 1 - tanks.reduce((s, u) => s + Math.max(0, u.hp), 0) / tankHp0, tanksLost: tanks.filter((u) => u.hp <= 0).length,
    gunsLost: guns.filter((u) => u.hp <= 0).length, detonations: Math.round((mines0 - w.forts.filter((f) => f.kind === 'minefield').reduce((s, f) => s + Math.max(0, f.hp), 0)) / charge),
  };
}

// ---------------------------------------------------------------- cheap-win probes in an AI war

interface CheapTask { kind: 'cheapwin'; probe: 'backdoor' | 'armour'; ring: boolean; seed: number; warmup: number; minutes: number }
interface CheapResult { probe: string; ring: boolean; seed: number; ok: boolean; target: number; taken: boolean; takenAfterS: number; forceValue: number; armyShare: number; lostShare: number; perimeterLeft: number }

function runCheap(t: CheapTask): CheapResult {
  const data = labData(t.ring ? [] : ['capital_defence.enabled=false']);
  const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed: t.seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const run = (s: number): void => { for (let i = 0; i < s * w.tickHz && !w.result; i++) { step(m); w.fx.length = 0; } };
  run(t.warmup * 60);
  const me = 0;
  const empty: CheapResult = { probe: t.probe, ring: t.ring, seed: t.seed, ok: false, target: -1, taken: false, takenAfterS: 0, forceValue: 0, armyShare: 0, lostShare: 0, perimeterLeft: 0 };
  if (!w.factions[me].alive) return empty;
  const home = w.hqPos(me);
  const target = w.factions.filter((f) => f.id !== me && f.alive).sort((a, b) => dist(w.hqPos(a.id), home) - dist(w.hqPos(b.id), home))[0];
  if (!target) return empty;
  const goal = w.hqPos(target.id);
  const army = w.aliveUnits.filter((u) => u.owner === me && u.hp > 0 && !u.fixed && u.def.id !== 'supply_truck' && u.def.id !== 'commander');
  const armyValue = value(data, army);
  let force: Unit[] = [];
  if (t.probe === 'backdoor') {
    // ≤ 15 % of the army: the squads nearest the target capital.
    let v = 0;
    for (const u of [...army].sort((a, b) => dist(a.pos, goal) - dist(b.pos, goal) || a.id - b.id)) {
      const c = cost(data, u.def.id) * (u.hp / u.def.maxHp);
      if (v + c > armyValue * 0.15) continue;
      v += c;
      force.push(u);
    }
  } else {
    // 20 tanks + 10 motorized infantry gathered 900 m out on the line from home (the 2.3 armour raid).
    const d = dist(home, goal) || 1;
    const stage = { x: goal.x + ((home.x - goal.x) / d) * 900, z: goal.z + ((home.z - goal.z) / d) * 900 };
    const nav = w.nav(true, 35);
    const p = nav.nearestPassable(stage, 200) ?? stage;
    for (let i = 0; i < 30; i++) {
      const id = i < 20 ? (i % 4 === 0 ? 'heavy_tank' : 'medium_tank') : 'motor_inf';
      force.push(w.spawnUnit(me, w.data.units.has(id) ? id : 'medium_tank', { x: p.x + ((i % 6) - 2.5) * 14, z: p.z + (Math.floor(i / 6) - 2) * 14 }, w.factions[me].fronts[0].id));
    }
    w.spatial.rebuild(w.aliveUnits);
  }
  force = force.filter((u) => u.hp > 0);
  const v0 = value(data, force);
  for (const u of force) u.manual = { type: 'attackMove', dest: { ...goal }, clearSince: null };
  const t0 = w.time;
  let takenAt = 0;
  for (let s = 0; s < t.minutes * 60 && !w.result; s++) {
    run(1);
    if (s % 10 === 0) for (const u of force) if (u.hp > 0 && !u.manual) u.manual = { type: 'attackMove', dest: { ...goal }, clearSince: null };
    if (!target.alive) { takenAt = w.time - t0; break; }
  }
  return {
    probe: t.probe, ring: t.ring, seed: t.seed, ok: true, target: target.id, taken: !target.alive && takenAt > 0, takenAfterS: Math.round(takenAt),
    forceValue: Math.round(v0), armyShare: t.probe === 'backdoor' ? v0 / Math.max(1, armyValue) : v0 / Math.max(1, armyValue + v0),
    lostShare: 1 - value(data, force) / Math.max(1, v0), perimeterLeft: perimeterOf(w, target.id).filter((f) => f.hp > 0).length,
  };
}

// ---------------------------------------------------------------- driver

type Task = AssaultTask | MinesTask | CheapTask;

function runTask(t: Task): unknown {
  return t.kind === 'assault' ? runAssault(t) : t.kind === 'mines' ? runMines(t) : runCheap(t);
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main(): Promise<void> {
  const suites = arg('suite', 'assault,mines,cheapwin').split(',');
  const trials = Number(arg('trials', '8'));
  const seeds = arg('seeds', '7,11,13').split(',').map(Number);
  const warmup = Number(arg('warmup', '15'));
  const jobs = Number(arg('jobs', '4'));
  const tasks: Task[] = [];
  const tierSel = arg('tiers', TIERS.join(',')).split(',');
  if (suites.includes('assault')) for (const tier of TIERS.filter((x) => tierSel.includes(x))) for (let s = 1; s <= trials; s++) tasks.push({ kind: 'assault', tier, seed: 100 + s, minutes: 5 });
  if (suites.includes('mines')) for (const rows of [0, 1, 2]) for (let s = 1; s <= trials; s++) tasks.push({ kind: 'mines', rows, seed: 200 + s });
  if (suites.includes('cheapwin')) for (const probe of ['backdoor', 'armour'] as const) for (const ring of [false, true]) for (const seed of seeds) tasks.push({ kind: 'cheapwin', probe, ring, seed, warmup, minutes: 10 });
  const res = await fanOut<Task, Record<string, unknown>>('scripts/lab30/defence.ts', tasks, jobs);
  const lines: string[] = ['# lab30 defence', '', `Generated ${new Date().toISOString()} — trials ${trials}, seeds ${seeds.join(',')}, warm-up ${warmup} min.`, ''];
  const assault = res.filter((r) => 'tier' in r && r.ok) as unknown as AssaultResult[];
  if (assault.length) {
    lines.push('## Equal-cost tank-led assault vs works tier', '', '| tier | trials | attacker wins | win % | attacker value left | defender value left | tanks lost | attacker cost | defender units + works cost |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    const killLines: string[] = [];
    for (const tier of TIERS) {
      const r = assault.filter((x) => x.tier === tier);
      if (!r.length) continue;
      const wins = r.filter((x) => x.won).length;
      const kills: Record<string, number> = {};
      for (const x of r) for (const [k, v] of Object.entries(x.defKills ?? {})) kills[k] = (kills[k] ?? 0) + v;
      killLines.push(`- ${tier}: defender kill value by type ${Object.entries(kills).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
      lines.push(`| ${tier} | ${r.length} | ${wins} | ${pct(wins / r.length)} | ${pct(mean(r.map((x) => x.atkLeft)))} | ${pct(mean(r.map((x) => x.defLeft)))} | ${r.reduce((s, x) => s + x.tanksLost, 0)}/${r.reduce((s, x) => s + x.tanks, 0)} | ${Math.round(mean(r.map((x) => x.atkCost)))} | ${Math.round(mean(r.map((x) => x.defCost)))} + ${Math.round(mean(r.map((x) => x.worksCost)))} |`);
    }
    lines.push('', ...killLines, '');
  }
  const mines = res.filter((r) => 'rows' in r && r.ok) as unknown as MinesResult[];
  if (mines.length) {
    lines.push('## Armour raid (4 medium tanks + 2 motor inf) vs 2 AT guns behind minefield rows', '', '| minefield rows | trials | tanks surviving | mean arrival (s) | tank HP lost | tanks lost | AT guns lost | detonations |', '|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const rows of [0, 1, 2]) {
      const r = mines.filter((x) => x.rows === rows);
      if (!r.length) continue;
      const arr = r.filter((x) => x.arriveS > 0);
      lines.push(`| ${rows} | ${r.length} | ${r.reduce((s, x) => s + x.arrived, 0)}/${r.length * 4} | ${arr.length ? Math.round(mean(arr.map((x) => x.arriveS))) : '-'} | ${pct(mean(r.map((x) => x.tankHpLost)))} | ${r.reduce((s, x) => s + x.tanksLost, 0)} | ${r.reduce((s, x) => s + x.gunsLost, 0)} | ${r.reduce((s, x) => s + x.detonations, 0)} |`);
    }
    lines.push('');
  }
  const cheap = res.filter((r) => 'probe' in r) as unknown as CheapResult[];
  if (cheap.length) {
    lines.push('## Cheap-win probes at the nearest enemy capital (AI war, 4-FFA)', '', '| probe | perimeter | seed | target | force value | share of army | capital taken | after (s) | force lost | strongpoints left |', '|---|---|---:|---:|---:|---:|---|---:|---:|---:|');
    for (const r of cheap) {
      lines.push(r.ok ? `| ${r.probe} | ${r.ring ? 'on' : 'off'} | ${r.seed} | ${r.target} | ${r.forceValue} | ${pct(r.armyShare)} | ${r.taken ? 'YES' : 'no'} | ${r.taken ? r.takenAfterS : '-'} | ${pct(r.lostShare)} | ${r.perimeterLeft} |` : `| ${r.probe} | ${r.ring ? 'on' : 'off'} | ${r.seed} | - | challenger eliminated during warm-up | | | | | |`);
    }
    lines.push('');
  }
  const md = lines.join('\n');
  console.log(md);
  console.log(`report: ${writeReport('defence', md, res)}.md`);
}

const task = childTask<Task>();
if (task) reply(runTask(task));
else void main();
