// 3.0 upgrade lab, low-noise part `engage` (WP-T): one fixed engagement per item on an open corridor,
// side A with the item (and its prerequisites), side B without; the same trial seed with no item is
// the control. 10 trials by default. Net = A value left − B value left (P+M × hp share, works count
// for the side that owns them); value/cost = (mean net with item − mean net control) / item cost.
// All scenarios field about the same army value (≈ 2 000–2 600 P+M), so value/cost is comparable.
//
//   tanks    6 medium tanks vs 6 medium tanks, 450 m apart, both attack-move   (armour_*, gun_*)
//   pillbox  10 rifle squads assault 3 manned pillboxes + 2 MG teams            (inf_guns)
//   grenade  8 rifle squads hold; 4 medium tanks attack-move through them      (ap_grenades)
//   battery  3 howitzers + 4 squads each side, 600 m apart (beyond 560 m range) (arty_range)
import type { GameData } from '../../src/data/types';
import { step } from '../../src/sim/sim';
import { bindOccupant, placeStructure, structureDef } from '../../src/sim/structures';
import type { Fort, Unit } from '../../src/sim/types';
import { grantUpgrade, upgradeCost, type UpgradeId } from '../../src/sim/upgrades';
import { type V2 } from '../../src/sim/vec';
import { loadData } from './common';
import { siteMatch } from './fgkit';

export type Scenario = 'tanks' | 'pillbox' | 'grenade' | 'battery';
export const ENGAGE_SCENARIO: Partial<Record<UpgradeId, Scenario>> = {
  armour_1: 'tanks', armour_2: 'tanks', armour_3: 'tanks', gun_1: 'tanks', gun_2: 'tanks', gun_3: 'tanks',
  inf_guns: 'pillbox', ap_grenades: 'grenade', arty_range: 'battery',
};

export interface EngageTask { kind: 'engage'; scenario: Scenario; item: UpgradeId | 'control'; trial: number; sets: string[] }
export interface EngageResult { ok: boolean; net: number; cost: number; aLeft: number; bLeft: number; kitShots: number }

const GAP: Record<Scenario, number> = { tanks: 450, pillbox: 420, grenade: 380, battery: 600 };
const MINUTES: Record<Scenario, number> = { tanks: 4, pillbox: 6, grenade: 4, battery: 5 };

const unitValue = (data: GameData, us: readonly Unit[]): number =>
  us.reduce((s, u) => { const d = data.units.get(u.def.id)!; return s + (u.hp > 0 && !u.routing ? (d.costP + d.costM) * (u.hp / u.def.maxHp) : 0); }, 0);
const worksValue = (data: GameData, fs: readonly Fort[]): number =>
  fs.reduce((s, f) => { const d = data.rules.construction.defensive.structures.find((x) => x.id === f.kind); return s + (d && f.hp > 0 ? (d.cost_p + d.cost_m) * (f.hp / f.maxHp) : 0); }, 0);

/** Item and its prerequisites, in order. */
function chain(id: UpgradeId, items: Record<string, { requires?: readonly string[] }>): UpgradeId[] {
  const out: UpgradeId[] = [];
  const add = (x: string): void => {
    for (const q of items[x]?.requires ?? []) add(q);
    if (!out.includes(x as UpgradeId)) out.push(x as UpgradeId);
  };
  add(id);
  return out;
}

