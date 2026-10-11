// AT-line lab (V22_SPEC §2): a tank-led assault against an anti-tank gun + infantry line of
// equal cost, on open ground picked from generated maps. The AI does not command these units:
// both sides get manual orders (defenders hold, attackers advance with the tanks leading the
// infantry by ~40 m), so the result isolates the weapon numbers.
//
//   npx tsx scripts/lab/at-assault.ts [--trials 12] [--minutes 4] [--set weapon.at_cannon.damage=600]...
//   --vs "name:override;override"   compare several variants on the same trials
import { readFileSync } from 'node:fs';
import { buildGameData } from '../../src/data/loader';
import type { GameData } from '../../src/data/types';
import { createMatch, step } from '../../src/sim/sim';
import { Ground } from '../../src/sim/terrain';
import type { Unit } from '../../src/sim/types';
import type { V2 } from '../../src/sim/vec';
import type { World } from '../../src/sim/world';
import { applyOverrides, parseOverride, type DataText } from './overrides';

interface Force {
  readonly name: string;
  readonly attack: readonly string[];
  readonly defend: readonly string[];
}

/** Equal-cost pairings (P + M): see the cost line printed per force. */
const FORCES: readonly Force[] = [
  { name: 'medium', attack: ['medium_tank', 'medium_tank', 'infantry', 'infantry', 'infantry'], defend: ['at_gun', 'at_gun', 'at_gun', 'infantry', 'infantry', 'infantry', 'infantry', 'mg'] },
  { name: 'mixed', attack: ['medium_tank', 'light_tank', 'light_tank', 'infantry', 'infantry'], defend: ['at_gun', 'at_gun', 'at_gun', 'at_gun', 'infantry', 'infantry', 'mg'] },
];

const TANKS = new Set(['light_tank', 'medium_tank', 'heavy_tank']);
const START_GAP = 460;
const DEPLOY_S = 25;
const LEAD_M = 40;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]); });
  return out;
}

const cost = (data: GameData, id: string): number => {
  const d = data.units.get(id)!;
  return d.costP + d.costM;
};

