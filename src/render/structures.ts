import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Fort } from '../sim/types';
import { fieldWorkParts } from './fieldWorkParts';
import { InstanceBatch, tintedMaterial, trs } from './instancing';
import { BUNKER_SIZE, getStructureParts, PILLBOX_SIZE } from './models';

/**
 * Pillboxes (炮楼) and bunkers (堡垒), 2.0 defensive buildings: every one drawn through a handful
 * of shared InstancedMeshes (body, roof, skirt / berm per kind, footing, rubble, pennant: 9 draw
 * calls however many stand). Construction shows foundation → walls rising → roof; damage darkens
 * the concrete; a destroyed building leaves rubble for a while. Instances are refilled only when
 * a cheap per-frame signature (ids, progress step, damage step, owner) changes.
 */
const STEPS = 24;
const RUIN_SECONDS = 90;
/** Construction stages (progress): footing only below `walls`; roof from `roof`. */
const STAGE = { walls: 0.15, roof: 0.85 } as const;
/** Concrete shade by damage (hp ratio ≥ 0.66 / ≥ 0.33 / below). */
const SHADE = [1, 0.82, 0.64] as const;

type Kind = 'pillbox' | 'bunker';
const isBuilding = (k: Fort['kind']): k is Kind => k === 'pillbox' || k === 'bunker';

interface Known {
  fort: Fort;
  seen: number;
  ruinUntil: number;
}

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _fc = new THREE.Color();

export class StructureViews {
  readonly group = new THREE.Group();
  /** Live construction sites (for work dust), first `siteCount` valid. */
  readonly sites: THREE.Vector3[] = [];
  siteCount = 0;
  private readonly pbBody: InstanceBatch;
  private readonly pbRoof: InstanceBatch;
  private readonly pbSkirt: InstanceBatch;
  private readonly bkBody: InstanceBatch;
  private readonly bkRoof: InstanceBatch;
  private readonly bkBerm: InstanceBatch;
  private readonly footing: InstanceBatch;
  private readonly rubble: InstanceBatch;
  private readonly flags: InstanceBatch;
  private readonly known = new Map<number, Known>();
  private frame = 0;
  private sig = NaN;

