import * as THREE from 'three';
import { aliveMembers } from '../sim/formulas';
import { Ground } from '../sim/terrain';
import type { Unit } from '../sim/types';
import type { World } from '../sim/world';
import { InstanceBatch, tintedMaterial } from './instancing';
import { PAL } from './palette';
import { choosePattern, crewSlot, slot, vhash, type Situation } from './formations';
import { modelSpec, SOLDIER_SCALE, unitGeometry, VEHICLE_SCALE, type ModelSpec } from './unitModels';

/** Per-unit render state (no Three.js objects — everything is drawn through shared batches). */
export interface UnitView {
  readonly id: number;
  readonly spec: ModelSpec;
  readonly color: THREE.Color;
  members: number;
  bob: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  turretRel: number;
  pitch: number;
  /** Gun recoil 0..1 (kicked by a big muzzle flash, springs back). */
  recoil: number;
  /** Not hidden by fog this frame. */
  visible: boolean;
  /** Inside the camera frustum this frame. */
  onScreen: boolean;
  seen: number;
  /** Soldier offsets from the unit centre in world axes (x,z pairs), eased between patterns. */
  readonly offs: Float32Array;
  laidOut: boolean;
  readonly goal: Float32Array;
  pattern: string;
  patternN: number;
  patternFace: number;
  settled: boolean;
  /** Cached soldier matrices for static squads. */
  readonly cache: Float32Array;
  readonly cacheKneel: Uint8Array;
  cacheN: number;
  cacheSit: string;
  cacheX: number;
  cacheZ: number;
  cacheFace: number;
}

interface Corpse {
  readonly key: string;
  readonly m: THREE.Matrix4;
  readonly color: THREE.Color;
  readonly wreck: boolean;
  life: number;
  readonly maxLife: number;
  readonly smoke: boolean;
  readonly pos: THREE.Vector3;
}

const MAX_CORPSES = 4000;
const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _body = new THREE.Matrix4();
const _turret = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _slot: [number, number] = [0, 0];
// Generous enough for an opened-up squad (SQUAD_SPREAD) or a big vehicle.
const _sphere = new THREE.Sphere(new THREE.Vector3(), 30);
/** A fallen soldier lies on its side: lift by half its (scaled) body width. */
const CORPSE_LIFT = 0.15 * SOLDIER_SCALE;
/** Selection-ring radius (m) around vehicles / squads and guns (matches the scaled models). */
const RING_VEHICLE = 8.5;
const RING_SQUAD = 14;
const RING_COLOR = new THREE.Color('#f4ecd9');

/** Write T(x,y,z)·Ry(a)·Rz(b)·S(s) straight into a matrix. */
function setYZ(m: THREE.Matrix4, x: number, y: number, z: number, a: number, b: number, s: number): THREE.Matrix4 {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const te = m.elements;
  te[0] = c * cb * s; te[1] = sb * s; te[2] = -sn * cb * s; te[3] = 0;
  te[4] = -c * sb * s; te[5] = cb * s; te[6] = sn * sb * s; te[7] = 0;
  te[8] = sn * s; te[9] = 0; te[10] = c * s; te[11] = 0;
  te[12] = x; te[13] = y; te[14] = z; te[15] = 1;
  return m;
}

/**
 * Draws every unit through a handful of InstancedMeshes (one per merged part geometry), with
 * interpolation, squad layout, crews around guns, brief casualties and burning wrecks.
 */
export class UnitViews {
  readonly group = new THREE.Group();
  readonly views = new Map<number, UnitView>();
  private readonly corpses: Corpse[] = [];
  private readonly batches = new Map<string, InstanceBatch>();
  private readonly wreckBatches = new Map<string, InstanceBatch>();
  private readonly material = tintedMaterial(0.9, 0.06);
  private readonly wreckMaterial = new THREE.MeshStandardMaterial({ color: PAL.wreck, roughness: 1 });
  private readonly rings: InstanceBatch;
  private readonly frustum = new THREE.Frustum();
  private readonly colors = new Map<number, THREE.Color>();
  private frameNo = 0;
  selected = new Set<number>();
  hovered: number | null = null;
  markerScale = 1;
  /** Burning-wreck flames/smoke through this callback (Effects); intensity fades 1 → 0. */
  onWreckFire: ((x: number, y: number, z: number, intensity: number) => void) | null = null;
  /** Dust thrown up by a moving vehicle's tracks (Effects). */
  onTrackDust: ((x: number, y: number, z: number, heading: number) => void) | null = null;
  /** Draw soldier figures (off at the farthest zoom where they are sub-pixel). */
  showSoldiers = true;

