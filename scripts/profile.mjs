// One-command CPU profile of the headless simulation.
//
//   node scripts/profile.mjs [seconds=600] [seed=7] [--no-inline] [--callers <fn>] [--top 40]
//
// Bundles scripts/perf.ts with esbuild (tsx spawns a child process, so `node --cpu-prof` cannot
// see it), runs it under V8's sampling profiler and prints the hottest functions by self time and
// by total time, plus (with --callers) who calls a given function. `--no-inline` disables TurboFan
// inlining so small helpers (dist, heightAt, buildingH…) are attributed to themselves instead of
// to whatever inlined them; the run is ~30 % slower but the attribution is exact.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1] ?? 'true'; args.splice(i, 2); return v; };
const noInline = args.includes('--no-inline') && (args.splice(args.indexOf('--no-inline'), 1), true);
const callers = flag('--callers');
const top = Number(flag('--top') ?? 40);
const [seconds = '600', seed = '7'] = args;

const dir = join(tmpdir(), 'littlewar-profile');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const bundle = join(dir, 'perf.bundle.mjs');
const esbuild = resolve('node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
execFileSync(esbuild, ['scripts/perf.ts', '--bundle', '--platform=node', '--format=esm', '--target=node18', `--outfile=${bundle}`, '--log-level=warning'], { stdio: 'inherit', shell: process.platform === 'win32' });
const nodeArgs = [...(noInline ? ['--no-turbo-inlining'] : []), '--cpu-prof', `--cpu-prof-dir=${dir}`, bundle, 'generated', seconds, seed];
const run = spawnSync(process.execPath, nodeArgs, { encoding: 'utf8', maxBuffer: 1 << 26 });
const lines = run.stdout.split('\n');
console.log(lines.filter((l) => /perTick|tick ms|slowest|field cache|fieldBuilds/.test(l)).join('\n'));

const file = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort().pop();
const p = JSON.parse(readFileSync(join(dir, file), 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const selfById = new Map();
let total = 0;
for (let i = 0; i < p.samples.length; i++) {
  const d = p.timeDeltas[i] ?? 0;
  total += d;
  selfById.set(p.samples[i], (selfById.get(p.samples[i]) ?? 0) + d);
}
const key = (n) => `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber}`;
const self = new Map();
const incl = new Map();
for (const [id, d] of selfById) {
  self.set(key(byId.get(id)), (self.get(key(byId.get(id))) ?? 0) + d);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + d);
  }
}
const fmt = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
console.log(`\nprofile ${(total / 1e6).toFixed(1)} s CPU (${file})\n--- self time ---\n${fmt(self, top)}\n--- inclusive time ---\n${fmt(incl, Math.min(top, 25))}`);
if (callers) {
  const m = new Map();
  for (const [id, d] of selfById) {
    let cur = id;
    while (cur !== undefined && byId.get(cur).callFrame.functionName !== callers) cur = parent.get(cur);
    if (cur === undefined) continue;
    let up = parent.get(cur);
    while (up !== undefined && byId.get(up).callFrame.functionName === callers) up = parent.get(up);
    const k = up === undefined ? '(root)' : key(byId.get(up));
    m.set(k, (m.get(k) ?? 0) + d);
  }
  console.log(`--- callers of ${callers} ---\n${fmt(m, 20)}`);
}
