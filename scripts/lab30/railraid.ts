/**
 * 3.0 lab — rail raids (doctrine `raid_targets.rail`, src/sim/railraid.ts, WP-Y). 1v1 attrition vs
 * builder on the medium generated map, both slot orders, headless, open information. Counts line
 * cuts (every false → true flip of `line.cut`), the ones made by raid parties (RAIL_RAID_STATS),
 * repairs (true → false), rail raid launches, and the builder's usable-line time (line-minutes it
 * could run trains on).
 *
 *   npx tsx scripts/lab30/railraid.ts [--seeds 7,11,13] [--minutes 30] [--jobs 6] [--src src] [--data docs/data] [--tag after]
 *
 * `--src <frozen tree>/src --data <frozen tree>/docs/data` runs the "before" tree (no rail raids) for the A/B.
 * Output: media/stats/lab30/railraid-<tag>-<ts>.{md,json}.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLabMatch, mdTable, parseArgs, runJobs, runMatch, serveWorker, stamp, writeReport, type MatchSpec } from './runner';

interface Spec extends MatchSpec { readonly doctrines: readonly string[] }
interface Out {
  readonly seed: number; readonly doctrines: readonly string[]; readonly minutes: number;
  readonly lines: number; readonly cuts: number; readonly raidCuts: number; readonly repairs: number;
  readonly launches: number; readonly builderLineMin: number; readonly attritionLineMin: number;
  readonly stats: Readonly<Record<string, number>>;
}

async function runSpec(spec: Spec): Promise<Out> {
  const m = await createLabMatch(spec);
  const w = m.world;
  const stats = ((await import(pathToFileURL(resolve(spec.src, 'sim/railraid.ts')).href).catch(() => ({}))) as { RAIL_RAID_STATS?: Record<string, number> }).RAIL_RAID_STATS ?? {};
  const st = w.transport;
  let prev = st ? st.lines.map((l) => l.cut) : [];
  let cuts = 0;
  let repairs = 0;
  const lineS = [0, 0];
  const builder = spec.doctrines.indexOf('builder');
  const attrition = spec.doctrines.indexOf('attrition');
  runMatch(m, spec.minutes, (wd) => {
    const t = wd.transport;
    if (!t) return;
    t.lines.forEach((l, i) => {
      if (prev[i] === false && l.cut) cuts++;
      if (prev[i] === true && !l.cut) repairs++;
      if (l.owner === builder) lineS[0]++;
      if (l.owner === attrition) lineS[1]++;
    });
    prev = t.lines.map((l) => l.cut);
  });
  return {
    seed: spec.seed, doctrines: spec.doctrines, minutes: Math.round(w.time / 6) / 10, lines: st?.lines.length ?? 0,
    cuts, raidCuts: stats.cuts ?? 0, repairs, launches: stats.launched ?? 0,
    builderLineMin: Math.round(lineS[0] / 60), attritionLineMin: Math.round(lineS[1] / 60), stats: { ...stats },
  };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const src = a.str('src', 'src');
  const data = a.str('data', 'docs/data');
  const tag = a.str('tag', 'run');
  const minutes = a.num('minutes', 30);
  const list: Spec[] = [];
  for (const seed of a.nums('seeds', '7,11,13')) {
    for (const pair of [['attrition', 'builder'], ['builder', 'attrition']]) {
      list.push({ seed, minutes, mapSize: 'medium', factions: 2, src, data, doctrines: pair, config: { doctrines: pair } });
    }
  }
  console.log(`rail raid lab: ${list.length} matches (${tag}, src ${src})`);
  const outs = await runJobs<Spec, Out>(process.argv[1], list, a.num('jobs', 6), (s) => `${s.doctrines.join('/')} seed ${s.seed}`);
  const rows = outs.map((o) => [o.seed, o.doctrines.join(' v '), o.minutes, o.lines, o.cuts, o.raidCuts, o.repairs, o.launches, o.builderLineMin, o.attritionLineMin]);
  const sum = (k: keyof Out): number => outs.reduce((s, o) => s + (o[k] as number), 0);
  rows.push(['all', '', '', sum('lines'), sum('cuts'), sum('raidCuts'), sum('repairs'), sum('launches'), sum('builderLineMin'), sum('attritionLineMin')]);
  const md = `# Rail raid lab (${tag})\n\nsrc ${src}, ${minutes} min, 1v1 attrition vs builder, both slot orders.\n\n`
    + mdTable(['seed', 'slots', 'min', 'lines', 'cuts', 'by raids', 'repairs', 'raid launches', 'builder line-min', 'attrition line-min'], rows)
    + `\n\nRail raid counters (all matches): ${Object.entries(why).sort().map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}\n`;
  const why: Record<string, number> = {};
  for (const o of outs) for (const [k, v] of Object.entries(o.stats)) why[k] = (why[k] ?? 0) + v;
  const p = writeReport(`railraid-${tag}-${stamp()}`, md, outs);
  console.log(md);
  console.log(`\nwritten ${p.md}`);
}

if (process.argv.includes('--worker')) serveWorker(runSpec);
else void main();
