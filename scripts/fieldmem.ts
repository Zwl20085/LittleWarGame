// Flow-field cache memory and rebuild lab (WP-M2). Runs the headless AI war and every 5 game-minutes
// prints process.memoryUsage().arrayBuffers, the cached fields per movement class, the share of the
// cached cells a lazy field has settled, and how many builds re-created a goal the cache had built
// before (evicted, or dropped by refreshArea). Reads the caches through their Map instances only,
// so it runs unchanged on trees with or without a shared field budget.
//
//   SIZE=large npx tsx scripts/fieldmem.ts [seconds=1800] [seed=7]
import { readFileSync } from 'node:fs';
import { buildGameData } from '../src/data/loader';
import { createMatch, step } from '../src/sim/sim';
import { NavGrid } from '../src/sim/nav';
import { FIELD_INF, type FlowField } from '../src/sim/flowfield';

const data = buildGameData(readFileSync('docs/data/units.csv', 'utf8'), readFileSync('docs/data/weapons.csv', 'utf8'), readFileSync('docs/data/rules.json', 'utf8'));
const secs = Number(process.argv[2] ?? 1800);
const seed = Number(process.argv[3] ?? 7);
const mapSize = process.env.SIZE === 'large' ? 'large' : 'medium';
const m = createMatch(data, { mapId: 'generated', mapSize, factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true });
const w = m.world;

interface Hooked { label: string; fields: Map<number, FlowField>; seen: Set<number>; builds: number; rebuilds: number }
const hooked = new Map<NavGrid, Hooked>();
const gridsOf = (): Map<number, NavGrid> => (w as unknown as { navCache: Map<number, NavGrid> }).navCache;

function hookNew(): void {
  for (const [key, g] of gridsOf()) {
    if (hooked.has(g)) continue;
    const fields = (g as unknown as { fields: Map<number, FlowField> }).fields;
    const h: Hooked = { label: `${g.cls.vehicle ? 'veh' : 'foot'}${g.cls.maxSlopeDeg}${key >= 1000 ? 'w' : ''}`, fields, seen: new Set(), builds: 0, rebuilds: 0 };
    const set = fields.set.bind(fields);
    fields.set = (k: number, v: FlowField): Map<number, FlowField> => {
      h.builds++;
      if (h.seen.has(k)) h.rebuilds++;
      h.seen.add(k);
      return set(k, v);
    };
    hooked.set(g, h);
  }
}

const mb = (b: number): string => (b / 1048576).toFixed(0);
let ms = 0;
for (let i = 1; i <= secs * w.tickHz; i++) {
  hookNew();
  const t = performance.now();
  step(m);
  ms += performance.now() - t;
  w.fx.length = 0;
  if (i % (300 * w.tickHz) !== 0) continue;
  hookNew();
  let builds = 0;
  let rebuilds = 0;
  let cached = 0;
  let fieldBytes = 0;
  const per: string[] = [];
  for (const h of hooked.values()) {
    let settled = 0;
    let cells = 0;
    for (const f of h.fields.values()) {
      // Dense fields (before WP-M2) count touched cells; sparse fields count touched 32-cell chunks.
      const dense = (f as unknown as { dist?: Int32Array }).dist;
      if (dense) {
        cells += dense.length;
        fieldBytes += dense.byteLength;
        for (let k = 0; k < dense.length; k++) if (dense[k] !== FIELD_INF) settled++;
      } else {
        cells += f.chunkOf.length * 32;
        fieldBytes += f.bytes;
        settled += f.touchedCells;
      }
    }
    builds += h.builds;
    rebuilds += h.rebuilds;
    cached += h.fields.size;
    per.push(`${h.label} ${h.fields.size}f ${h.builds}b ${h.rebuilds}rb ${cells ? Math.round((100 * settled) / cells) : 0}%touched`);
  }
  const mu = process.memoryUsage();
  console.log(`t=${Math.round(w.time)}s units ${w.units.size} arrayBuffers ${mb(mu.arrayBuffers)} MB heap ${mb(mu.heapUsed)} MB rss ${mb(mu.rss)} MB | fields ${cached} (${mb(fieldBytes)} MB) builds ${builds} rebuilds ${rebuilds} (${builds ? Math.round((100 * rebuilds) / builds) : 0} %) | ${(ms / (300 * w.tickHz)).toFixed(2)} ms/tick`);
  console.log(`  ${per.join(' | ')}`);
  ms = 0;
}