  constructor(private readonly world: World) {
    const ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false });
    this.rings = new InstanceBatch(this.group, ringGeo, ringMat, 32, false);
    this.rings.mesh.renderOrder = 3;
  }

  private batch(key: string, wreck = false): InstanceBatch {
    const map = wreck ? this.wreckBatches : this.batches;
    let b = map.get(key);
    if (!b) {
      const soldier = key.startsWith('soldier');
      b = new InstanceBatch(this.group, unitGeometry(key), wreck ? this.wreckMaterial : this.material, soldier ? 512 : 64);
      map.set(key, b);
    }
    return b;
  }

  private factionColor(owner: number): THREE.Color {
    let c = this.colors.get(owner);
    if (!c) {
      c = new THREE.Color(this.world.factions[owner]?.color ?? '#888888');
      this.colors.set(owner, c);
    }
    return c;
  }

  private create(u: Unit): UnitView {
    const v: UnitView = {
      id: u.id, spec: modelSpec(u.def.id, u.fixed), color: this.factionColor(u.owner),
      members: u.def.kind === 'vehicle' ? 0 : u.def.memberCount, bob: Math.random() * 10,
      x: u.pos.x, y: u.y, z: u.pos.z, heading: u.heading, turretRel: 0, pitch: 0, recoil: 0, visible: true, onScreen: true, seen: 0,
      offs: new Float32Array(Math.max(1, u.def.memberCount) * 2), laidOut: false,
      goal: new Float32Array(Math.max(1, u.def.memberCount) * 2), pattern: '', patternN: -1, patternFace: 0, settled: false,
      cache: new Float32Array(Math.max(1, u.def.memberCount) * 16), cacheKneel: new Uint8Array(Math.max(1, u.def.memberCount)),
      cacheN: -1, cacheSit: '', cacheX: 0, cacheZ: 0, cacheFace: 0,
    };
    this.views.set(u.id, v);
    return v;
  }

  private addCorpse(c: Omit<Corpse, 'life'>): void {
    if (this.corpses.length >= MAX_CORPSES) this.corpses.shift();
    this.corpses.push({ ...c, life: 0 });
  }

  /**
   * Squad soldiers in a situation-dependent pattern (file on roads, wedge/teams/cluster when
   * advancing, skirmish line facing the enemy when engaged) with stable personal jitter; slots
   * ease toward their new place so pattern changes are smooth. Casualties stay briefly.
   */
  private drawSquad(v: UnitView, u: Unit, dt: number, draw: boolean): void {
    const w = this.world;
    const alive = aliveMembers(u.def, u.hp, u.def.maxHp);
    const offs = v.offs;
    while (v.members > alive && v.members > 0) {
      v.members--;
      const wx = v.x + offs[v.members * 2];
      const wz = v.z + offs[v.members * 2 + 1];
      const y = w.terrain.heightAt(wx, wz) + CORPSE_LIFT;
      this.addCorpse({
        key: v.spec.soldier, m: setYZ(new THREE.Matrix4(), wx, y, wz, Math.random() * 6, Math.PI / 2, SOLDIER_SCALE),
        color: v.color, wreck: false, maxLife: 25, smoke: false, pos: new THREE.Vector3(wx, y, wz),
      });
    }
    const target = u.targetId !== null ? w.unitAlive(u.targetId) : null;
    const sit: Situation = u.moraleState === 'pinned' ? 'pinned'
      : (target && !u.moving) || u.moraleState === 'suppressed' ? 'engaged'
        : u.moving ? (w.terrain.groundAt(v.x, v.z) === Ground.Road ? 'road' : 'moving') : 'idle';
    const face = target && (sit === 'engaged' || sit === 'pinned') ? Math.atan2(target.pos.z - v.z, target.pos.x - v.x) : v.heading;
    const pattern = choosePattern(u.vseed, sit);
    if (v.laidOut && !draw) return;
    const ease = v.laidOut ? 1 - Math.exp(-dt * 2.2) : 1;
    v.laidOut = true;
    const n = v.members;
    // Slot targets only change with pattern / facing / strength; easing is cheap.
    if (pattern !== v.pattern || n !== v.patternN || Math.abs(face - v.patternFace) > 0.04) {
      v.pattern = pattern;
      v.patternN = n;
      v.patternFace = face;
      v.settled = false;
      const ca = Math.cos(face);
      const sa = Math.sin(face);
      for (let k = 0; k < n; k++) {
        slot(pattern, k, n, u.vseed, _slot);
        v.goal[k * 2] = ca * _slot[0] - sa * _slot[1];
        v.goal[k * 2 + 1] = sa * _slot[0] + ca * _slot[1];
      }
    }
    if (!v.settled) {
      let err = 0;
      for (let k = 0; k < n * 2; k++) {
        const d = v.goal[k] - offs[k];
        offs[k] += d * ease;
        err = Math.max(err, Math.abs(d));
      }
      v.settled = err < 0.02;
    }
    v.bob += dt * (u.moving ? 9 : 0);
    if (!draw) return;
    const kneelKey = 'soldierKneel';
    const standB = this.batch(v.spec.soldier);
    const kneelB = this.batch(kneelKey);
    // Static squads (settled, not moving) reuse last frame's matrices.
    const fresh = v.settled && !u.moving && v.cacheN === n && v.cacheSit === sit && v.cacheX === v.x && v.cacheZ === v.z && v.cacheFace === face;
    if (fresh) {
      for (let k = 0; k < n; k++) (v.cacheKneel[k] ? kneelB : standB).pushArray(v.cache, k * 16, v.color);
      return;
    }
    const terrain = w.terrain;
    const jitterAmp = sit === 'engaged' || sit === 'pinned' ? 0.35 : u.moving ? 0.2 : 0.9;
    for (let k = 0; k < n; k++) {
      const wx = v.x + offs[k * 2];
      const wz = v.z + offs[k * 2 + 1];
      const r = vhash(u.vseed, k, 31);
      let kneel = false;
      let tilt = 0;
      let lift = 0;
      if (sit === 'pinned' || (sit === 'engaged' && r > 0.6 && r < 0.85)) {
        tilt = -1.25;
        lift = 0.2 * SOLDIER_SCALE;
      } else if ((sit === 'engaged' && r <= 0.6) || (sit === 'idle' && r < 0.3)) kneel = true;
      else if (u.moving) {
        tilt = -0.12;
        lift = Math.abs(Math.sin(v.bob + k * 1.7)) * 0.09 * SOLDIER_SCALE;
      }
      const yawJ = (vhash(u.vseed, k, 32) - 0.5) * jitterAmp;
      const y = terrain.heightAt(wx, wz) + lift;
      setYZ(_m, wx, y, wz, -face + yawJ, tilt, SOLDIER_SCALE);
      v.cache.set(_m.elements, k * 16);
      v.cacheKneel[k] = kneel ? 1 : 0;
      (kneel ? kneelB : standB).push(_m, v.color);
    }
    v.cacheN = n;
    v.cacheSit = sit;
    v.cacheX = v.x;
    v.cacheZ = v.z;
    v.cacheFace = face;
  }

  /** Body / turret / crew matrices for a unit with a hull or a gun. */
  private bodyMatrix(v: UnitView, out: THREE.Matrix4): THREE.Matrix4 {
    return setYZ(out, v.x, v.y, v.z, -v.heading, v.pitch, v.spec.scale);
  }

  private turretMatrix(v: UnitView, body: THREE.Matrix4, out: THREE.Matrix4, extraYaw = 0): THREE.Matrix4 {
    const [px, py, pz] = v.spec.pivot;
    _q.setFromEuler(_e.set(0, v.turretRel + extraYaw, 0));
    _t.compose(_v.set(px, py, pz), _q, _s.set(1, 1, 1));
    if (v.recoil > 0) {
      // Kick back along the gun's own axis (turret-local +x), sharp then easing home.
      const te = _t.elements;
      const d = 0.5 * v.recoil * v.recoil;
      te[12] -= te[0] * d;
      te[13] -= te[1] * d;
      te[14] -= te[2] * d;
    }
    return out.multiplyMatrices(body, _t);
  }

  private drawHardware(v: UnitView, u: Unit, draw: boolean): void {
    const spec = v.spec;
    // Crew casualties (guns keep their crew in turret space; losses fall where they stood).
    const alive = spec.crew.length ? Math.min(spec.crew.length, aliveMembers(u.def, u.hp, u.def.maxHp)) : 0;
    if (!draw && spec.crew.length === 0) return;
    const body = this.bodyMatrix(v, _body);
    const turret = spec.turret ? this.turretMatrix(v, body, _turret) : body;
    while (spec.crew.length && v.members > alive && v.members > 0) {
      v.members--;
      const [cx, cz] = crewSlot(u.vseed, v.members, _slot);
      const p = new THREE.Vector3(cx, 0, cz).applyMatrix4(turret);
      p.y = this.world.terrain.heightAt(p.x, p.z) + CORPSE_LIFT;
      this.addCorpse({
        key: 'soldier', m: setYZ(new THREE.Matrix4(), p.x, p.y, p.z, Math.random() * 6, Math.PI / 2, SOLDIER_SCALE),
        color: v.color, wreck: false, maxLife: 25, smoke: false, pos: p,
      });
    }
    if (!draw) return;
    if (spec.body) this.batch(spec.body).push(body, v.color);
    if (spec.turret) this.batch(spec.turret).push(turret, v.color);
    if (!this.showSoldiers) return;
    const kneelCrew = this.batch('soldierKneel');
    const standCrew = this.batch('soldier');
    for (let k = 0; k < v.members && k < spec.crew.length; k++) {
      // Crew slots are fixed per gun (computed once into goal/cacheKneel).
      if (!v.laidOut) {
        for (let c = 0; c < spec.crew.length; c++) {
          crewSlot(u.vseed, c, _slot);
          v.goal[c * 2] = _slot[0];
          v.goal[c * 2 + 1] = _slot[1];
          v.cacheKneel[c] = spec.crew[c][2] !== vhash(u.vseed, c, 24) < 0.3 ? 1 : 0;
          v.offs[c * 2] = (vhash(u.vseed, c, 25) - 0.5) * 0.8;
        }
        v.laidOut = true;
      }
      const te = turret.elements;
      const cx = v.goal[k * 2];
      const cz = v.goal[k * 2 + 1];
      const px = te[0] * cx + te[8] * cz + te[12];
      const pz = te[2] * cx + te[10] * cz + te[14];
      // Crew stand upright and face the gun's line of fire.
      setYZ(_m, px, this.world.terrain.heightAt(px, pz), pz, -v.heading + v.turretRel + v.offs[k * 2], 0, SOLDIER_SCALE);
      (v.cacheKneel[k] ? kneelCrew : standCrew).push(_m, v.color);
    }
  }

  private toWreck(v: UnitView): void {
    const spec = v.spec;
    if (!spec.wreck) {
      // Remaining squad members fall where they stood.
      for (let k = 0; k < v.members; k++) {
        const x = v.x + v.offs[k * 2];
        const z = v.z + v.offs[k * 2 + 1];
        const y = this.world.terrain.heightAt(x, z) + CORPSE_LIFT;
        this.addCorpse({ key: spec.soldier, m: setYZ(new THREE.Matrix4(), x, y, z, Math.random() * 6, Math.PI / 2, SOLDIER_SCALE), color: v.color, wreck: false, maxLife: 25, smoke: false, pos: new THREE.Vector3(x, y, z) });
      }
      return;
    }
    v.y -= 0.2;
    const body = this.bodyMatrix(v, new THREE.Matrix4());
    const life = spec.vehicle ? 75 : 40;
    const pos = new THREE.Vector3(v.x, v.y, v.z);
    if (spec.body) this.addCorpse({ key: spec.body, m: body, color: v.color, wreck: true, maxLife: life, smoke: spec.vehicle, pos });
    if (spec.turret) {
      const t = this.turretMatrix(v, body, new THREE.Matrix4(), spec.vehicle ? (Math.random() - 0.5) * 1.2 : 0);
      this.addCorpse({ key: spec.turret, m: t, color: v.color, wreck: true, maxLife: life, smoke: false, pos });
    }
  }

  sync(alpha: number, dt: number, camera: THREE.OrthographicCamera, playerId: number, fog: boolean): void {
    const w = this.world;
    const frame = ++this.frameNo;
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m);
    for (const b of this.batches.values()) b.begin();
    for (const b of this.wreckBatches.values()) b.begin();
    this.rings.begin();
    const fogOn = fog && w.factions[playerId]?.alive !== false;
    for (const u of w.units.values()) {
      if (u.hp <= 0) continue;
      let v = this.views.get(u.id);
      if (!v) v = this.create(u);
      v.seen = frame;
      v.visible = !(fogOn && u.owner !== playerId && !w.visibleTo[playerId]?.has(u.id));
      v.x = u.prev.x + (u.pos.x - u.prev.x) * alpha;
      v.z = u.prev.z + (u.pos.z - u.prev.z) * alpha;
      v.y = w.terrain.heightAt(v.x, v.z);
      v.heading = u.heading;
      if (v.spec.turret && !u.fixed) v.turretRel = -(u.turret - u.heading);
      _sphere.center.set(v.x, v.y, v.z);
      v.onScreen = this.frustum.intersectsSphere(_sphere);
      const draw = v.visible && v.onScreen;
      if (draw && v.spec.vehicle) {
        // Pitch to the slope along the hull.
        const half = 2.4 * VEHICLE_SCALE;
        const ahead = w.terrain.heightAt(v.x + Math.cos(u.heading) * half, v.z + Math.sin(u.heading) * half);
        const behind = w.terrain.heightAt(v.x - Math.cos(u.heading) * half, v.z - Math.sin(u.heading) * half);
        v.pitch = Math.atan2(ahead - behind, half * 2);
      }
      if (v.recoil > 0) v.recoil = Math.max(0, v.recoil - dt * 2.2);
      if (draw && v.spec.vehicle && u.moving && this.onTrackDust && Math.random() < dt * 3.5) {
        const g = w.terrain.groundAt(v.x, v.z);
        if (g !== Ground.Road && g !== Ground.Water && g !== Ground.Ford) this.onTrackDust(v.x, v.y, v.z, u.heading);
      }
      if (v.spec.body || v.spec.turret) this.drawHardware(v, u, draw);
      else this.drawSquad(v, u, dt, draw && this.showSoldiers);
      if (draw && this.selected.has(u.id)) {
        const r = v.spec.vehicle ? RING_VEHICLE : RING_SQUAD;
        _m.makeScale(r, 1, r).setPosition(v.x, v.y + 0.4, v.z);
        this.rings.push(_m, RING_COLOR);
      }
    }
    for (const [id, v] of this.views) {
      if (v.seen === frame) continue;
      if (v.visible) this.toWreck(v);
      this.views.delete(id);
      this.selected.delete(id);
    }
    this.syncCorpses(dt);
    for (const b of this.batches.values()) b.end();
    for (const b of this.wreckBatches.values()) b.end();
    this.rings.end();
  }

  private syncCorpses(dt: number): void {
    let write = 0;
    for (let i = 0; i < this.corpses.length; i++) {
      const c = this.corpses[i];
      c.life += dt;
      if (c.life > c.maxLife) continue;
      this.corpses[write++] = c;
      if (c.smoke) {
        const k = Math.max(0, 1 - c.life / c.maxLife);
        if (Math.random() < dt * (1 + 4 * k)) this.onWreckFire?.(c.pos.x, c.pos.y + 2.1 * VEHICLE_SCALE, c.pos.z, k);
      }
      if (!c.wreck && !this.showSoldiers) continue;
      _sphere.center.copy(c.pos);
      if (!this.frustum.intersectsSphere(_sphere)) continue;
      this.batch(c.key, c.wreck).push(c.m, c.color);
    }
    this.corpses.length = write;
  }

  /** A big gun fired at (x, z): kick the turret / gun of the nearest armed unit there. */
  recoilAt(x: number, z: number): void {
    let best: UnitView | null = null;
    let bd = 64;
    for (const v of this.views.values()) {
      if (!v.spec.turret || !v.onScreen) continue;
      const d = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best) best.recoil = 1;
  }

  /** Set soldier shadow casting (expensive at far zoom). */
  setSoldierShadows(on: boolean): void {
    for (const [k, b] of this.batches) if (k.startsWith('soldier')) b.mesh.castShadow = on;
  }

  /** Screen-space pick of the nearest unit (ground point or counter point) to an NDC point. */
  pick(ndc: THREE.Vector2, camera: THREE.Camera, maxPx: number, viewport: { w: number; h: number }, filter: (u: Unit) => boolean): Unit | null {
    let best: Unit | null = null;
    let bd = maxPx;
    const v3 = new THREE.Vector3();
    for (const [id, v] of this.views) {
      const u = this.world.units.get(id);
      if (!u || !v.visible || !filter(u)) continue;
      for (const dy of [0, v.spec.top]) {
        v3.set(v.x, v.y + dy, v.z).project(camera);
        const d = Math.hypot(((v3.x - ndc.x) * viewport.w) / 2, ((v3.y - ndc.y) * viewport.h) / 2);
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
    }
    return best;
  }

  /** Units whose ground position projects inside a screen rectangle (NDC). */
  inRect(a: THREE.Vector2, b: THREE.Vector2, camera: THREE.Camera, filter: (u: Unit) => boolean): Unit[] {
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    const out: Unit[] = [];
    const v3 = new THREE.Vector3();
    for (const [id, v] of this.views) {
      const u = this.world.units.get(id);
      if (!u || !filter(u)) continue;
      v3.set(v.x, v.y, v.z).project(camera);
      if (v3.x >= x0 && v3.x <= x1 && v3.y >= y0 && v3.y <= y1) out.push(u);
    }
    return out;
  }
}
