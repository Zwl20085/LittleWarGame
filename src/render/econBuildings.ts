import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { EconBuilding } from '../sim/types';

/**
 * 2.2 economic buildings — PLACEHOLDER views (logistics agent, wave 1; the render agent models
 * them in wave 2). Each kind is one InstancedMesh body + one roof: factory = long hall with a
 * chimney-high roof, recruiting office = small house, depot = wide low shed. Construction raises
 * the body with progress; damage darkens it; a ruin is a flat dark slab. Rebuilt only when a
 * cheap signature (ids, kind, progress step, damage step, owner) changes.
 */
const SIZE: Record<EconBuilding['kind'], [number, number, number]> = {
  factory: [16, 7, 10],
  recruit: [9, 5, 7],
  depot: [14, 4, 11],
};
const BODY: Record<EconBuilding['kind'], string> = { factory: '#8a7f72', recruit: '#b9a98a', depot: '#7d8466' };
const MAX = 256;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _f = new THREE.Color();

export class EconBuildingViews {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh;
  private readonly roof: THREE.InstancedMesh;
  private sig = '';

  constructor(private readonly terrain: Terrain, private readonly colorOf: (owner: number) => string) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 });
    this.body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat, MAX);
    this.roof = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat.clone(), MAX);
    for (const m of [this.body, this.roof]) {
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  sync(list: readonly EconBuilding[]): void {
    let sig = '';
    for (const b of list) sig += `${b.id}${b.kind[0]}${b.owner}${b.ruined ? 'x' : ''}${Math.round(b.progress * 10)}${Math.round((b.hp / b.maxHp) * 4)};`;
    if (sig === this.sig) return;
    this.sig = sig;
    let n = 0;
    for (const b of list) {
      if (n >= MAX) break;
      const [sx, sy, sz] = SIZE[b.kind];
      const y = this.terrain.heightAt(b.pos.x, b.pos.z);
      const rise = b.ruined ? 0.12 : 0.15 + 0.85 * b.progress;
      const shade = b.ruined ? 0.35 : 0.55 + 0.45 * (b.hp / b.maxHp);
      _q.setFromEuler(_e.set(0, -b.facing, 0));
      _m.compose(_p.set(b.pos.x, y - 0.3, b.pos.z), _q, _s.set(sx, sy * rise + 0.3, sz));
      this.body.setMatrixAt(n, _m);
      this.body.setColorAt(n, _c.set(BODY[b.kind]).multiplyScalar(shade));
      // Roof (in the owner's colour) only once the walls stand.
      const roofOn = !b.ruined && b.progress >= 0.85;
      _m.compose(_p.set(b.pos.x, y - 0.3 + sy * rise + 0.3, b.pos.z), _q, _s.set(roofOn ? sx * 1.05 : 0.001, roofOn ? 1.2 : 0.001, roofOn ? sz * 1.05 : 0.001));
      this.roof.setMatrixAt(n, _m);
      _f.set(b.owner >= 0 ? this.colorOf(b.owner) : '#777777');
      this.roof.setColorAt(n, _c.set('#5b5048').lerp(_f, 0.55).multiplyScalar(shade));
      n++;
    }
    for (const m of [this.body, this.roof]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of [this.body, this.roof]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
