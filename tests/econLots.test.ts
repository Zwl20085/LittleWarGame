import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createMatch } from '../src/sim/sim';
import { LOTS } from '../src/sim/econLots';
import { Ground } from '../src/sim/terrain';

/** 2.2: economic-building lots sit on free ground at the town edge, never on houses or roads. */
const data = loadGameData();

describe('economic building lots', () => {
  for (const seed of [7, 4242]) {
    it(`seed ${seed}: lots are clear of buildings, water and roads, and apart`, () => {
      const w = createMatch(data, { mapId: 'generated', factions: 4, infoMode: 'open', seed, difficulty: 'normal', playerSlot: 0, spectate: true }).world;
      const t = w.terrain;
      let lots = 0;
      let clean = 0;
      for (const p of w.places) {
        p.slotPos.forEach((s, k) => {
          lots++;
          let ok = true;
          for (let dz = -10; dz <= 10 && ok; dz += 2) for (let dx = -10; dx <= 10 && ok; dx += 2) {
            if (dx * dx + dz * dz > 100) continue;
            if (t.buildingH(s.x + dx, s.z + dz) > 0) ok = false;
            const g = t.groundAt(s.x + dx, s.z + dz);
            if (g === Ground.Water || g === Ground.Ford) ok = false;
          }
          for (const road of t.def.roads) for (let i = 0; i < road.length - 1 && ok; i++) {
            const a = road[i];
            const b = road[i + 1];
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const l2 = dx * dx + dz * dz;
            const u = l2 > 0 ? Math.max(0, Math.min(1, ((s.x - a.x) * dx + (s.z - a.z) * dz) / l2)) : 0;
            if (Math.hypot(s.x - a.x - dx * u, s.z - a.z - dz * u) < LOTS.roadMinM - 0.01) ok = false;
          }
          for (let j = 0; j < k; j++) if (Math.hypot(p.slotPos[j].x - s.x, p.slotPos[j].z - s.z) < LOTS.gapM - 0.01) ok = false;
          if (ok) clean++;
        });
      }
      expect(lots).toBeGreaterThan(10);
      expect(clean / lots).toBeGreaterThanOrEqual(0.95);
    });
  }
});
