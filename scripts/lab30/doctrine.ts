/**
 * 3.0 lab — doctrines (docs/V30_SPEC.md §1, WP-A). Every doctrine against every other in 1v1
 * (medium generated map) and a 4-FFA with all four, headless, open information.
 *
 *   npx tsx scripts/lab30/doctrine.ts [--seeds 7,11,13] [--minutes 45] [--jobs 8]
 *        [--suite duel,ffa] [--size medium] [--off] [--tag run]
 *
 * `--off` runs the same matches with doctrine effects switched off (rules doctrines.enabled=false)
 * for the A/B. Output: media/stats/lab30/doctrine-<tag>-<ts>.{md,json}: win matrix, per-doctrine
 * territory / army curves, first contact, distinctiveness (between- vs within-doctrine distance of
 * behaviour fingerprints, and the pairwise distance of the mean curves), eliminations per hour.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLabMatch, parseArgs, runJobs, runMatch, serveWorker, stamp, writeReport, type MatchSpec } from './common';
import { analyse, type MatchOut, type Sample } from './doctrineReport';
import type { World } from '../../src/sim/world';

const DOCTRINES = ['builder', 'blitz', 'attrition', 'maneuver'] as const;
const SAMPLE_S = 30;

interface Spec extends MatchSpec { readonly suite: 'duel' | 'ffa'; readonly doctrines: readonly string[] }

const armyValue = (w: World, f: number): number => {
  let v = 0;
  for (const u of w.aliveUnits) {
    if (u.owner !== f || u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || u.def.id === 'commander') continue;
    v += (u.def.costP + u.def.costM) * (u.hp / u.def.maxHp);
  }
  return v;
};

async function runSpec(spec: Spec): Promise<MatchOut> {
  const m = await createLabMatch(spec);
  const w = m.world;
  const n = w.factions.length;
  const samples: Sample[] = [];
  const dirTime = w.factions.map(() => ({ offensive: 0, advance: 0, defend: 0, fortify: 0, contract: 0 } as Record<string, number>));
  const roles = w.factions.map(() => ({ raid: 0, retreat: 0, occupy: 0, units: 0 }));
  runMatch(m, spec.minutes, (wd) => {
    for (const f of wd.factions) if (f.alive) dirTime[f.id][f.directive.kind] = (dirTime[f.id][f.directive.kind] ?? 0) + 1;
    if (Math.round(wd.time) % SAMPLE_S !== 0) return;
    const held = wd.factions.map(() => 0);
    for (const o of wd.objectives) if (o.owner >= 0) held[o.owner]++;
    for (const u of wd.aliveUnits) {
      if (u.hp <= 0 || u.fixed || u.def.id === 'supply_truck' || u.def.id === 'commander') continue;
      const r = roles[u.owner];
      r.units++;
      if (u.opRole === 'raid') r.raid++;
      if (u.opRole === 'occupy') r.occupy++;
      if (u.behavior === 'retreat' || u.behavior === 'recover') r.retreat++;
    }
    samples.push({ t: wd.time, held, army: wd.factions.map((f) => armyValue(wd, f.id)), invest: wd.factions.map((f) => f.econInvested), spent: wd.factions.map((f) => f.spentTotalP + f.spentTotalM) });
  });
  const contacts = w.factions.flatMap((f) => f.contactAt.filter((t) => t >= 0));
  return {
    suite: spec.suite, seed: spec.seed, minutes: w.time / 60, doctrines: w.factions.map((f) => f.doctrine), total: w.objectives.length,
    winners: w.result ? [...w.result.winners] : [], eliminatedAt: w.factions.map((f) => f.eliminatedAt), samples,
    firstContact: contacts.length ? Math.min(...contacts) : -1,
    dirShare: dirTime.map((d) => { const s = Object.values(d).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v / s])); }),
    roles: roles.map((r) => ({ raid: r.raid / Math.max(1, r.units), retreat: r.retreat / Math.max(1, r.units), occupy: r.occupy / Math.max(1, r.units) })),
    n,
  };
}

function specs(a: ReturnType<typeof parseArgs>, data: string): Spec[] {
  const seeds = a.nums('seeds', '7,11,13');
  const minutes = a.num('minutes', 45);
  const size = a.str('size', 'medium') as 'medium' | 'large';
  const suites = a.str('suite', 'duel,ffa').split(',');
  const only = a.str('only', '');
  const out: Spec[] = [];
  const base = { minutes, mapSize: size, src: 'src', data };
  if (suites.includes('duel')) {
    for (let i = 0; i < DOCTRINES.length; i++) {
      for (let j = i + 1; j < DOCTRINES.length; j++) {
        if (only && DOCTRINES[i] !== only && DOCTRINES[j] !== only) continue;
        // Both slot orders on every seed: the 1v1 corners are not symmetric (slot 0 won 9 of 12 on seeds 7 / 13 in v2).
        for (const seed of seeds) {
          for (const pair of [[DOCTRINES[i], DOCTRINES[j]], [DOCTRINES[j], DOCTRINES[i]]]) {
            out.push({ ...base, seed, factions: 2, suite: 'duel', doctrines: pair, config: { doctrines: pair } });
          }
        }
      }
    }
  }
  if (suites.includes('ffa')) {
    seeds.forEach((seed, k) => {
      const order = DOCTRINES.map((_, i) => DOCTRINES[(i + k) % DOCTRINES.length]);
      out.push({ ...base, seed, factions: 4, suite: 'ffa', doctrines: order, config: { doctrines: order } });
    });
  }
  return out;
}

/** Data dir with rules overrides (`--set "a.b=1;c.d=x"`) and doctrines switched off for the A/B (`--off`), else docs/data. */
function dataDir(off: boolean, set: string): string {
  if (!off && !set) return 'docs/data';
  const dir = mkdtempSync(join(tmpdir(), 'lwg-doct-'));
  const rules = JSON.parse(readFileSync('docs/data/rules.json', 'utf8')) as Record<string, unknown> & { doctrines?: { enabled: boolean } };
  if (off && rules.doctrines) rules.doctrines.enabled = false;
  for (const kv of set.split(';').filter(Boolean)) {
    const [path, raw] = kv.split('=');
    const keys = path.trim().split('.');
    let o = rules as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
    let v: unknown = raw.trim();
    try { v = JSON.parse(raw); } catch { /* a bare string */ }
    o[keys[keys.length - 1]] = v;
  }
  writeFileSync(join(dir, 'rules.json'), JSON.stringify(rules));
  for (const f of ['units.csv', 'weapons.csv']) writeFileSync(join(dir, f), readFileSync(`docs/data/${f}`));
  return dir;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const off = a.has('off');
  const list = specs(a, dataDir(off, a.str('set', '')));
  const tag = a.str('tag', off ? 'off' : 'run');
  console.log(`doctrine lab: ${list.length} matches (${tag})`);
  const t0 = performance.now();
  const outs = await runJobs<Spec, MatchOut>(process.argv[1], list, a.num('jobs', 8), (s) => `${s.suite} ${s.doctrines.join('/')} seed ${s.seed}`);
  const { md, json } = analyse(outs, { tag, off, wallS: (performance.now() - t0) / 1000 });
  const paths = writeReport(`doctrine-${tag}-${stamp()}`, md, json);
  console.log(md);
  console.log(`\nwritten ${paths.md}`);
}

if (process.argv.includes('--worker')) serveWorker(runSpec);
else void main();
