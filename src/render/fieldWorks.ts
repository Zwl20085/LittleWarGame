import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Fort } from '../sim/types';
import { vhash } from './formations';
import { InstanceBatch, tintedMaterial, trs } from './instancing';
import { fieldWorkParts } from './fieldWorkParts';
import { CREST, FIRE_STEP, sweepTrench, TRENCH_X, type SweepArrays } from './trenchSweep';

/**
 * Linear field works — zig-zag fire trenches and town sandbag barricades — drawn for every
 * fort through one merged earthworks mesh plus a handful of shared InstancedMeshes (sandbags,
 * revetment posts, wire coils, crates, owner pennants): 6 draw calls however many works stand.
 * Everything is rebuilt only when a work appears / disappears / grows a visible step / is
 * wrecked (a cheap numeric signature is checked per frame, no allocation); trench sweeps are
 * cached per work so a rebuild is mostly typed-array copies.
 */

export type LineWorkKind = 'trench' | 'sandbag';

export function isLineWork(kind: Fort['kind']): kind is LineWorkKind {
  return kind === 'trench' || kind === 'sandbag';
}

/** Trench traverse: bay length and zig-zag amplitude (m). */
const BAY = 12;
const AMP = 3.2;
/** Sandbag (barricade course) size: length, height, depth (m, already visually exaggerated). */
const BAG = { l: 1.3, h: 0.55, d: 0.8 } as const;
const WALL_ROWS = 6;
/** Construction progress is shown in 1/STEPS increments (bounds rebuild frequency). */
const STEPS = 48;
/** Badly damaged works that vanish from the sim leave a ruin for this long (sim seconds). */
const RUIN_SECONDS = 60;

const WHITE = new THREE.Color(1, 1, 1);
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _fc = new THREE.Color();

interface Known {
  fort: Fort;
  seen: number;
  /** Sim time when the ruin expires (NaN = standing). */
  ruinUntil: number;
}

/** Placement frame for one straight piece: origin, along (ux,uz), toward-enemy (fx,fz). */
interface Frame {
  x: number;
  z: number;
  ux: number;
  uz: number;
  fx: number;
  fz: number;
  /** Yaw putting local +x along the piece and local +z toward the enemy. */
  yaw: number;
  /** Local +x runs backward along the piece (yaw turned half round to face the enemy). */
  flip: boolean;
}
const _fr: Frame = { x: 0, z: 0, ux: 1, uz: 0, fx: 0, fz: 1, yaw: 0, flip: false };

export class FieldWorks {
  readonly group = new THREE.Group();
  private readonly earth: THREE.Mesh;
  private readonly sweeps = new Map<number, { key: number; arrays: SweepArrays; frame: number }>();
  private readonly earthParts: SweepArrays[] = [];
  private buildNo = 0;
  private readonly path: number[] = [];
  private readonly bags: InstanceBatch;
  private readonly posts: InstanceBatch;
  private readonly wire: InstanceBatch;
  private readonly crates: InstanceBatch;
  private readonly flags: InstanceBatch;
  private readonly known = new Map<number, Known>();
  private frame = 0;
  private sig = NaN;
  /** Construction sites (tip of a growing work) for work dust; first `siteCount` are live. */
  readonly sites: THREE.Vector3[] = [];
  siteCount = 0;
  private readonly pts: number[] = [];

  constructor(private readonly terrain: Terrain, private readonly colorOf: (owner: number) => string) {
    const parts = fieldWorkParts();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    this.earth = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.earth.castShadow = true;
    this.earth.receiveShadow = true;
    this.earth.frustumCulled = false;
    this.group.add(this.earth);
    this.bags = new InstanceBatch(this.group, parts.bag, mat, 512);
    this.posts = new InstanceBatch(this.group, parts.post, mat, 128);
    this.wire = new InstanceBatch(this.group, parts.wire, mat, 32);
    this.crates = new InstanceBatch(this.group, parts.crate, mat, 16);
    this.flags = new InstanceBatch(this.group, parts.pennant, tintedMaterial(0.85, 0.02), 16);
    for (const b of this.batches()) b.mesh.receiveShadow = true;
  }

