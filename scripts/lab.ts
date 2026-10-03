// Balance lab — the numerical debug process (docs/BALANCE_LAB.md).
// Runs N seeds × T minutes of headless 4-faction AI war, probes economy / production /
// combat / territory every game second, and writes a Markdown + JSON report.
//
//   npx tsx scripts/lab.ts --seeds 7,11,13 --minutes 20
//   npx tsx scripts/lab.ts --seeds 7,11,13 --minutes 20 --ab --set territory.capital_income_share=0.15
//   npx tsx scripts/lab.ts --ab --vs "cap10:territory.capital_income_share=0.1" --vs "town:territory.income_m_per_min.town*=0.5"
//
// Flags: --seeds a,b  --minutes T  --warmup W (min excluded from rates, default min(5,T/3))
//        --set path=value (repeatable; see scripts/lab/overrides.ts)  --vs "label:set1;set2" (extra variant)
//        --ab (also run the unmodified baseline and print the diff)  --label name  --map generated|four_cities
//        --factions 4  --difficulty normal  --src <dir> (sim source root, default src)  --data <dir>  --jobs N
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyOverrides, parseOverride, type DataText } from './lab/overrides';
import { consoleDigest, diffMarkdown, headerMarkdown, variantMarkdown } from './lab/report';
import { runOne, type RunResult, type RunSpec } from './lab/run';
import { summarize, type Summary } from './lab/summary';

interface Variant { readonly name: string; readonly sets: string[] }

function parseArgs(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
    (out[key] ??= []).push(val);
  }
  return out;
}

async function workerMain(): Promise<void> {
  process.on('message', (spec: RunSpec) => {
    runOne(spec)
      .then((r) => process.send?.({ ok: true, r }, () => process.exit(0)))
      .catch((e: unknown) => process.send?.({ ok: false, err: e instanceof Error ? e.stack ?? e.message : String(e) }, () => process.exit(1)));
  });
}

function runInChild(spec: RunSpec): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let done = false;
    child.on('message', (msg: { ok: boolean; r?: RunResult; err?: string }) => {
      done = true;
      if (msg.ok && msg.r) resolve(msg.r);
      else reject(new Error(`seed ${spec.seed}: ${msg.err}`));
    });
    child.on('exit', (code) => { if (!done) reject(new Error(`seed ${spec.seed}: worker exited with ${code}`)); });
    child.send(spec);
  });
}

async function pool<T>(tasks: Array<() => Promise<T>>, jobs: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, tasks.length)) }, lane));
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker) return workerMain();
  const one = (k: string, d: string): string => args[k]?.[args[k].length - 1] ?? d;
  const seeds = one('seeds', '7,11,13').split(',').map(Number);
  const minutes = Number(one('minutes', '20'));
  const warmup = Number(one('warmup', String(Math.min(5, Math.floor(minutes / 3)))));
  const mapId = one('map', 'generated');
  const srcRoot = one('src', 'src');
  const dataDir = one('data', 'docs/data');
  const jobs = Number(one('jobs', String(Math.max(1, cpus().length - 2))));
  if (seeds.some((s) => !Number.isFinite(s)) || !(minutes > 0)) throw new Error('bad --seeds / --minutes');

  const variants: Variant[] = [];
  if (args.ab || (!args.set && !args.vs)) variants.push({ name: 'baseline', sets: [] });
  if (args.set) variants.push({ name: 'variant', sets: args.set });
  for (const v of args.vs ?? []) {
    const idx = v.indexOf(':');
    if (idx < 0) throw new Error(`--vs "${v}": expected label:set1;set2`);
    variants.push({ name: v.slice(0, idx), sets: v.slice(idx + 1).split(';').map((s) => s.trim()).filter(Boolean) });
  }
  const label = one('label', variants.map((v) => v.name).join('-vs-'));
  const base: DataText = {
    units: readFileSync(`${dataDir}/units.csv`, 'utf8'),
    weapons: readFileSync(`${dataDir}/weapons.csv`, 'utf8'),
    rules: readFileSync(`${dataDir}/rules.json`, 'utf8'),
  };
  // Validate every override before burning minutes of CPU.
  const texts = variants.map((v) => applyOverrides(base, v.sets.map(parseOverride)));

  const specs = variants.flatMap((_, vi) => seeds.map((seed) => ({ vi, spec: {
    seed, minutes, mapId, factions: Number(one('factions', '4')), difficulty: one('difficulty', 'normal'), srcRoot, data: texts[vi],
  } satisfies RunSpec })));
  const t0 = performance.now();
  console.log(`lab: ${variants.length} variant(s) × ${seeds.length} seed(s) × ${minutes} min, ${jobs} parallel jobs`);
  const results = await pool(specs.map(({ vi, spec }) => async () => {
    const r = await runInChild(spec);
    console.log(`  done ${variants[vi].name} seed ${spec.seed}: ${(r.simSeconds / 60).toFixed(1)} min in ${r.wallSeconds.toFixed(0)} s`);
    return r;
  }), jobs);

  const summaries: Summary[] = variants.map((_, vi) => summarize(results.filter((_, i) => specs[i].vi === vi), warmup));
  const date = new Date().toISOString();
  const md: string[] = headerMarkdown({ label, seeds, minutes, warmup, mapId, sets: variants.flatMap((v) => v.sets.map((s) => `${v.name}: ${s}`)), srcRoot, date });
  const baseIdx = variants.findIndex((v) => v.name === 'baseline');
  variants.forEach((v, vi) => {
    console.log(consoleDigest(v.name, summaries[vi]));
    if (baseIdx >= 0 && vi !== baseIdx) {
      const diff = diffMarkdown(summaries[baseIdx], summaries[vi]);
      md.push(`# ${v.name} vs baseline`, '', `Overrides: ${v.sets.map((s) => `\`${s}\``).join(' ')}`, '', ...diff);
      console.log(diff.filter((l) => l.startsWith('|') && !l.startsWith('|---')).join('\n'));
    }
  });
  variants.forEach((v, vi) => md.push(...variantMarkdown(`${v.name}${v.sets.length ? ` (${v.sets.join(', ')})` : ''}`, summaries[vi])));
  mkdirSync('media/stats', { recursive: true });
  const stamp = date.replace(/[:.]/g, '-').slice(0, 19);
  const safe = label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  const path = `media/stats/lab-${safe}-${stamp}`;
  writeFileSync(`${path}.md`, md.join('\n'));
  writeFileSync(`${path}.json`, JSON.stringify({
    meta: { label, seeds, minutes, warmup, mapId, srcRoot, date, variants },
    summaries: variants.map((v, vi) => ({ name: v.name, sets: v.sets, summary: summaries[vi] })),
    runs: results.map((r, i) => ({ variant: variants[specs[i].vi].name, seed: r.seed, result: r.result, points: r.probe.points, bind: r.probe.bind, captures: r.probe.captures })),
  }));
  console.log(`report: ${path}.md (+ .json) in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
