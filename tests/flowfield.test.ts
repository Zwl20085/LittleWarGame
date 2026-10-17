import { describe, expect, it } from 'vitest';
import { EdgeTable, FIELD_INF, FlowField } from '../src/sim/flowfield';
import { generateMap } from '../src/sim/mapgen';
import { NavGrid, setFieldBudgetBytes } from '../src/sim/nav';
import { Terrain } from '../src/sim/terrain';
import type { V2 } from '../src/sim/vec';

/** Reference: plain Dijkstra over the same integer edge table (dense, eager). */
function reference(edges: EdgeTable, n: number, goal: number): Int32Array {
  const d = new Int32Array(n).fill(FIELD_INF);
  const done = new Uint8Array(n);
  d[goal] = 0;
  for (;;) {
    let cur = -1;
    for (let k = 0; k < n; k++) if (!done[k] && d[k] !== FIELD_INF && (cur < 0 || d[k] < d[cur])) cur = k;
    if (cur < 0) return d;
    done[cur] = 1;
    for (let e = 0; e < 8; e++) {
      const wt = edges.w[cur * 8 + e];
      if (wt === 0) continue;
      const nb = cur + edges.off[e];
      if (d[cur] + wt < d[nb]) d[nb] = d[cur] + wt;
    }
  }
}

/** Deterministic pseudo-random cost grid with blocked cells (0) and costs 1..3. */
function costGrid(nx: number, nz: number, seed: number): Float32Array {
  const c = new Float32Array(nx * nz);
  let s = seed >>> 0;
  for (let k = 0; k < c.length; k++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const r = s / 2 ** 32;
    c[k] = r < 0.15 ? 0 : 1 + Math.floor(r * 3);
  }
  return c;
}

describe('hot / cold flow field (WP-M2)', () => {
  it('settles to the same distances as an eager dense Dijkstra, partially, cooled and warmed again', () => {
    const nx = 70;
    const nz = 45;
    const n = nx * nz;
    const edges = new EdgeTable(costGrid(nx, nz, 11), nx, nz, 8);
    for (const goal of [0, 1234, 3149, 2000]) {
      const ref = reference(edges, n, goal);
      const f = new FlowField(edges, n, goal);
      // Partial: every settled value is final and exact; unsettled cells read FIELD_INF.
      f.settle(goal + 3 < n ? goal + 3 : goal - 3);
      for (let k = 0; k < n; k++) {
        const v = f.value(k);
        if (v !== FIELD_INF) expect(v).toBe(ref[k]);
      }
      // Cold (compact) form reads the same; expanding again warms it.
      const hot = Array.from({ length: n }, (_, k) => f.at(k));
      f.cool();
      expect(f.dense).toBeNull();
      for (let k = 0; k < n; k++) expect(f.at(k)).toBe(hot[k]);
      f.settle(n - 1);
      if (f.dense) f.cool();
      f.settle(0);
      for (let k = 0; k < n; k++) {
        f.settle(k);
        expect(f.value(k)).toBe(ref[k]);
      }
      expect(f.touchedCells).toBeLessThanOrEqual(n + 32);
    }
  });
});

describe('shared flow-field budget (WP-M2)', () => {
  const routes = (nav: NavGrid, pts: V2[]): string => {
    const out: string[] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const r = nav.pathByField(pts[i], pts[j], 4000);
        out.push(r.ok ? `${r.partial ? 'p' : 'f'}:${r.points.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(' ')}` : `x:${r.reason}`);
      }
    }
    return out.join('\n');
  };

  it('evicting across movement classes leaves every path identical', () => {
    const def = generateMap({ seed: 7, factions: 4, size: 'medium' });
    const pts: V2[] = [];
    for (let k = 0; k < 9; k++) pts.push({ x: 300 + ((k * 977) % 2800), z: 300 + ((k * 1423) % 2800) });
    const run = (budget: number): { foot: string; veh: string; evictions: number; rebuilds: number } => {
      const prev = setFieldBudgetBytes(budget);
      const ev0 = NavGrid.evictions;
      const rb0 = NavGrid.rebuilds;
      try {
        const terrain = new Terrain(def);
        const foot = new NavGrid(terrain, { vehicle: false, maxSlopeDeg: 35 });
        const veh = new NavGrid(terrain, { vehicle: true, maxSlopeDeg: 18 });
        // Interleave the classes so the LRU evicts across them; twice, so evicted goals are rebuilt.
        let a = '';
        let b = '';
        for (let pass = 0; pass < 2; pass++) {
          a = routes(foot, pts);
          b = routes(veh, pts);
        }
        expect(foot.fieldPoolBytes).toBeLessThanOrEqual(Math.max(budget, 4 << 20));
        return { foot: a, veh: b, evictions: NavGrid.evictions - ev0, rebuilds: NavGrid.rebuilds - rb0 };
      } finally {
        setFieldBudgetBytes(prev);
      }
    };
    const roomy = run(1 << 30);
    const tight = run(1 << 20);
    expect(roomy.evictions).toBe(0);
    expect(tight.evictions).toBeGreaterThan(0);
    expect(tight.rebuilds).toBeGreaterThan(0);
    expect(tight.foot).toBe(roomy.foot);
    expect(tight.veh).toBe(roomy.veh);
  }, 120_000);
});
