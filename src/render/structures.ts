import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { V2 } from '../sim/vec';
import { fieldWorkParts } from './fieldWorkParts';
import { InstanceBatch, tintedMaterial, trs } from './instancing';
import { sharedStructureParts, structureKind, type StructureKindDef } from './structureKinds';

/**
 * Built structures — 2.0 pillboxes (炮楼) and bunkers (堡垒), and any kind registered in
 * structureKinds (2.2 hook for economic buildings and town depots): every one drawn through
 * shared InstancedMeshes, one per kind and part (body, roof, skirt) plus a shared footing,
 * rubble and pennant batch. Construction shows foundation → walls rising → roof; damage darkens
 * the instance; a destroyed structure leaves rubble for a while. Instances are refilled only
 * when a cheap per-frame signature (ids, progress step, damage step, owner) changes.
 */
const STEPS = 24;
const RUIN_SECONDS = 90;
/** Construction stages (progress): footing only below `walls`; roof from `roof`. */
const STAGE = { walls: 0.15, roof: 0.85 } as const;
/** Concrete shade by damage (hp ratio ≥ 0.66 / ≥ 0.33 / below). */
const SHADE = [1, 0.82, 0.64] as const;

/** What StructureViews needs of a structure (the sim's Fort satisfies it; so can new records). */
export interface StructureRecord {
  readonly id: number;
  readonly kind: string;
  readonly pos: V2;
  /** Facing (radians, sim convention); 0 when the structure has none. */
  readonly facing?: number;
  /** Construction progress 0..1 (1 = complete). */
  readonly progress: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly owner: number;
  /** A destroyed structure whose ruin stays until the record goes (economic buildings). */
  readonly ruined?: boolean;
}

interface Known {
  rec: StructureRecord;
  def: StructureKindDef;
  seen: number;
  ruinUntil: number;
}

interface KindBatches {
  readonly body: InstanceBatch;
  readonly roof: InstanceBatch | null;
  readonly skirt: InstanceBatch | null;
  readonly scaffold: InstanceBatch | null;
  readonly ruin: InstanceBatch | null;
}

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _fc = new THREE.Color();