  constructor(private readonly terrain: Terrain, private readonly colorOf: (owner: number) => string) {
    const p = getStructureParts();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 });
    this.pbBody = new InstanceBatch(this.group, p.pbBody, mat, 16);
    this.pbRoof = new InstanceBatch(this.group, p.pbRoof, mat, 16);
    this.pbSkirt = new InstanceBatch(this.group, p.pbSkirt, mat, 16);
    this.bkBody = new InstanceBatch(this.group, p.bkBody, mat, 8);
    this.bkRoof = new InstanceBatch(this.group, p.bkRoof, mat, 8);
    this.bkBerm = new InstanceBatch(this.group, p.bkBerm, mat, 8);
    this.footing = new InstanceBatch(this.group, p.footing, mat, 8);
    this.rubble = new InstanceBatch(this.group, p.rubble, mat, 8);
    this.flags = new InstanceBatch(this.group, fieldWorkParts().pennant, tintedMaterial(0.85, 0.02), 16);
  }

  private batches(): InstanceBatch[] {
    return [this.pbBody, this.pbRoof, this.pbSkirt, this.bkBody, this.bkRoof, this.bkBerm, this.footing, this.rubble, this.flags];
  }

  /** Per frame: signature check; instances are rebuilt only when something visible changed. */
  sync(forts: readonly Fort[], time: number): void {
    const f = ++this.frame;
    let h = 2166136261;
    for (const fort of forts) {
      if (!isBuilding(fort.kind)) continue;
      let k = this.known.get(fort.id);
      if (!k) {
        k = { fort, seen: f, ruinUntil: NaN };
        this.known.set(fort.id, k);
      }
      k.fort = fort;
      k.seen = f;
      if (fort.hp > 0) k.ruinUntil = NaN;
      else if (Number.isNaN(k.ruinUntil)) k.ruinUntil = time + RUIN_SECONDS;
      h = mix(mix(mix(mix(h, fort.id), stepOf(fort.progress)), damageStep(fort)), fort.owner);
    }
    for (const [id, k] of this.known) {
      if (k.seen !== f && Number.isNaN(k.ruinUntil)) k.ruinUntil = k.fort.progress > 0.3 ? time + RUIN_SECONDS : time;
      if (!Number.isNaN(k.ruinUntil) && time > k.ruinUntil) {
        this.known.delete(id);
        continue;
      }
      if (k.seen !== f) h = mix(mix(h, id), 7);
    }
    h = mix(h, this.known.size);
    if (h === this.sig) return;
    this.sig = h;
    this.rebuild();
  }

  private rebuild(): void {
    const all = this.batches();
    for (const b of all) b.begin();
    this.siteCount = 0;
    for (const k of this.known.values()) this.draw(k.fort, !Number.isNaN(k.ruinUntil));
    for (const b of all) b.end();
  }

  private draw(fort: Fort, ruined: boolean): void {
    const x = fort.pos.x;
    const z = fort.pos.z;
    const y = this.terrain.heightAt(x, z);
    const yaw = -fort.facing;
    const pill = fort.kind === 'pillbox';
    const size = pill ? PILLBOX_SIZE.r * 2 : Math.max(BUNKER_SIZE.w, BUNKER_SIZE.d);
    if (ruined) {
      _c.setScalar(0.8);
      this.rubble.push(trs(x, y, z, 0, yaw + fort.id, 0, size / 3.2, 1, size / 3.2, _m), _c);
      return;
    }
    const p = stepOf(fort.progress) / STEPS;
    _c.setScalar(SHADE[damageStep(fort)]);
    if (p < 1) {
      // Foundation slab with formwork while it is being built.
      const fw = pill ? PILLBOX_SIZE.r * 2.2 : BUNKER_SIZE.d + 0.8;
      const fd = pill ? PILLBOX_SIZE.r * 2.2 : BUNKER_SIZE.w + 0.8;
      this.footing.push(trs(x, y, z, 0, yaw, 0, fw, 1, fd, _m), WHITE);
      this.siteAt(x, y + 1.5, z);
    }
    if (p >= STAGE.walls) {
      const wall = Math.min(1, (p - STAGE.walls) / (STAGE.roof - STAGE.walls));
      const hgt = (pill ? PILLBOX_SIZE.h : BUNKER_SIZE.h) * Math.max(0.08, wall);
      (pill ? this.pbBody : this.bkBody).push(trs(x, y - 0.05, z, 0, yaw, 0, 1, hgt, 1, _m), _c);
      if (p >= STAGE.roof) (pill ? this.pbRoof : this.bkRoof).push(trs(x, y + hgt, z, 0, yaw, 0, 1, 1, 1, _m), _c);
    }
    if (p >= 1) {
      (pill ? this.pbSkirt : this.bkBerm).push(trs(x, y - 0.1, z, 0, yaw, 0, 1, 1, 1, _m), WHITE);
      _fc.set(this.colorOf(fort.owner));
      // Pennant at the rear of the roof.
      const back = pill ? PILLBOX_SIZE.r * 0.6 : BUNKER_SIZE.d * 0.4;
      const px = x - Math.cos(fort.facing) * back;
      const pz = z - Math.sin(fort.facing) * back;
      const top = pill ? PILLBOX_SIZE.h + 0.3 : BUNKER_SIZE.h + 0.4;
      this.flags.push(trs(px, y + top, pz, 0, yaw, 0, 0.8, 0.8, 0.8, _m), _fc);
    }
  }

  private siteAt(x: number, y: number, z: number): void {
    if (this.siteCount >= this.sites.length) this.sites.push(new THREE.Vector3());
    this.sites[this.siteCount++].set(x, y, z);
  }

  dispose(): void {
    for (const b of this.batches()) b.dispose();
    this.group.removeFromParent();
  }
}

const WHITE = new THREE.Color(1, 1, 1);

function stepOf(progress: number): number {
  return Math.max(1, Math.min(STEPS, Math.ceil(Math.max(0, progress) * STEPS)));
}

function damageStep(f: Fort): 0 | 1 | 2 {
  const r = f.maxHp > 0 ? f.hp / f.maxHp : 1;
  return r >= 0.66 ? 0 : r >= 0.33 ? 1 : 2;
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}