export function runEngage(t: EngageTask): EngageResult {
  const data = loadData([...t.sets, 'upgrades.ai.enabled=false', 'capital_defence.enabled=false']);
  const empty: EngageResult = { ok: false, net: 0, cost: 0, aLeft: 0, bLeft: 0, kitShots: 0 };
  // The open corridor is checked up to 450 m (the battery's far side may stand on rougher ground).
  const found = siteMatch(data, 300 + t.trial, Math.min(GAP[t.scenario], 450));
  if (!found) return empty;
  const { m, site } = found;
  const w = m.world;
  for (const u of w.units.values()) u.hp = 0;
  w.removeDead();
  w.forts.length = 0;
  let cost = 0;
  if (t.item !== 'control') {
    for (const id of chain(t.item, data.rules.upgrades!.items)) {
      const c = upgradeCost(w, w.factions[0], id);
      cost += c.p + c.m;
      grantUpgrade(w, w.factions[0], id);
    }
  }
  const { def: a0, dir } = site;
  const side = { x: -dir.z, z: dir.x };
  const at = (s: number, l: number): V2 => ({ x: a0.x + dir.x * s + side.x * l, z: a0.z + dir.z * s + side.z * l });
  const gap = GAP[t.scenario];
  const aPos = at(0, 0);
  const bPos = at(gap, 0);
  const spawn = (owner: number, id: string, p: V2, face: V2): Unit => {
    const u = w.spawnUnit(owner, id, p, w.factions[owner].fronts[0]?.id ?? 0, { facingDeg: (Math.atan2(face.z - p.z, face.x - p.x) * 180) / Math.PI });
    u.behavior = 'advance';
    u.manual = { type: 'hold', pos: { ...p } };
    return u;
  };
  const line = (owner: number, id: string, n: number, s: number, gapM: number, face: V2): Unit[] =>
    Array.from({ length: n }, (_, i) => spawn(owner, id, at(s, (i - (n - 1) / 2) * gapM), face));
  const A: Unit[] = [];
  const B: Unit[] = [];
  const bWorks: Fort[] = [];
  const attackers: Unit[] = [];
  if (t.scenario === 'tanks') {
    A.push(...line(0, 'medium_tank', 6, 0, 26, bPos));
    B.push(...line(1, 'medium_tank', 6, gap, 26, aPos));
    attackers.push(...A, ...B);
  } else if (t.scenario === 'pillbox') {
    const facing = Math.atan2(-dir.z, -dir.x);
    for (const l of [-70, 0, 70]) {
      const f = placeStructure(w, 1, 'pillbox', at(gap, l), facing, 12);
      if (f) { f.progress = 1; bWorks.push(f); }
    }
    for (const f of bWorks) {
      const u = spawn(1, 'infantry', f.pos, aPos);
      if (structureDef(w, 'pillbox').accepts.includes('infantry')) bindOccupant(w, u, f);
      B.push(u);
    }
    B.push(...line(1, 'mg', 2, gap + 10, 100, aPos));
    A.push(...line(0, 'infantry', 10, 0, 18, bPos));
    attackers.push(...A);
  } else if (t.scenario === 'grenade') {
    A.push(...line(0, 'infantry', 8, 0, 20, bPos));
    B.push(...line(1, 'medium_tank', 4, gap, 30, aPos));
    attackers.push(...B);
  } else {
    A.push(...line(0, 'howitzer', 3, -20, 30, bPos), ...line(0, 'infantry', 4, 15, 25, bPos));
    B.push(...line(1, 'howitzer', 3, gap + 20, 30, aPos), ...line(1, 'infantry', 4, gap - 15, 25, aPos));
  }
  for (const u of attackers) u.manual = { type: 'attackMove', dest: u.owner === 0 ? { ...bPos } : { ...aPos }, clearSince: null };
  w.spatial.rebuild(w.aliveUnits);
  let kitShots = 0;
  const v = (): { a: number; b: number } => ({ a: unitValue(data, A), b: unitValue(data, B) + worksValue(data, bWorks) });
  const ticks = MINUTES[t.scenario] * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    step(m);
    // Kit use: attached-gun muzzles and AP-grenade blasts (upgradekit.ts emits both).
    for (const e of w.fx as readonly { t: string; weapon?: string; radius?: number; kind?: string }[]) {
      if ((e.t === 'muzzle' && e.weapon === 'inf_gun') || (e.t === 'explosion' && e.radius === 2 && e.kind === 'he')) kitShots++;
    }
    w.fx.length = 0;
    if (i % w.tickHz === 0) { const x = v(); if (x.a === 0 || x.b === 0) break; }
  }
  const end = v();
  return { ok: true, net: end.a - end.b, cost, aLeft: end.a, bLeft: end.b, kitShots };
}

export function engageTasks(items: readonly UpgradeId[], trials: number, sets: string[]): EngageTask[] {
  const scen = new Set<Scenario>();
  const out: EngageTask[] = [];
  for (const item of items) {
    const s = ENGAGE_SCENARIO[item];
    if (!s) continue;
    scen.add(s);
    for (let k = 1; k <= trials; k++) out.push({ kind: 'engage', scenario: s, item, trial: k, sets });
  }
  for (const s of scen) for (let k = 1; k <= trials; k++) out.push({ kind: 'engage', scenario: s, item: 'control', trial: k, sets });
  return out;
}

export interface EngageRow { item: string; scenario: Scenario; cost: number; delta: number; se: number; ratio: number; n: number; kit: number }

export function engageRows(tasks: readonly EngageTask[], res: readonly EngageResult[]): EngageRow[] {
  const ctrl = new Map<string, number>();
  tasks.forEach((t, i) => { if (t.item === 'control' && res[i].ok) ctrl.set(`${t.scenario}|${t.trial}`, res[i].net); });
  const rows: EngageRow[] = [];
  for (const item of [...new Set(tasks.filter((t) => t.item !== 'control').map((t) => t.item))]) {
    const ds: number[] = [];
    let cost = 0;
    let kit = 0;
    let scenario: Scenario = 'tanks';
    tasks.forEach((t, i) => {
      if (t.item !== item || !res[i].ok) return;
      const c = ctrl.get(`${t.scenario}|${t.trial}`);
      if (c === undefined) return;
      ds.push(res[i].net - c);
      cost = res[i].cost;
      kit += res[i].kitShots;
      scenario = t.scenario;
    });
    const mu = ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length);
    const se = ds.length > 1 ? Math.sqrt(ds.reduce((a, x) => a + (x - mu) ** 2, 0) / (ds.length - 1) / ds.length) : NaN;
    rows.push({ item, scenario, cost, delta: mu, se, ratio: mu / Math.max(1, cost), n: ds.length, kit });
  }
  return rows;
}
