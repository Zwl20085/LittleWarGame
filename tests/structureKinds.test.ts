import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Terrain } from '../src/sim/terrain';
import { registerStructureKind, structureKind } from '../src/render/structureKinds';
import { StructureViews, type StructureRecord } from '../src/render/structures';

/** 2.2 render hook: structure kinds → instanced parts, fed by any record source. */
const flatTerrain = { heightAt: () => 0 } as unknown as Terrain;

function instances(v: StructureViews): number {
  let n = 0;
  v.group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) n += (o as THREE.InstancedMesh).count;
  });
  return n;
}

const rec = (id: number, kind: string, progress: number, hp = 100): StructureRecord => ({ id, kind, pos: { x: 10 * id, z: 0 }, facing: 0, progress, hp, maxHp: 100, owner: 0 });

describe('structure kind registry', () => {
  it('has the 2.0 pillbox and bunker built in', () => {
    expect(structureKind('pillbox')?.height).toBeGreaterThan(0);
    expect(structureKind('bunker')?.footprint.z).toBeGreaterThan(0);
    expect(structureKind('trench')).toBeUndefined();
  });

  it('draws a newly registered kind through construction, completion and ruin', () => {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    registerStructureKind('test_depot', { body: box, roof: box, height: 4, footprint: { x: 8, z: 6 }, flag: { back: 2, top: 5 } });
    const v = new StructureViews(flatTerrain, () => '#aa3322');
    // Footing only, then footing + rising walls, then body + roof + pennant.
    v.sync([rec(1, 'test_depot', 0.05)], 0);
    expect(instances(v)).toBe(1);
    expect(v.siteCount).toBe(1);
    v.sync([rec(1, 'test_depot', 0.5)], 1);
    expect(instances(v)).toBe(2);
    v.sync([rec(1, 'test_depot', 1)], 2);
    expect(instances(v)).toBe(3);
    expect(v.siteCount).toBe(0);
    // Destroyed: rubble only; unknown kinds in the same list are ignored.
    v.sync([rec(1, 'test_depot', 1, 0), rec(2, 'trench', 1)], 3);
    expect(instances(v)).toBe(1);
    // The ruin clears after its time.
    v.sync([], 200);
    expect(instances(v)).toBe(0);
  });

  it('keeps an economic ruin as long as its record says ruined, with the kind ruin part', async () => {
    const { registerEconModels } = await import('../src/render/econModels');
    registerEconModels();
    for (const k of ['factory', 'recruit', 'depot']) expect(structureKind(k)?.ruin).toBeDefined();
    const v = new StructureViews(flatTerrain, () => '#3366aa');
    const ruin = { ...rec(5, 'depot', 1, 0), ruined: true };
    v.sync([ruin], 0);
    v.sync([ruin], 500);
    expect(instances(v)).toBe(1);
    // Rebuilt: a site again (footing + scaffold + rising body).
    v.sync([rec(5, 'depot', 0.5, 50)], 501);
    expect(instances(v)).toBe(3);
  });
});