/** A 600 × 160 m corridor of open, gentle ground (no water, forest, town, buildings). */
function findSite(w: World, rand: () => number): { def: V2; dir: V2 } | null {
  const t = w.terrain;
  for (let tries = 0; tries < 4000; tries++) {
    const p = { x: 300 + rand() * (t.width - 600), z: 300 + rand() * (t.depth - 600) };
    const a = rand() * Math.PI * 2;
    const dir = { x: Math.cos(a), z: Math.sin(a) };
    let ok = true;
    let steep = 0;
    let n = 0;
    for (let s = -40; s <= START_GAP + 40 && ok; s += 20) {
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

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface Trial {
  readonly attackerWon: boolean;
  readonly atkLeft: number;
  readonly defLeft: number;
  readonly tanksLost: number;
  readonly tanks: number;
  readonly atLost: number;
  readonly atKillsTanks: number;
  readonly atCost: number;
}

function runTrial(data: GameData, force: Force, seed: number, minutes: number): Trial | null {
  const m = createMatch(data, { mapId: 'generated', factions: 2, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: false });
  const w = m.world;
  const site = findSite(w, mulberry(seed * 977 + 13));
  if (!site) return null;
  // Clear the board: only the lab forces fight.
  for (const u of w.units.values()) if (!u.fixed) u.hp = 0;
  w.removeDead();
  const { def, dir } = site;
  const side = { x: -dir.z, z: dir.x };
  const at = (s: number, l: number): V2 => ({ x: def.x + dir.x * s + side.x * l, z: def.z + dir.z * s + side.z * l });
  const facingTo = (from: V2, to: V2): number => (Math.atan2(to.z - from.z, to.x - from.x) * 180) / Math.PI;
  const spawn = (owner: number, id: string, p: V2, face: V2): Unit => {
    const u = w.spawnUnit(owner, id, p, w.factions[owner].fronts[0]?.id ?? 0, { facingDeg: facingTo(p, face) });
    u.behavior = 'advance';
    return u;
  };
  const atkPos = at(START_GAP, 0);
  const defs: Unit[] = [];
  const guns = force.defend.filter((id) => id === 'at_gun');
  const others = force.defend.filter((id) => id !== 'at_gun');
  guns.forEach((id, i) => defs.push(spawn(1, id, at(0, (i - (guns.length - 1) / 2) * 45), atkPos)));
  others.forEach((id, i) => defs.push(spawn(1, id, at(12, (i - (others.length - 1) / 2) * 35), atkPos)));
  for (const u of defs) u.manual = { type: 'hold', pos: { ...u.pos } };
  const atks: Unit[] = [];
  const tanks = force.attack.filter((id) => TANKS.has(id));
  const inf = force.attack.filter((id) => !TANKS.has(id));
  tanks.forEach((id, i) => atks.push(spawn(0, id, at(START_GAP, (i - (tanks.length - 1) / 2) * 30), def)));
  inf.forEach((id, i) => atks.push(spawn(0, id, at(START_GAP + 25, (i - (inf.length - 1) / 2) * 30), def)));
  for (const u of atks) u.manual = { type: 'hold', pos: { ...u.pos } };
  const value = (us: Unit[]): number => us.reduce((s, u) => s + (u.hp > 0 && !u.routing ? cost(data, u.def.id) * (u.hp / u.def.maxHp) : 0), 0);
  const v0a = value(atks);
  const v0d = value(defs);
  const ticks = minutes * 60 * w.tickHz;
  for (let i = 0; i < ticks && !w.result; i++) {
    if (w.time > DEPLOY_S && i % w.tickHz === 0) {
      // Infantry advance on the line; tanks lead them by LEAD_M (never dribble in alone).
      const liveInf = atks.filter((u) => u.hp > 0 && !TANKS.has(u.def.id));
      const c = liveInf.length ? { x: liveInf.reduce((s, u) => s + u.pos.x, 0) / liveInf.length, z: liveInf.reduce((s, u) => s + u.pos.z, 0) / liveInf.length } : def;
      for (const u of atks) {
        if (u.hp <= 0 || u.routing) continue;
        if (!TANKS.has(u.def.id) || !liveInf.length) {
          u.manual = { type: 'attackMove', dest: { ...def }, clearSince: null };
          continue;
        }
        const d = Math.hypot(def.x - c.x, def.z - c.z) || 1;
        const lead = Math.min(d, LEAD_M);
        u.manual = { type: 'attackMove', dest: { x: c.x + ((def.x - c.x) / d) * lead + side.x * (u.id % 3 - 1) * 20, z: c.z + ((def.z - c.z) / d) * lead + side.z * (u.id % 3 - 1) * 20 }, clearSince: null };
      }
    }
    step(m);
    w.fx.length = 0;
    if (i % w.tickHz === 0 && (value(atks) === 0 || value(defs) === 0)) break;
  }
  const atkLeft = value(atks) / v0a;
  const defLeft = value(defs) / v0d;
  const mx = w.stats.matrix['at_gun'] ?? {};
  return {
    attackerWon: atkLeft > defLeft,
    atkLeft, defLeft,
    tanksLost: atks.filter((u) => TANKS.has(u.def.id) && u.hp <= 0).length,
    tanks: tanks.length,
    atLost: defs.filter((u) => u.def.id === 'at_gun' && u.hp <= 0).length,
    atKillsTanks: [...TANKS].reduce((s, v) => s + (mx[v]?.kills ?? 0), 0),
    atCost: guns.length * cost(data, 'at_gun'),
  };
}

const base: DataText = {
  units: readFileSync('docs/data/units.csv', 'utf8'),
  weapons: readFileSync('docs/data/weapons.csv', 'utf8'),
  rules: readFileSync('docs/data/rules.json', 'utf8'),
};
const variants: { name: string; overrides: string[] }[] = [{ name: 'current', overrides: args('set') }];
for (const v of args('vs')) {
  const [name, rest] = v.split(':');
  variants.push({ name, overrides: (rest ?? '').split(';').filter(Boolean) });
}
const trials = Number(arg('trials', '12'));
const minutes = Number(arg('minutes', '4'));
console.log('| variant | force | trials | attacker wins | attacker value left | defender value left | tanks lost | AT guns lost | AT tank kills / 1k AT cost |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const v of variants) {
  const text = applyOverrides(base, v.overrides.map(parseOverride));
  const data = buildGameData(text.units, text.weapons, text.rules);
  for (const force of FORCES) {
    const res: Trial[] = [];
    for (let s = 1; res.length < trials && s < trials * 3; s++) {
      const r = runTrial(data, force, 100 + s, minutes);
      if (r) res.push(r);
    }
    const n = res.length || 1;
    const sum = (f: (t: Trial) => number): number => res.reduce((s, t) => s + f(t), 0);
    const ac = force.attack.reduce((s, id) => s + cost(data, id), 0);
    const dc = force.defend.reduce((s, id) => s + cost(data, id), 0);
    console.log(`| ${v.name} | ${force.name} (${ac} vs ${dc}) | ${res.length} | ${sum((t) => (t.attackerWon ? 1 : 0))} | ${(sum((t) => t.atkLeft) / n * 100).toFixed(0)}% | ${(sum((t) => t.defLeft) / n * 100).toFixed(0)}% | ${sum((t) => t.tanksLost)}/${sum((t) => t.tanks)} | ${sum((t) => t.atLost)}/${n * force.defend.filter((x) => x === 'at_gun').length} | ${(sum((t) => t.atKillsTanks) / sum((t) => t.atCost) * 1000).toFixed(2)} |`);
  }
}
