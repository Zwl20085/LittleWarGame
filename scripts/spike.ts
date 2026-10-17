// Spike attribution: the sim is deterministic, so a slow tick reported by `perf.ts` (`#index`)
// can be replayed and profiled on its own. Runs the same war and records a V8 CPU profile of
// just the listed ticks (plus every tick slower than SPIKE_MS when SPIKE_MS is set), then prints
// the hottest functions by inclusive time for each.
//
//   SIZE=large npx tsx scripts/spike.ts <seed> <tick,tick,...> [maxSeconds]
//   SIZE=large SPIKE_MS=60 npx tsx scripts/spike.ts 7 - 1200   (time every tick, profile none;
//     prints the ticks over SPIKE_MS so they can be replayed)
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const seed = Number(process.argv[2] ?? 7);
const wanted = new Set((process.argv[3] ?? '-').split(',').filter((s) => s !== '-').map(Number));
const maxTick = Math.max(...wanted, 0) + 1;
const secs = Number(process.argv[4] ?? Math.ceil(maxTick / 20));
const spikeMs = Number(process.env.SPIKE_MS ?? 0);
const mapSize = process.env.SIZE === 'large' ? 'large' : 'medium';
const m = createMatch(data, { mapId: 'generated', mapSize, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;
const session = new Session();
session.connect();
const post = <T>(method: string, params?: object): Promise<T> => new Promise((res, rej) => session.post(method, params ?? {}, (err, r) => (err ? rej(err) : res(r as T))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 50 });

function report(tick: number, ms: number, p: Profile): void {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map<string, number>();
  const self = new Map<string, number>();
  let total = 0;
  const name = (n: ProfileNode): string => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/src\//, '')}:${n.callFrame.lineNumber + 1}`;
  // Only samples inside step() (the inspector's own dispatch is not the tick's cost).
  const inStep = (id: number): boolean => {
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) if (byId.get(cur)!.callFrame.functionName === 'step') return true;
    return false;
  };
  p.samples.forEach((id, i) => {
    const d = p.timeDeltas[i] ?? 0;
    if (!inStep(id) && byId.get(id)!.callFrame.functionName !== '(garbage collector)') return;
    total += d;
    const n = byId.get(id)!;
    self.set(name(n), (self.get(name(n)) ?? 0) + d);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const k = name(byId.get(cur)!);
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + d);
    }
  });
  const fmt = (mp: Map<string, number>, n: number): string => [...mp].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `   ${(100 * v / total).toFixed(0).padStart(3)}%  ${k}`).join('\n');
  console.log(`tick #${tick} ${ms.toFixed(1)} ms\n  inclusive:\n${fmt(incl, 22)}\n  self:\n${fmt(self, 8)}`);
}

const slow: string[] = [];
for (let i = 0; i < secs * w.tickHz && !w.result; i++) {
  const prof = wanted.has(i);
  if (prof) await post('Profiler.start');
  const t = performance.now();
  step(m);
  const ms = performance.now() - t;
  w.fx.length = 0;
  if (prof) report(i, ms, (await post<{ profile: Profile }>('Profiler.stop')).profile);
  if (spikeMs > 0 && ms > spikeMs && i >= 200) slow.push(`#${i} ${ms.toFixed(0)}ms`);
}
if (spikeMs > 0) console.log(`ticks over ${spikeMs} ms (${slow.length}): ${slow.join(', ')}`);