  private batches(): InstanceBatch[] {
    return [this.bags, this.posts, this.wire, this.crates, this.flags];
  }

  /** Per frame: cheap change check; rebuilds the instance batches only when something changed. */
  sync(forts: readonly Fort[], time: number): void {
    const f = ++this.frame;
    let h = 2166136261;
    for (const fort of forts) {
      if (!isLineWork(fort.kind)) continue;
      let k = this.known.get(fort.id);
      if (!k) {
        k = { fort, seen: f, ruinUntil: NaN };
        this.known.set(fort.id, k);
      }
      k.fort = fort;
      k.seen = f;
      k.ruinUntil = NaN;
      h = mix(h, fort.id);
      h = mix(h, stepOf(fort.progress));
      h = mix(h, fort.hp > 0 ? 1 : 2);
      h = mix(h, fort.owner);
    }
    for (const [id, k] of this.known) {
      if (k.seen === f) continue;
      // Gone from the sim: a battered work leaves a ruin for a while, a dismantled one just goes.
      if (Number.isNaN(k.ruinUntil)) {
        if (k.fort.hp < k.fort.maxHp * 0.5 && k.fort.progress > 0.3) k.ruinUntil = time + RUIN_SECONDS;
        else {
          this.known.delete(id);
          continue;
        }
      }
      if (time > k.ruinUntil) {
        this.known.delete(id);
        continue;
      }
      h = mix(mix(h, id), 3);
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
    this.buildNo++;
    for (const k of this.known.values()) {
      const fort = k.fort;
      const wrecked = fort.hp <= 0 || !Number.isNaN(k.ruinUntil);
      _fc.set(this.colorOf(fort.owner));
      if (fort.kind === 'trench') this.trench(fort, wrecked);
      else this.wall(fort, wrecked);
    }
    for (const b of all) b.end();
    this.flushEarth();
  }

  /** Straight-piece frame from a→b with the parapet side chosen toward `facing`. */
  private frameOf(ax: number, az: number, bx: number, bz: number, facing: number, out: Frame): Frame {
    const len = Math.hypot(bx - ax, bz - az) || 1;
    out.x = ax;
    out.z = az;
    out.ux = (bx - ax) / len;
    out.uz = (bz - az) / len;
    // Local +z for yaw = -a is (-sin a, cos a) = (-uz, ux); flip to the enemy side.
    const s = Math.cos(facing) * -out.uz + Math.sin(facing) * out.ux >= 0 ? 1 : -1;
    out.fx = -out.uz * s;
    out.fz = out.ux * s;
    out.yaw = -Math.atan2(out.uz, out.ux) + (s < 0 ? Math.PI : 0);
    out.flip = s < 0;
    return out;
  }

  private site(x: number, y: number, z: number): void {
    if (this.siteCount >= this.sites.length) this.sites.push(new THREE.Vector3());
    this.sites[this.siteCount++].set(x, y, z);
  }

  private pushPennant(x: number, z: number, yaw: number): void {
    this.flags.push(trs(x, this.terrain.heightAt(x, z), z, 0, yaw, 0, 1, 1, 1, _m), _fc);
  }

  /** Zig-zag trench axis (flat x,z pairs) from start to end; both ends on the axis. */
  private trenchPath(fort: Fort): void {
    const [s, e] = endsOf(fort);
    const len = Math.hypot(e.x - s.x, e.z - s.z);
    const ux = (e.x - s.x) / (len || 1);
    const uz = (e.z - s.z) / (len || 1);
    const bays = Math.max(2, Math.round(len / BAY));
    const pts = this.pts;
    pts.length = 0;
    for (let k = 0; k <= bays; k++) {
      const d = (k / bays) * len;
      const off = k === 0 || k === bays ? 0 : (k % 2 ? AMP : -AMP) * (0.8 + 0.4 * vhash(fort.id, k, 41));
      pts.push(s.x + ux * d - uz * off, s.z + uz * d + ux * off);
    }
  }

  /**
   * Trench: swept earthworks along the dug part of the zig-zag (cached per work and progress
   * step), sandbags on the parapet crest, revetment posts on the fire step, owner pennant.
   */
  private trench(fort: Fort, wrecked: boolean): void {
    const t = this.terrain;
    this.trenchPath(fort);
    const pts = this.pts;
    const [s, e] = endsOf(fort);
    // Enemy on the axis' left ((-dz, dx)) → side +1.
    const side = Math.cos(fort.facing) * -(e.z - s.z) + Math.sin(fort.facing) * (e.x - s.x) >= 0 ? 1 : -1;
    let total = 0;
    for (let i = 2; i < pts.length; i += 2) total += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    const p = wrecked ? 1 : stepOf(fort.progress) / STEPS;
    const flatten = wrecked ? 0.4 : 1;
    let budget = total * Math.max(0.04, p);
    const path = this.path;
    path.length = 0;
    path.push(pts[0], pts[1]);
    const seed = fort.id;
    let bagK = 0;
    let tipX = pts[0];
    let tipZ = pts[1];
    for (let i = 0; i + 3 < pts.length && budget > 0.5; i += 2) {
      const ax = pts[i];
      const az = pts[i + 1];
      const segLen = Math.hypot(pts[i + 2] - ax, pts[i + 3] - az);
      const len = Math.min(segLen, budget);
      budget -= len;
      const ux = (pts[i + 2] - ax) / segLen;
      const uz = (pts[i + 3] - az) / segLen;
      const fx = -uz * side;
      const fz = ux * side;
      const yaw = -Math.atan2(uz, ux);
      // Sub-divide so the earthworks drape over the ground between corners.
      const subs = Math.max(1, Math.ceil(len / 4));
      for (let k = 1; k <= subs; k++) path.push(ax + ux * ((len * k) / subs), az + uz * ((len * k) / subs));
      tipX = ax + ux * len;
      tipZ = az + uz * len;
      // Sandbags along the crest (clear of the mitred corners), second course here and there.
      const cl = CREST.lat * TRENCH_X;
      for (let d = 1.6; d < len - 1.2; d += BAG.l * 1.02) {
        const r = vhash(seed, bagK++, 42);
        let x = ax + ux * d + fx * cl;
        let z = az + uz * d + fz * cl;
        let y = t.heightAt(x, z) + CREST.y * TRENCH_X * flatten + BAG.h * 0.3;
        let yawJ = (r - 0.5) * 0.22;
        let roll = 0;
        if (wrecked) {
          if (r < 0.45) continue;
          x += (vhash(seed, bagK, 43) - 0.5) * 7;
          z += (vhash(seed, bagK, 44) - 0.5) * 7;
          y = t.heightAt(x, z) + BAG.h * 0.4;
          yawJ = r * 6;
          roll = (vhash(seed, bagK, 45) - 0.5) * 0.8;
        }
        _c.setScalar(0.86 + r * 0.2);
        this.bags.push(trs(x, y, z, roll, yaw + yawJ, 0, BAG.l, BAG.h, BAG.d, _m), _c);
        if (!wrecked && r > 0.5 && d + BAG.l < len - 1.2) {
          this.bags.push(trs(x + ux * BAG.l * 0.5 + fx * 0.15, y + BAG.h * 0.9, z + uz * BAG.l * 0.5 + fz * 0.15, 0, yaw - yawJ, 0, BAG.l, BAG.h, BAG.d * 0.9, _m), _c);
        }
      }
      const pl = FIRE_STEP * TRENCH_X - 0.05;
      for (let d = 2.2; d < len - 1.5; d += 4.2) {
        const x = ax + ux * d + fx * pl;
        const z = az + uz * d + fz * pl;
        const lean = wrecked ? (vhash(seed, i * 31 + Math.round(d), 46) - 0.5) * 1.6 : 0;
        this.posts.push(trs(x, t.heightAt(x, z), z, lean, yaw, 0, 1, wrecked ? 0.5 : 1, 1, _m), WHITE);
      }
    }
    this.earthOf(fort, wrecked, side, flatten);
    if (!wrecked && p < 1) this.site(tipX, t.heightAt(tipX, tipZ) + 1, tipZ);
    if (!wrecked && pts.length >= 4) {
      // Owner pennant on the spoil bank behind the middle of the line.
      const ax = e.x - s.x;
      const az = e.z - s.z;
      const al = Math.hypot(ax, az) || 1;
      const mx = (s.x + e.x) / 2 - (-az / al) * side * 4.2 * TRENCH_X;
      const mz = (s.z + e.z) / 2 - (ax / al) * side * 4.2 * TRENCH_X;
      this.pushPennant(mx, mz, -Math.atan2(az, ax));
    }
  }

  /** Earthworks sweep for the current dug path, reused until the work grows or is wrecked. */
  private earthOf(fort: Fort, wrecked: boolean, side: number, flatten: number): void {
    const key = stepOf(fort.progress) * 2 + (wrecked ? 1 : 0);
    let c = this.sweeps.get(fort.id);
    if (!c || c.key !== key) {
      c = { key, arrays: sweepTrench(this.path, side, (x, z) => this.terrain.heightAt(x, z), flatten), frame: 0 };
      this.sweeps.set(fort.id, c);
    }
    c.frame = this.buildNo;
    this.earthParts.push(c.arrays);
  }

  /** Merge every trench's cached sweep into the single earthworks mesh. */
  private flushEarth(): void {
    for (const [id, c] of this.sweeps) if (c.frame !== this.buildNo) this.sweeps.delete(id);
    let n = 0;
    for (const a of this.earthParts) n += a.pos.length;
    const pos = new Float32Array(n);
    const nor = new Float32Array(n);
    const col = new Float32Array(n);
    let o = 0;
    for (const a of this.earthParts) {
      pos.set(a.pos, o);
      nor.set(a.nor, o);
      col.set(a.col, o);
      o += a.pos.length;
    }
    this.earthParts.length = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    this.earth.geometry.dispose();
    this.earth.geometry = g;
  }

  private wall(fort: Fort, wrecked: boolean): void {
    const t = this.terrain;
    const [s, e] = endsOf(fort);
    const len = Math.max(BAG.l * 2, Math.hypot(e.x - s.x, e.z - s.z));
    const fr = this.frameOf(s.x, s.z, e.x, e.z, fort.facing, _fr);
    const p = wrecked ? 1 : stepOf(fort.progress) / STEPS;
    const built = len * Math.max(0.05, p);
    const seed = fort.id * 7 + 3;
    const n = Math.max(1, Math.round(len / BAG.l));
    const bl = len / n;
    let k = 0;
    const rows = wrecked ? 2 : WALL_ROWS;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? bl / 2 : 0;
      // Bottom two courses are two bags deep; the wall tapers above.
      const depthZ = r < 2 ? [-BAG.d * 0.52, BAG.d * 0.52] : r < 4 ? [0] : [BAG.d * 0.1];
      for (let i = 0; i < n + (r % 2); i++) {
        const d = Math.min(len - bl * 0.25, Math.max(bl * 0.25, (i + 0.5) * bl - off));
        if (d > built) continue;
        // Loopholes: gaps in the top course.
        if (!wrecked && r === rows - 1 && i % 5 === 2) continue;
        for (const dz of depthZ) {
          const rr = vhash(seed, k++, 47);
          if (wrecked && rr < 0.45) continue;
          const x = s.x + fr.ux * d + fr.fx * dz;
          const z = s.z + fr.uz * d + fr.fz * dz;
          const y = t.heightAt(x, z) + BAG.h * (r + 0.45);
          _c.setScalar(0.84 + rr * 0.22);
          this.bags.push(trs(x, y, z, 0, fr.yaw + (rr - 0.5) * 0.18, 0, bl * 1.02, BAG.h, BAG.d, _m), _c);
        }
      }
    }
    if (wrecked) {
      // Spilled bags thrown both ways.
      for (let i = 0; i < Math.round(len / 2); i++) {
        const d = vhash(seed, i, 48) * len;
        const side = (vhash(seed, i, 49) - 0.5) * 9;
        const x = s.x + fr.ux * d + fr.fx * side;
        const z = s.z + fr.uz * d + fr.fz * side;
        _c.setScalar(0.8 + vhash(seed, i, 50) * 0.2);
        this.bags.push(trs(x, t.heightAt(x, z) + BAG.h * 0.4, z, (vhash(seed, i, 51) - 0.5) * 0.6, vhash(seed, i, 52) * 6.3, 0, BAG.l, BAG.h, BAG.d, _m), _c);
      }
      return;
    }
    if (p < 1) {
      const x = s.x + fr.ux * built;
      const z = s.z + fr.uz * built;
      this.site(x, t.heightAt(x, z) + 1, z);
      return;
    }
    // Finished: concertina wire out front, a few ammunition crates behind.
    const coils = Math.max(1, Math.round(len / 5.2));
    const cl = len / coils;
    for (let i = 0; i < coils; i++) {
      const d = (i + 0.5) * cl;
      const wob = (vhash(seed, i, 53) - 0.5) * 1.2;
      const x = s.x + fr.ux * d + fr.fx * (5.5 + wob);
      const z = s.z + fr.uz * d + fr.fz * (5.5 + wob);
      this.wire.push(trs(x, t.heightAt(x, z), z, 0, fr.yaw + (vhash(seed, i, 54) - 0.5) * 0.2, 0, cl / 5.2, 1, 1, _m), WHITE);
    }
    const crates = 1 + Math.floor(vhash(seed, 0, 55) * 3);
    for (let i = 0; i < crates; i++) {
      const d = (0.15 + 0.7 * vhash(seed, i, 56)) * len;
      const x = s.x + fr.ux * d - fr.fx * (2.2 + vhash(seed, i, 57) * 1.5);
      const z = s.z + fr.uz * d - fr.fz * (2.2 + vhash(seed, i, 57) * 1.5);
      this.crates.push(trs(x, t.heightAt(x, z), z, 0, fr.yaw + vhash(seed, i, 58) * 1.2, 0, 1, 1, 1, _m), WHITE);
    }
    this.pushPennant(s.x - fr.fx * 2.4 + fr.ux * 0.6, s.z - fr.fz * 2.4 + fr.uz * 0.6, fr.yaw);
  }

