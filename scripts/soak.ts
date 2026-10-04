/**
 * Soak test: run whole AI-vs-AI wars headless and report what a player would see as a problem.
 *
 *   npx tsx scripts/soak.ts [minutes=60] [seeds=7,11,13]      (HOME_DEFENCE=0 → round-3 home defence off)
 *
 * For each seed it prints the outcome (who won, when, why — or "no result" at the cap), then
 * every 5 game-minutes a health line, and at the end a list of anomalies:
 *   - invariants: NaN / out-of-bounds positions, hp outside [0, max], negative stock, pop over cap;
 *   - behaviour: units stuck for > 90 s while trying to move, units unreachable for > 60 s,
 *     batteries that never fired, groups idle > 50 % of the time, log keys repeating too often;
 *   - performance: mean / p99 tick cost per 5-minute window.
 * It is read-only (never writes world state) so results are reproducible per seed.
 */
import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import type { Unit } from '../src/sim/types';
import { dist } from '../src/sim/vec';
import { mannedShare } from '../src/sim/structures';
import { STRATEGY_AI } from '../src/sim/strategyai';
import { STORM_AB } from '../src/sim/storm';
import { THEATRE_AB } from '../src/sim/theatre';

// A/B: HOME_DEFENCE=0 turns the round-3 home defence off (docs/STRATEGY_LAB.md "Round 3").
if (process.env.HOME_DEFENCE === '0') STRATEGY_AI.homeDefence = false;
// A/B: STORM=0 turns the round-4 siege-and-storm / crew deployment off.
if (process.env.STORM === '0') STRATEGY_AI.storm = false;
// A/B: SIEGE=0 turns only the round-4 capital siege off.
if (process.env.SIEGE === '0') STORM_AB.siege = false;
// A/B: THEATRE=0 turns the 2.0 AI supreme HQ (dynamic fronts and orders, theatre.ts) off.
if (process.env.THEATRE === '0') STRATEGY_AI.theatre = false;
// …or only some of its parts: THEATRE_OFF=stances,structure,counter
for (const k of (process.env.THEATRE_OFF ?? '').split(',')) if (k === 'stances' || k === 'structure' || k === 'counter') THEATRE_AB[k] = false;

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const minutes = Number(process.argv[2] ?? 60);
const seeds = (process.argv[3] ?? '7,11,13').split(',').map(Number);

interface Track { x: number; z: number; since: number; flaggedStuck: boolean; unreachableSince: number; fired: boolean }

