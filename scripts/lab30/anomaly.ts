// 3.0 debug lab (V30_SPEC §2, docs/DEBUG_LAB.md): headless 4-FFA soaks with the read-only anomaly
// probe; writes media/stats/lab30/anomaly-<label|ts>.{md,json}.
//
//   npx tsx scripts/lab30/anomaly.ts [--seeds 7,11,13] [--minutes 45] [--maps medium,large] [--jobs 6]
//                                    [--src src] [--data docs/data] [--label name] [--factions 4]
//
// `--src` / `--data` may point at a frozen tree (e.g. `git archive <rev> src docs/data`) to measure
// the "before" with the same probe.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World } from '../../src/sim/world';
import { anomalySecond, anomalyWindow, ANOMALY, createAnomalyProbe, CLASSES, type AnomalyClass, type Episode } from './anomalyProbe';
import { isCombat, isTankUnit } from './anomalyWorld';
import { createLabMatch, parseArgs, runJobs, runMatch, serveWorker, stamp, writeReport, type MatchSpec } from './runner';
import { anomalyMarkdown } from './anomalyReport';

export interface ClassCount { records: number; unitWindows: number; episodes: number; high: number; causes: Record<string, number> }

export interface AnomalyRun {
  readonly seed: number;
  readonly mapSize: string;
  readonly simMinutes: number;
  readonly wallS: number;
  readonly result: string;
  readonly counts: Record<AnomalyClass, ClassCount>;
  readonly episodes: Episode[];
  /** Tank-seconds (sampled every 10 s): all / ammo < 0.15 / of those not rearming / with ammo ≥ rearm_below but below a shell. */
  readonly tank: { samples: number; low: number; lowIdle: number; deadZone: number };
  /** Combat units (sampled every 10 s): all / ammo < 0.15. */
  readonly combat: { samples: number; low: number };
}

async function runOne(spec: MatchSpec): Promise<AnomalyRun> {
  const t0 = performance.now();
  const m = await createLabMatch(spec);
  const probe = createAnomalyProbe();
  const tank = { samples: 0, low: 0, lowIdle: 0, deadZone: 0 };
  const combat = { samples: 0, low: 0 };
  const below = (w: World): number => w.data.rules.logistics?.rearm_below ?? 0.12;
  runMatch(m, spec.minutes, (w) => {
    anomalySecond(w, probe);
    if (w.tick % (10 * w.tickHz) === 0 && w.time >= 300) {
      for (const u of w.aliveUnits) {
        if (!isCombat(u)) continue;
        combat.samples++;
        if (u.ammo < 0.15) combat.low++;
        if (!isTankUnit(u)) continue;
        tank.samples++;
        if (u.ammo < 0.15) { tank.low++; if (!u.rearming) tank.lowIdle++; }
        if (u.ammo >= below(w) && u.primary && u.primary.ammoCost > u.ammo + 1e-9) tank.deadZone++;
      }
    }
    if (w.tick % (ANOMALY.windowS * w.tickHz) === 0) anomalyWindow(w, probe);
  });
  const w = m.world;
  const counts = Object.fromEntries(CLASSES.map((c) => [c, { records: 0, unitWindows: 0, episodes: 0, high: 0, causes: {} }])) as Record<AnomalyClass, ClassCount>;
  for (const r of probe.records) {
    counts[r.cls].records++;
    counts[r.cls].unitWindows += r.size;
  }
  for (const e of probe.episodes) {
    const c = counts[e.cls];
    c.episodes++;
    if (e.severity === 'high') c.high++;
    const main = Object.entries(e.causes).sort((a, b) => b[1] - a[1])[0][0];
    c.causes[main] = (c.causes[main] ?? 0) + 1;
  }
  const res = w.result ? `F${w.result.winners.join('+')} ${w.result.reason} @${(w.result.tick / w.tickHz / 60).toFixed(0)}m` : `open (${w.factions.filter((f) => f.alive).length} alive)`;
  const episodes = probe.episodes.map((e) => ({ ...e, unitIds: e.unitIds.slice(0, 40) }));
  return { seed: spec.seed, mapSize: spec.mapSize, simMinutes: w.time / 60, wallS: (performance.now() - t0) / 1000, result: res, counts, episodes, tank, combat };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') return serveWorker(runOne);
  const a = parseArgs(argv);
  const seeds = a.nums('seeds', '7,11,13');
  const maps = a.str('maps', 'medium,large').split(',') as ('medium' | 'large')[];
  const minutes = a.num('minutes', 45);
  const src = resolve(a.str('src', 'src'));
  const data = resolve(a.str('data', 'docs/data'));
  const label = a.str('label', stamp());
  const specs: MatchSpec[] = maps.flatMap((mapSize) => seeds.map((seed) => ({ seed, minutes, mapSize, factions: a.num('factions', 4), src, data })));
  const runs = await runJobs<MatchSpec, AnomalyRun>(fileURLToPath(import.meta.url), specs, a.num('jobs', 6), (s) => `seed ${s.seed} ${s.mapSize}`);
  const md = anomalyMarkdown(runs, { label, src: a.str('src', 'src'), minutes });
  const out = writeReport(`anomaly-${label}`, md, { label, src, data, minutes, runs });
  console.log(md.split('\n## Worst')[0]);
  console.log(`\nwrote ${out.md} and ${out.json}`);
}

void main();
