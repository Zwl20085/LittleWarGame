import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { scaleRules } from '../src/sim/scale';
import { createMatch } from '../src/sim/sim';
import { crossings, defensivePosition, lineSlot } from '../src/sim/terrainai';
import { Ground } from '../src/sim/terrain';

const data = loadGameData();

describe('army scale', () => {
  it('multiplies force-size limits but keeps per-unit balance', () => {
    const r = scaleRules(data.rules, 10);
    expect(r.economy.population_cap).toBe(800);
    expect(r.economy.facilities.barracks).toBe(20);
    expect(r.victory.initial_resolve).toBeCloseTo(900 * 10 * (data.rules.proposed_defaults.army_scale_resolve_factor ?? 1));
    expect(r.economy.cancel_started_refund_ratio).toBe(data.rules.economy.cancel_started_refund_ratio);
  });
});

describe('terrain analysis', () => {
  const m = createMatch(data, { mapId: 'greystone_pinecreek', factions: 2, infoMode: 'open', seed: 3, difficulty: 'normal', playerSlot: 0, armyScale: 1 });
  const w = m.world;
  it('finds bridges and fords on the river map', () => {
    const c = crossings(w);
    expect(c.some((x) => x.kind === 'bridge')).toBe(true);
    expect(c.some((x) => x.kind === 'ford')).toBe(true);
  });
  it('defends behind the river when the threat is across it', () => {
    // West river runs near x≈522; we hold west of it facing an enemy to the east.
    const dp = defensivePosition(w, { x: 470, z: 400 }, { x: 760, z: 400 }, 160);
    expect(dp.pos.x).toBeLessThan(522);
    expect(w.terrain.groundAt(dp.pos.x, dp.pos.z)).not.toBe(Ground.Water);
  });
  it('battle-line slots are spread across the facing direction', () => {
    const pts = Array.from({ length: 20 }, (_, i) => lineSlot({ x: 0, z: 0 }, 0, i, 20, 0));
    const zs = pts.map((p) => p.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(100);
    expect(new Set(pts.map((p) => `${p.x},${p.z}`)).size).toBe(20);
  });
});