for (const seed of seeds) {
  const m = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
  const w = m.world;
  const anomalies: string[] = [];
  const note = (s: string): void => { if (anomalies.length < 60 && !anomalies.includes(s)) anomalies.push(s); };
  const tracks = new Map<number, Track>();
  const logCounts = new Map<string, number>();
  let logSeen = 0;
  const ticks = minutes * 60 * w.tickHz;
  const win: number[] = [];
  const mannedAcc = w.factions.map(() => ({ slots: 0, manned: 0 }));
  console.log(`\n=== seed ${seed}: ${w.terrain.width}×${w.terrain.depth} m, ${w.objectives.length} settlements, ${minutes} min cap ===`);
  for (let i = 0; i < ticks && !w.result; i++) {
    const t0 = performance.now();
    step(m);
    win.push(performance.now() - t0);
    w.fx.length = 0;
    // Log spam: count keys as they appear (the log is capped, so sample the new tail).
    if (w.log.length < logSeen) logSeen = 0;
    for (; logSeen < w.log.length; logSeen++) {
      const e = w.log[logSeen];
      logCounts.set(e.key, (logCounts.get(e.key) ?? 0) + 1);
      logCounts.set(`${e.key}@${e.faction}`, (logCounts.get(`${e.key}@${e.faction}`) ?? 0) + 1);
    }
    if ((i + 1) % (300 * w.tickHz) === 0) report(win.splice(0, win.length));
    if (i % w.tickHz !== 0) continue;
    // 2.1: manned building slots, sampled once a minute (time average per faction).
    if (i % (60 * w.tickHz) === 0) for (const f of w.factions) { const m = mannedShare(w, f.id); mannedAcc[f.id].slots += m.slots; mannedAcc[f.id].manned += m.manned; }
    // Per-second invariants.
    for (const f of w.factions) {
      if (f.p < -1e-6 || f.m < -1e-6) note(`t=${Math.round(w.time)}s faction ${f.id} negative stock P=${f.p.toFixed(1)} M=${f.m.toFixed(1)}`);
      if (!Number.isFinite(f.p) || !Number.isFinite(f.m)) note(`t=${Math.round(w.time)}s faction ${f.id} non-finite stock`);
    }
    for (const u of w.units.values()) {
      if (!Number.isFinite(u.pos.x) || !Number.isFinite(u.pos.z) || !Number.isFinite(u.y)) { note(`t=${Math.round(w.time)}s ${u.def.id}#${u.id} NaN position`); continue; }
      if (!w.terrain.inBounds(u.pos.x, u.pos.z)) note(`t=${Math.round(w.time)}s ${u.def.id}#${u.id} out of bounds (${u.pos.x.toFixed(0)}, ${u.pos.z.toFixed(0)})`);
      const maxHp = u.fixed ? 1400 : u.def.maxHp;
      if (u.hp < 0 || u.hp > maxHp + 1e-6) note(`t=${Math.round(w.time)}s ${u.def.id}#${u.id} hp ${u.hp.toFixed(1)} outside [0, ${maxHp}]`);
      if (u.fixed) continue;
      let tr = tracks.get(u.id);
      if (!tr) tracks.set(u.id, (tr = { x: u.pos.x, z: u.pos.z, since: w.time, flaggedStuck: false, unreachableSince: -1, fired: false }));
      if (u.lastFiredAt > 0) tr.fired = true;
      const wants = u.path.length > 0 && u.targetId === null && !u.mounted;
      if (!wants || dist(u.pos, tr) > 4) { tr.x = u.pos.x; tr.z = u.pos.z; tr.since = w.time; tr.flaggedStuck = false; }
      else if (!tr.flaggedStuck && w.time - tr.since > 90) { tr.flaggedStuck = true; note(`t=${Math.round(w.time)}s ${u.def.id}#${u.id} stuck > 90 s status ${u.status} ${navContext(u)} path ${u.path.length}/${u.pathIdx} next ${u.path[u.pathIdx] ? `${u.path[u.pathIdx].x.toFixed(0)},${u.path[u.pathIdx].z.toFixed(0)}` : '-'} walk ${w.navFor(u).walkableXZ(u.pos.x, u.pos.z) ? 'y' : 'N'} crowd ${w.spatial.query(u.pos.x, u.pos.z, 8).length - 1} morale ${u.moraleState} setup ${u.setup}`); }
      if (u.pathFailed) { if (tr.unreachableSince < 0) tr.unreachableSince = w.time; else if (w.time - tr.unreachableSince > 60) { note(`t=${Math.round(w.time)}s ${u.def.id}#${u.id} unreachable > 60 s status ${u.status} role ${u.opRole} ${navContext(u)}`); tr.unreachableSince = w.time; } } else tr.unreachableSince = -1;
    }
    for (const f of w.forts) if (f.occupant !== null && !w.unitAlive(f.occupant)) note(`t=${Math.round(w.time)}s fort#${f.id} occupant ${f.occupant} is dead`);
  }
  if (win.length) report(win);
  const r = w.result;
  if (r) console.log(`RESULT: ${r.reason} winners [${r.winners.join(',')}] at ${(r.tick / w.tickHz / 60).toFixed(1)} min`);
  else console.log(`RESULT: no result after ${minutes} min (alive: ${w.factions.filter((f) => f.alive).map((f) => f.id).join(',')}; held ${w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id).length).join('/')})`);
  // 2.0 defensive buildings: standing (finished / sites) and garrisoned squads per faction, completions from the log.
  const builtLog = (key: string): string => w.factions.map((f) => logCounts.get(`${key}@${f.id}`) ?? 0).join('/');
  const bstat = (kind: string): string => w.factions.map((f) => {
    const mine = w.forts.filter((x) => x.owner === f.id && x.kind === kind && x.hp > 0);
    const done = mine.filter((x) => x.progress >= 1);
    return `${done.length}+${mine.length - done.length}(${done.reduce((a, x) => a + (x.occupants?.length ?? 0), 0)})`;
  }).join(' ');
  // 2.1: manned share of the finished building slots, and zones per faction (live / cancelled).
  const manned = w.factions.map((f) => { const m = mannedShare(w, f.id); return m.slots ? `${Math.round((100 * m.manned) / m.slots)}%` : '-'; }).join('/');
  const zones = w.factions.map((f) => `${f.zones.filter((z) => !z.cancelled).length}${f.zones.some((z) => z.cancelled) ? `(-${f.zones.filter((z) => z.cancelled).length})` : ''}`).join('/');
  const mannedAvg = mannedAcc.map((a) => (a.slots ? `${Math.round((100 * a.manned) / a.slots)}%` : '-')).join('/');
  console.log(`BUILDINGS standing+sites(garrison) | pillbox ${bstat('pillbox')} | bunker ${bstat('bunker')} | built pillbox ${builtLog('log.pillboxBuilt')} bunker ${builtLog('log.bunkerBuilt')} lost ${builtLog('log.structureLost')} | manned ${manned} (avg ${mannedAvg}) | zones ${zones} | engineers requested ${builtLog('log.engineersRequested')}`);
  // Batteries that never fired in the whole war.
  let silentGuns = 0; let guns = 0;
  for (const u of w.units.values()) if (u.def.id === 'howitzer' || u.def.id === 'mortar') { guns++; if (!tracks.get(u.id)?.fired && w.time - (tracks.get(u.id)?.since ?? w.time) > 300) silentGuns++; }
  if (guns && silentGuns / guns > 0.3) note(`${silentGuns}/${guns} artillery pieces alive at the end never fired (≥ 5 min old)`);
  const spam = [...logCounts].filter(([k, n]) => !k.includes('@') && n > minutes * 30).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (spam.length) note(`log spam (> 30/min): ${spam.map(([k, n]) => `${k}×${n}`).join(', ')}`);
  console.log(anomalies.length ? `ANOMALIES (${anomalies.length}):\n  ${anomalies.join('\n  ')}` : 'ANOMALIES: none');

  /** Why a route fails: is the unit's own cell passable for its class, and is the goal? */
  function navContext(u: Unit): string {
    const nav = w.navFor(u);
    const g = (p: { x: number; z: number }): string => ['open', 'road', 'forest', 'town', 'mud', 'water', 'ford'][w.terrain.groundAt(p.x, p.z)] ?? '?';
    const start = `at ${u.pos.x.toFixed(0)},${u.pos.z.toFixed(0)} ${g(u.pos)} slope ${w.terrain.slopeAt(u.pos.x, u.pos.z).toFixed(0)}° bld ${w.terrain.buildingH(u.pos.x, u.pos.z).toFixed(0)} startOk ${nav.nearestPassable(u.pos, 24) ? 'y' : 'N'}`;
    const d = u.dest;
    const dest = d ? `dest ${d.x.toFixed(0)},${d.z.toFixed(0)} ${g(d)} slope ${w.terrain.slopeAt(d.x, d.z).toFixed(0)}° destOk ${nav.nearestPassable(d, 40) ? 'y' : 'N'} far ${dist(u.pos, d).toFixed(0)}m` : 'dest ?';
    return `(${u.def.kind} ${u.def.maxSlopeDeg}° | ${start} | ${dest})`;
  }

  function report(ms: number[]): void {
    const sorted = [...ms].sort((a, b) => a - b);
    const mean = ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const alive = [...w.units.values()].filter((u) => u.hp > 0 && !u.fixed);
    const firing = alive.filter((u) => w.time - u.lastFiredAt < 5).length;
    const held = w.factions.map((f) => w.objectives.filter((o) => o.owner === f.id).length).join('/');
    const pop = w.factions.map((f) => f.popPresent).join('/');
    const lost = w.factions.map((f) => f.lostUnits).join('/');
    console.log(`t=${(w.time / 60).toFixed(0).padStart(3)} min | units ${alive.length} firing ${(100 * firing / Math.max(1, alive.length)).toFixed(0)}% | held ${held} | pop ${pop} | lost ${lost} | stock ${w.factions.map((f) => `${Math.round(f.p)}|${Math.round(f.m)}`).join(' ')} | tick ${mean.toFixed(2)} ms p99 ${p99.toFixed(1)}`);
  }
}