  dispose(): void {
    for (const b of this.batches()) b.dispose();
    this.earth.geometry.dispose();
    this.group.removeFromParent();
  }
}

const _s = { x: 0, z: 0 };
const _e = { x: 0, z: 0 };

/**
 * Work endpoints. Falls back to a line across `facing` through `pos` (of `length`, or a default
 * per kind) when the sim gives none or a degenerate span. Returns shared scratch objects.
 */
function endsOf(fort: Fort): [{ x: number; z: number }, { x: number; z: number }] {
  const a = fort.start;
  const b = fort.end;
  if (a && b && Math.hypot(b.x - a.x, b.z - a.z) > 2) {
    _s.x = a.x; _s.z = a.z; _e.x = b.x; _e.z = b.z;
    return [_s, _e];
  }
  const half = Math.max(2, (fort.length ?? (fort.kind === 'trench' ? 60 : 14)) / 2);
  const px = -Math.sin(fort.facing);
  const pz = Math.cos(fort.facing);
  _s.x = fort.pos.x - px * half; _s.z = fort.pos.z - pz * half;
  _e.x = fort.pos.x + px * half; _e.z = fort.pos.z + pz * half;
  return [_s, _e];
}

function stepOf(progress: number): number {
  return Math.max(1, Math.min(STEPS, Math.ceil(Math.max(0, progress) * STEPS)));
}

function mix(h: number, v: number): number {
  return Math.imul(h ^ (v | 0), 16777619) >>> 0;
}