export class StructureViews {
  readonly group = new THREE.Group();
  /** Live construction sites (for work dust), first `siteCount` valid. */
  readonly sites: THREE.Vector3[] = [];
  siteCount = 0;
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02 });
  private readonly kinds = new Map<string, KindBatches>();
  private readonly footing: InstanceBatch;
  private readonly rubble: InstanceBatch;
  private readonly flags: InstanceBatch;
  private readonly known = new Map<number, Known>();
  private frame = 0;
  private sig = NaN;

  constructor(private readonly terrain: Terrain, private readonly colorOf: (owner: number) => string) {
    const shared = sharedStructureParts();
    this.footing = new InstanceBatch(this.group, shared.footing, this.mat, 8);
    this.rubble = new InstanceBatch(this.group, shared.rubble, this.mat, 8);
    this.flags = new InstanceBatch(this.group, fieldWorkParts().pennant, tintedMaterial(0.85, 0.02), 16);
  }

  private batchesOf(kind: string, def: StructureKindDef): KindBatches {
    let k = this.kinds.get(kind);
    if (!k) {
      const mk = (g: THREE.BufferGeometry | undefined): InstanceBatch | null => (g ? new InstanceBatch(this.group, g, this.mat, 8) : null);
      k = { body: mk(def.body)!, roof: mk(def.roof), skirt: mk(def.skirt), scaffold: mk(def.scaffold), ruin: mk(def.ruin) };
      this.kinds.set(kind, k);
    }
    return k;
  }

  private batches(): InstanceBatch[] {
    const out = [this.footing, this.rubble, this.flags];
    for (const k of this.kinds.values()) for (const b of [k.body, k.roof, k.skirt, k.scaffold, k.ruin]) if (b) out.push(b);
    return out;
  }

  /**
   * Per frame: signature check; instances are rebuilt only when something visible changed.
   * Records of kinds without a registered definition (trenches, sandbags…) are ignored.
   */
  sync(records: readonly StructureRecord[], time: number): void {
    const f = ++this.frame;
    let h = 2166136261;
    for (const rec of records) {
      const def = structureKind(rec.kind);
      if (!def) continue;
      let k = this.known.get(rec.id);
      if (!k) {
        k = { rec, def, seen: f, ruinUntil: NaN };
        this.known.set(rec.id, k);
      }
      k.rec = rec;
      k.def = def;
      k.seen = f;
      if (rec.ruined) k.ruinUntil = Infinity;
      else if (rec.hp > 0) k.ruinUntil = NaN;
      else if (Number.isNaN(k.ruinUntil) || k.ruinUntil === Infinity) k.ruinUntil = time + RUIN_SECONDS;
      h = mix(mix(mix(mix(mix(h, rec.id), stepOf(rec.progress)), damageStep(rec)), rec.owner), rec.ruined ? 1 : 0);
    }
    for (const [id, k] of this.known) {
      if (k.seen !== f && (Number.isNaN(k.ruinUntil) || k.ruinUntil === Infinity)) k.ruinUntil = k.rec.progress > 0.3 ? time + RUIN_SECONDS : time;
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
    // Batches for every known kind exist before begin(), so each is cleared and refilled.
    for (const k of this.known.values()) this.batchesOf(k.rec.kind, k.def);
    const all = this.batches();
    for (const b of all) b.begin();
    this.siteCount = 0;
    for (const k of this.known.values()) this.draw(k.rec, k.def, !Number.isNaN(k.ruinUntil));
    for (const b of all) b.end();
  }

  private draw(rec: StructureRecord, def: StructureKindDef, ruined: boolean): void {
    const x = rec.pos.x;
    const z = rec.pos.z;
    const y = this.terrain.heightAt(x, z);
    const facing = rec.facing ?? 0;
    const yaw = -facing;
    const fp = def.footprint;
    const kb = this.batchesOf(rec.kind, def);
    if (ruined) {
      _c.setScalar(0.8);
      if (kb.ruin) {
        kb.ruin.push(trs(x, y - 0.05, z, 0, yaw, 0, 1, 1, 1, _m), WHITE);
        return;
      }
      const s = Math.max(fp.x, fp.z) / 3.2;
      this.rubble.push(trs(x, y, z, 0, yaw + rec.id, 0, s, 1, s, _m), _c);
      return;
    }
    const p = stepOf(rec.progress) / STEPS;
    _c.setScalar(SHADE[damageStep(rec)]);
    if (p < 1) {
      // Foundation slab with formwork while it is being built.
      this.footing.push(trs(x, y, z, 0, yaw, 0, fp.x + 0.8, 1, fp.z + 0.8, _m), WHITE);
      this.siteAt(x, y + 1.5, z);
    }
    if (p >= STAGE.walls) {
      const wall = Math.min(1, (p - STAGE.walls) / (STAGE.roof - STAGE.walls));
      const hgt = def.height * Math.max(0.08, wall);
      kb.body.push(trs(x, y - 0.05, z, 0, yaw, 0, 1, hgt, 1, _m), _c);
      if (p < 1 && kb.scaffold) kb.scaffold.push(trs(x, y - 0.05, z, 0, yaw, 0, 1, 1, 1, _m), WHITE);
      if (p >= STAGE.roof && kb.roof) kb.roof.push(trs(x, y + hgt, z, 0, yaw, 0, 1, 1, 1, _m), _c);
    }
    if (p >= 1) {
      kb.skirt?.push(trs(x, y - 0.1, z, 0, yaw, 0, 1, 1, 1, _m), WHITE);
      if (def.flag) {
        _fc.set(this.colorOf(rec.owner));
        // Pennant at the rear of the roof.
        const px = x - Math.cos(facing) * def.flag.back;
        const pz = z - Math.sin(facing) * def.flag.back;
        this.flags.push(trs(px, y + def.flag.top, pz, 0, yaw, 0, 0.8, 0.8, 0.8, _m), _fc);
      }
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

function damageStep(f: StructureRecord): 0 | 1 | 2 {
  const r = f.maxHp > 0 ? f.hp / f.maxHp : 1;
  return r >= 0.66 ? 0 : r >= 0.33 ? 1 : 2;
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}
