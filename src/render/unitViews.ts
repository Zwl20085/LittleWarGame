import * as THREE from 'three';
import { aliveMembers } from '../sim/formulas';
import { Ground } from '../sim/terrain';
import type { Unit } from '../sim/types';
import type { World } from '../sim/world';
import { ContactShadows } from './contactShadows';
import { groundNormal, setYZ, writeTilted, writeYZcs } from './unitMatrices';
import { InstanceBatch, soldierMaterial, tintedMaterial } from './instancing';
import { PAL } from './palette';
import { choosePattern, crewSlot, slot, vhash, type Situation } from './formations';
import { modelSpec, SOLDIER_SCALE, TRUCK_FOOT, unitGeometry, VEHICLE_SCALE, type ModelSpec } from './unitModels';
import { SC, snapSoldier, SOL_STRIDE, sortSlots, SS, step, stepSoldier, STRIDE_AMP, SV, SX, SZ, Trail, walkCap, wrapAngle } from './soldierMotion';

/** Per-unit render state (no Three.js objects — everything is drawn through shared batches). */
export interface UnitView {
  readonly id: number;
  readonly spec: ModelSpec;
  readonly color: THREE.Color;
  members: number;
  x: number;
  y: number;
  z: number;
  /** Rendered hull/squad heading, interpolated from hFrom to the latest sim heading. */
  heading: number;
  hFrom: number;
  /** Rendered turret world yaw and where its interpolation started. */
  turretYaw: number;
  tFrom: number;
  /** Sim tick of the last heading sample (a new tick restarts the interpolation). */
  tick: number;
  turretRel: number;
  /** Rendered hull pitch (nose up) and roll (right side up), eased toward the ground's. */
  pitch: number;
  roll: number;
  /** Tilt has been initialised (first sighting snaps instead of easing). */
  tilted: boolean;
  /** Gun recoil 0..1 (kicked by a big muzzle flash, springs back). */
  recoil: number;
  /** Not hidden by fog this frame. */
  visible: boolean;
  /** Inside the camera frustum this frame. */
  onScreen: boolean;
  seen: number;
  /** Crew: personal yaw jitter (x of each pair). */
  readonly offs: Float32Array;
  laidOut: boolean;
  /** Squad: local formation slots (forward, right); crew: turret-space slots. */
  readonly goal: Float32Array;
  /** Per-soldier locomotion state (soldierMotion SOL_STRIDE floats each). */
  readonly sol: Float32Array;
  /** Squad slots ordered front to back (one pass along the trail). */
  readonly order: Uint8Array;
  /** Squad marching path (slots behind the leader follow it). */
  readonly trail: Trail | null;
  /** Soldiers were drawn last frame (otherwise they snap to their slots on sight). */
  drawn: boolean;
  /** Seconds since the squad last moved (debounces one-tick stops at waypoints). */
  still: number;
  /** Smoothed squad ground speed (m/s). */
  spd: number;
  pattern: string;
  patternN: number;
  patternFace: number;
  settled: boolean;
  /** Cached soldier matrices for static squads (and their ground heights, for the blobs). */
  readonly cache: Float32Array;
  readonly cacheGround: Float32Array;
  readonly cacheKneel: Uint8Array;
  cacheN: number;
  cacheSit: string;
  cacheX: number;
  cacheZ: number;
  cacheFace: number;
  /** Motorized infantry riding its trucks (drawn as a two-truck column). */
  mounted: boolean;
  /** Trailing truck of the column: x, z, heading (allocated on first mount). */
  convoy: Float32Array | null;
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
/** Scratch: the ground normal under the unit being drawn. */
const _n = new Float32Array(3);
/** Contact blob half-size of one soldier (m) and how far apart the slope samples are. */
const BLOB_SOLDIER = 0.42 * SOLDIER_SCALE;
const NORMAL_STEP = 2;
/** Tilt easing rate (1/s): smooths the facet-to-facet steps of the triangulated ground. */
const TILT_RATE = 9;
// Generous enough for an opened-up squad (SQUAD_SPREAD) or a big vehicle.
const _sphere = new THREE.Sphere(new THREE.Vector3(), 30);
/** A fallen soldier lies on its side: lift by half its (scaled) body width. */
const CORPSE_LIFT = 0.15 * SOLDIER_SCALE;
/** Selection-ring radius (m) around vehicles / squads and guns (matches the scaled models). */
const RING_VEHICLE = 8.5;
const RING_SQUAD = 14;
const RING_COLOR = new THREE.Color('#f4ecd9');
/** Motorized column: lead truck ahead of the unit centre, second truck trailing at GAP. */
const CONVOY_LEAD = 6;
const CONVOY_GAP = 12.5;
/** Scratch result of restOn: [y, pitch, roll]. */
const _rest = new Float32Array(3);
/** `?perf`: log the average unit-view update cost (ms) every PERF_WINDOW frames. */
const PERF = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');
const PERF_WINDOW = 300;
let perfAcc = 0;
let perfFrames = 0;

/** Interpolate angle a → b by t along the short way. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** Crew-served guns are manhandled: rendered traverse is capped (rad/s). */
const GUN_TRAVERSE = 100 * (Math.PI / 180);
/** A squad counts as halted only after this long without moving (s). */
const HALT_AFTER = 0.4;
/** A squad halted this long starts a fresh marching trail when it moves off (s). */
const TRAIL_RESTART = 1.5;
/** Smoothed speed (m/s) above which a soldier is drawn walking rather than standing/kneeling. */
const WALKING = 0.3;
/** Scratch: per-soldier slot targets (x, z pairs; squads of up to 128). */
const _tgt = new Float32Array(256);

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
  private readonly soldierMaterial = soldierMaterial(0.9, 0.06);
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
  /** Contact shadows under units (off at far zoom where they are sub-pixel). */
  showBlobs = true;
  private readonly blobs: ContactShadows;
  /** Height of the rendered ground (units stand on the visible surface, not the sim grid). */
  private readonly ground: (x: number, z: number) => number;

  constructor(private readonly world: World, ground?: (x: number, z: number) => number) {
    this.ground = ground ?? ((x, z) => world.terrain.heightAt(x, z));
    this.blobs = new ContactShadows(this.group);
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
      const mat = wreck ? this.wreckMaterial : soldier ? this.soldierMaterial : this.material;
      b = new InstanceBatch(this.group, unitGeometry(key), mat, soldier ? 512 : 64, true, soldier && !wreck);
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
    const spec = modelSpec(u.def.id, u.fixed);
    const n = Math.max(1, u.def.memberCount);
    const v: UnitView = {
      id: u.id, spec, color: this.factionColor(u.owner),
      members: u.def.kind === 'vehicle' ? 0 : u.def.memberCount,
      x: u.pos.x, y: u.y, z: u.pos.z, heading: u.heading, hFrom: u.heading, turretYaw: u.turret, tFrom: u.turret, tick: -1,
      turretRel: 0, pitch: 0, roll: 0, tilted: false, recoil: 0, visible: true, onScreen: true, seen: 0,
      offs: new Float32Array(n * 2), laidOut: false,
      goal: new Float32Array(n * 2), sol: new Float32Array(n * SOL_STRIDE), order: new Uint8Array(n),
      trail: spec.body || spec.turret ? null : new Trail(), drawn: false, still: 0, spd: 0,
      pattern: '', patternN: -1, patternFace: 0, settled: false,
      cache: new Float32Array(Math.max(1, u.def.memberCount) * 16), cacheGround: new Float32Array(Math.max(1, u.def.memberCount)), cacheKneel: new Uint8Array(Math.max(1, u.def.memberCount)),
      cacheN: -1, cacheSit: '', cacheX: 0, cacheZ: 0, cacheFace: 0, mounted: false, convoy: null,
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
   * advancing, skirmish line facing the enemy when engaged) with stable personal jitter. Each
   * soldier walks to his own slot (soldierMotion): on the march, slots behind the leader follow
   * the leader's path, so the squad wheels through turns instead of spinning rigidly.
   */
  private drawSquad(v: UnitView, u: Unit, dt: number, draw: boolean): void {
    const w = this.world;
    const alive = aliveMembers(u.def, u.hp, u.def.maxHp);
    const sol = v.sol;
    while (v.members > alive && v.members > 0) {
      v.members--;
      const o = v.members * SOL_STRIDE;
      const wx = v.drawn ? sol[o + SX] : v.x;
      const wz = v.drawn ? sol[o + SZ] : v.z;
      const y = this.ground(wx, wz) + CORPSE_LIFT;
      this.addCorpse({
        key: v.spec.soldier, m: setYZ(new THREE.Matrix4(), wx, y, wz, Math.random() * 6, Math.PI / 2, SOLDIER_SCALE),
        color: v.color, wreck: false, maxLife: 25, smoke: false, pos: new THREE.Vector3(wx, y, wz),
      });
    }
    // The sim reports a single still tick at every waypoint: only a sustained stop is a halt.
    const wasStill = v.still;
    v.still = u.moving ? 0 : v.still + dt;
    const moving = v.still < HALT_AFTER;
    v.spd += (u.speedNow - v.spd) * Math.min(1, dt * 3);
    // Unseen squads cost nothing more; soldiers snap into place when they come into view.
    if (!draw) {
      v.drawn = false;
      return;
    }
    const trail = v.trail!;
    if (!v.drawn || (u.moving && wasStill > TRAIL_RESTART)) trail.reset(v.x, v.z);
    else if (u.moving) trail.push(v.x, v.z);
    const target = u.targetId !== null ? w.unitAlive(u.targetId) : null;
    const sit: Situation = u.moraleState === 'pinned' ? 'pinned'
      : (target && !moving) || u.moraleState === 'suppressed' ? 'engaged'
        : moving ? (w.terrain.groundAt(v.x, v.z) === Ground.Road ? 'road' : 'moving') : 'idle';
    const face = target && (sit === 'engaged' || sit === 'pinned') ? Math.atan2(target.pos.z - v.z, target.pos.x - v.x) : v.heading;
    // Halted squads re-face only on a real change (keeps the static matrix cache valid).
    if (moving || !v.drawn || Math.abs(wrapAngle(face - v.patternFace)) > 0.04) v.patternFace = face;
    const pattern = choosePattern(u.vseed, sit);
    const n = v.members;
    if (pattern !== v.pattern || n !== v.patternN) {
      v.pattern = pattern;
      v.patternN = n;
      v.settled = false;
      for (let k = 0; k < n; k++) {
        slot(pattern, k, n, u.vseed, _slot);
        v.goal[k * 2] = _slot[0];
        v.goal[k * 2 + 1] = _slot[1];
        // Per-soldier constants: facing jitter and pose roll.
        v.offs[k * 2] = vhash(u.vseed, k, 32) - 0.5;
        v.offs[k * 2 + 1] = vhash(u.vseed, k, 31);
      }
      sortSlots(v.goal, n, v.order);
    }
    const restFace = v.patternFace;
    const standB = this.batch(v.spec.soldier);
    const kneelB = this.batch('soldierKneel');
    // Member 0 is the squad leader, member 1 the LMG gunner (casualties come off the end).
    const leadB = v.spec.leader ? this.batch(v.spec.leader) : standB;
    const gunB = v.spec.gunner ? this.batch(v.spec.gunner) : standB;
    const standFor = (k: number): InstanceBatch => (k === 0 ? leadB : k === 1 ? gunB : standB);
    // Static squads (everyone in place, nothing changed) reuse last frame's matrices.
    const blobs = this.showBlobs;
    if (blobs) groundNormal(this.ground, v.x, v.z, NORMAL_STEP, _n);
    if (v.settled && v.drawn && !moving && v.cacheN === n && v.cacheSit === sit && v.cacheX === v.x && v.cacheZ === v.z && v.cacheFace === restFace) {
      for (let k = 0; k < n; k++) {
        (v.cacheKneel[k] ? kneelB : standFor(k)).pushArray(v.cache, k * 16, v.color);
        if (blobs) this.soldierBlob(v.cache[k * 16 + 12], v.cacheGround[k], v.cache[k * 16 + 14], v.cache[k * 16], v.cache[k * 16 + 2]);
      }
      return;
    }
    const snap = !v.drawn;
    v.drawn = true;
    const jitterAmp = sit === 'engaged' || sit === 'pinned' ? 0.35 : moving ? 0.2 : 0.9;
    const ca = Math.cos(moving ? v.heading : restFace);
    const sa = Math.sin(moving ? v.heading : restFace);
    const cap = walkCap(v.spd);
    let settled = !moving;
    if (moving) trail.placeAll(v.x, v.z, ca, sa, v.goal, v.order, n, _tgt);
    else {
      for (let k = 0; k < n; k++) {
        const fwd = v.goal[k * 2];
        const right = v.goal[k * 2 + 1];
        _tgt[k * 2] = v.x + ca * fwd - sa * right;
        _tgt[k * 2 + 1] = v.z + sa * fwd + ca * right;
      }
    }
    for (let k = 0; k < n; k++) {
      const tx = _tgt[k * 2];
      const tz = _tgt[k * 2 + 1];
      const rest = restFace - v.offs[k * 2] * jitterAmp;
      if (snap) snapSoldier(sol, k, tx, tz, rest);
      stepSoldier(sol, k, tx, tz, rest, cap, dt);
      const stride = step.stride;
      if (!step.settled) settled = false;
      const o = k * SOL_STRIDE;
      const sx = sol[o + SX];
      const sz = sol[o + SZ];
      const sv = sol[o + SV];
      const r = v.offs[k * 2 + 1];
      let kneel = false;
      let tilt = 0;
      let lift = 0;
      if (sv > WALKING) {
        // Walking: lean into the stride, rise as the legs pass.
        const amp = Math.min(1, sv / 1.2);
        tilt = -0.12 * amp;
        lift = (amp * STRIDE_AMP - Math.abs(stride)) * 0.12 * SOLDIER_SCALE;
      } else if (sit === 'pinned' || (sit === 'engaged' && r > 0.6 && r < 0.85)) {
        tilt = -1.25;
        lift = 0.2 * SOLDIER_SCALE;
      } else if ((sit === 'engaged' && r <= 0.6) || (sit === 'idle' && r < 0.3)) kneel = true;
      if (kneel && k === 1 && v.spec.gunner) {
        // The LMG gunner goes prone behind his gun instead of kneeling.
        kneel = false;
        tilt = -1.25;
        lift = 0.2 * SOLDIER_SCALE;
      }
      const gy = this.ground(sx, sz);
      const y = gy + lift;
      v.cacheKneel[k] = kneel ? 1 : 0;
      v.cacheGround[k] = gy;
      if (blobs) this.soldierBlob(sx, gy, sz, sol[o + SC], sol[o + SS], tilt < -1);
      if (moving) {
        // Marching squads never use the cache: write straight into the batch.
        const b = kneel ? kneelB : standFor(k);
        const at = b.next(v.color, kneel ? 0 : stride); // may grow the batch: read matrices after
        writeYZcs(b.matrices, at, sx, y, sz, sol[o + SC], -sol[o + SS], tilt, SOLDIER_SCALE);
      } else {
        writeYZcs(v.cache, k * 16, sx, y, sz, sol[o + SC], -sol[o + SS], tilt, SOLDIER_SCALE);
        (kneel ? kneelB : standFor(k)).pushArray(v.cache, k * 16, v.color, kneel ? 0 : stride);
      }
    }
    v.settled = settled;
    v.cacheN = n;
    v.cacheSit = sit;
    v.cacheX = v.x;
    v.cacheZ = v.z;
    v.cacheFace = restFace;
  }

  /**
   * Rest a rigid body of half-extents (a along, b across, metres) on the rendered ground: four
   * samples give pitch and roll; the centre sits on the higher of the centre sample and the
   * mean of the four (so a hull bridges a dip and rides over a crest without sinking).
   * Results in _rest = [y, pitch, roll].
   */
  private restOn(x: number, z: number, heading: number, a: number, b: number): Float32Array {
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    const g = this.ground;
    const hA = g(x + ch * a, z + sh * a);
    const hB = g(x - ch * a, z - sh * a);
    const hR = g(x - sh * b, z + ch * b);
    const hL = g(x + sh * b, z - ch * b);
    const hC = g(x, z);
    _rest[0] = Math.max(hC, (hA + hB + hR + hL) * 0.25);
    _rest[1] = Math.atan2(hA - hB, 2 * a);
    _rest[2] = Math.atan2(hR - hL, 2 * b);
    return _rest;
  }

  /** A truck resting on the ground at (x, z), pitched and rolled to the slope. */
  private truckMatrix(x: number, z: number, heading: number, out: THREE.Matrix4): THREE.Matrix4 {
    const r = this.restOn(x, z, heading, TRUCK_FOOT[0] * VEHICLE_SCALE, TRUCK_FOOT[1] * VEHICLE_SCALE);
    writeTilted(out.elements, 0, x, r[0], z, heading, r[1], r[2], VEHICLE_SCALE);
    if (this.showBlobs) this.hullBlob(x, r[0], z, heading, TRUCK_FOOT[0] * VEHICLE_SCALE, TRUCK_FOOT[1] * VEHICLE_SCALE);
    return out;
  }

  /** Contact blob under one soldier (prone figures get a longer one). */
  private soldierBlob(x: number, y: number, z: number, fc: number, fs: number, prone = false): void {
    this.blobs.push(x, y, z, _n[0], _n[1], _n[2], fc, fs, prone ? BLOB_SOLDIER * 2.1 : BLOB_SOLDIER, BLOB_SOLDIER);
  }

  /** Contact blob under a hull / gun of half-extents (a, b) metres, along the ground normal. */
  private hullBlob(x: number, y: number, z: number, heading: number, a: number, b: number): void {
    groundNormal(this.ground, x, z, Math.max(NORMAL_STEP, b), _n);
    this.blobs.push(x, y, z, _n[0], _n[1], _n[2], Math.cos(heading), Math.sin(heading), a * 1.12 + 0.6, b * 1.15 + 0.6);
  }

  /**
   * Mounted motorized infantry: two troop trucks in column. The lead truck rides just ahead of
   * the unit centre; the second follows it on a distance constraint, so it trails through turns.
   */
  private drawConvoy(v: UnitView, u: Unit, dt: number, draw: boolean): void {
    v.members = Math.min(v.members, aliveMembers(u.def, u.hp, u.def.maxHp));
    const ch = Math.cos(v.heading);
    const sh = Math.sin(v.heading);
    const lx = v.x + ch * CONVOY_LEAD;
    const lz = v.z + sh * CONVOY_LEAD;
    const c = v.convoy ?? (v.convoy = new Float32Array(3));
    const dx = lx - c[0];
    const dz = lz - c[1];
    const d = Math.hypot(dx, dz);
    if (!v.mounted || d > CONVOY_GAP * 2.5) {
      c[0] = lx - ch * CONVOY_GAP;
      c[1] = lz - sh * CONVOY_GAP;
      c[2] = v.heading;
      v.mounted = true;
    } else if (d > CONVOY_GAP) {
      c[0] = lx - (dx / d) * CONVOY_GAP;
      c[1] = lz - (dz / d) * CONVOY_GAP;
      c[2] = Math.atan2(dz, dx);
    }
    if (!draw) return;
    const b = this.batch('troopTruck');
    b.push(this.truckMatrix(lx, lz, v.heading, _m), v.color);
    b.push(this.truckMatrix(c[0], c[1], c[2], _m), v.color);
    if (u.moving && this.onTrackDust && Math.random() < dt * 3.5) {
      const g = this.world.terrain.groundAt(lx, lz);
      if (g !== Ground.Road && g !== Ground.Water && g !== Ground.Ford) this.onTrackDust(lx, v.y, lz, v.heading);
    }
  }

  /** Troops jump down from the trucks: start every soldier at its truck, then ease out. */
  private dismount(v: UnitView): void {
    v.mounted = false;
    const c = v.convoy;
    if (!c) return;
    const lx = Math.cos(v.heading) * CONVOY_LEAD;
    const lz = Math.sin(v.heading) * CONVOY_LEAD;
    const half = Math.ceil(v.members / 2);
    for (let k = 0; k < v.members; k++) {
      const jx = (vhash(v.id, k, 61) - 0.5) * 4;
      const jz = (vhash(v.id, k, 62) - 0.5) * 4;
      snapSoldier(v.sol, k, (k < half ? v.x + lx : c[0]) + jx, (k < half ? v.z + lz : c[1]) + jz, v.heading);
    }
    v.trail?.reset(v.x, v.z);
    v.drawn = true;
    v.laidOut = true;
    v.settled = false;
    v.pattern = '';
    v.cacheN = -1;
  }

  /** Body / turret / crew matrices for a unit with a hull or a gun. */
  private bodyMatrix(v: UnitView, out: THREE.Matrix4): THREE.Matrix4 {
    writeTilted(out.elements, 0, v.x, v.y, v.z, v.heading, v.pitch, v.roll, v.spec.scale);
    return out;
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

  private drawHardware(v: UnitView, u: Unit, dt: number, draw: boolean): void {
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
      p.y = this.ground(p.x, p.z) + CORPSE_LIFT;
      this.addCorpse({
        key: 'soldier', m: setYZ(new THREE.Matrix4(), p.x, p.y, p.z, Math.random() * 6, Math.PI / 2, SOLDIER_SCALE),
        color: v.color, wreck: false, maxLife: 25, smoke: false, pos: p,
      });
    }
    if (!draw || !this.showSoldiers) v.drawn = false;
    if (!draw) return;
    if (spec.body) this.batch(spec.body).push(body, v.color);
    if (spec.turret) this.batch(spec.turret).push(turret, v.color);
    if (!this.showSoldiers || spec.crew.length === 0) return;
    const kneelCrew = this.batch('soldierKneel');
    const standCrew = this.batch('soldier');
    const snap = !v.drawn;
    v.drawn = true;
    v.spd += (u.speedNow - v.spd) * Math.min(1, dt * 3);
    const cap = walkCap(v.spd);
    const sol = v.sol;
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
      // Slot in turret space around the gun's (unrecoiled) pivot at the unit origin, so the
      // crew walk around with the gun as it traverses instead of being carried rigidly.
      const te = turret.elements;
      const cx = v.goal[k * 2];
      const cz = v.goal[k * 2 + 1];
      const px = te[0] * cx + te[8] * cz + v.x;
      const pz = te[2] * cx + te[10] * cz + v.z;
      // At their posts the crew face the gun's line of fire.
      const rest = v.turretYaw - v.offs[k * 2];
      if (snap) snapSoldier(sol, k, px, pz, rest);
      stepSoldier(sol, k, px, pz, rest, cap, dt);
      const o = k * SOL_STRIDE;
      const sx = sol[o + SX];
      const sz = sol[o + SZ];
      const kneel = v.cacheKneel[k] === 1 && sol[o + SV] <= WALKING;
      const b = kneel ? kneelCrew : standCrew;
      const at = b.next(v.color, kneel ? 0 : step.stride);
      const gy = this.ground(sx, sz);
      writeYZcs(b.matrices, at, sx, gy, sz, sol[o + SC], -sol[o + SS], 0, SOLDIER_SCALE);
      if (this.showBlobs) this.soldierBlob(sx, gy, sz, sol[o + SC], sol[o + SS]);
    }
  }

  private toWreck(v: UnitView): void {
    const spec = v.spec;
    if (!v.onScreen) v.y = this.ground(v.x, v.z);
    if (v.mounted && v.convoy) {
      // Shot up on the road: both trucks burn out.
      const c = v.convoy;
      const lx = v.x + Math.cos(v.heading) * CONVOY_LEAD;
      const lz = v.z + Math.sin(v.heading) * CONVOY_LEAD;
      for (const [x, z, h] of [[lx, lz, v.heading], [c[0], c[1], c[2]]]) {
        const m = this.truckMatrix(x, z, h, new THREE.Matrix4());
        m.elements[13] -= 0.2;
        this.addCorpse({ key: 'troopTruck', m, color: v.color, wreck: true, maxLife: 60, smoke: true, pos: new THREE.Vector3(x, m.elements[13], z) });
      }
      return;
    }
    if (!spec.wreck) {
      // Remaining squad members fall where they stood.
      for (let k = 0; k < v.members; k++) {
        const x = v.drawn ? v.sol[k * SOL_STRIDE + SX] : v.x;
        const z = v.drawn ? v.sol[k * SOL_STRIDE + SZ] : v.z;
        const y = this.ground(x, z) + CORPSE_LIFT;
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

  /**
   * Hull/squad heading and turret yaw interpolated across the sim tick (the sim turns in
   * 20 Hz steps, up to 18° per tick for infantry). Crew-served guns are manhandled: their
   * rendered traverse is additionally rate-capped.
   */
  private interpolateFacing(v: UnitView, u: Unit, alpha: number, dt: number, tick: number): void {
    if (v.tick !== tick) {
      v.tick = tick;
      v.hFrom = v.heading;
      v.tFrom = v.turretYaw;
    }
    const turret = v.spec.turret !== null;
    // Fast path: nothing is turning (most units, most frames).
    if (v.heading === u.heading && v.hFrom === u.heading && (!turret || (v.turretYaw === u.turret && v.tFrom === u.turret))) return;
    let h = lerpAngle(v.hFrom, u.heading, alpha);
    let ty = turret ? lerpAngle(v.tFrom, u.turret, alpha) : u.turret;
    if (v.spec.crew.length) {
      const lim = GUN_TRAVERSE * dt;
      const dh = wrapAngle(h - v.heading);
      const dtur = wrapAngle(ty - v.turretYaw);
      h = v.heading + (dh > lim ? lim : dh < -lim ? -lim : dh);
      ty = v.turretYaw + (dtur > lim ? lim : dtur < -lim ? -lim : dtur);
    }
    v.heading = h;
    v.turretYaw = ty;
    if (v.spec.turret && !u.fixed) v.turretRel = -(ty - h);
  }

  sync(alpha: number, dt: number, camera: THREE.OrthographicCamera, playerId: number, fog: boolean): void {
    if (!PERF) {
      this.syncAll(alpha, dt, camera, playerId, fog);
      return;
    }
    const t0 = performance.now();
    this.syncAll(alpha, dt, camera, playerId, fog);
    perfAcc += performance.now() - t0;
    if (++perfFrames === PERF_WINDOW) {
      const avg = perfAcc / PERF_WINDOW;
      console.log(`[perf] unitViews.sync avg ${avg.toFixed(3)} ms over ${PERF_WINDOW} frames (${this.views.size} units)`);
      (globalThis as { __unitPerf?: number[] }).__unitPerf?.push(avg);
      perfAcc = 0;
      perfFrames = 0;
    }
  }

  private syncAll(alpha: number, dt: number, camera: THREE.OrthographicCamera, playerId: number, fog: boolean): void {
    const w = this.world;
    const frame = ++this.frameNo;
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(_m);
    for (const b of this.batches.values()) b.begin();
    for (const b of this.wreckBatches.values()) b.begin();
    this.rings.begin();
    this.blobs.begin();
    this.blobs.visible = this.showBlobs;
    const fogOn = fog && w.factions[playerId]?.alive !== false;
    for (const u of w.units.values()) {
      if (u.hp <= 0) continue;
      let v = this.views.get(u.id);
      if (!v) v = this.create(u);
      v.seen = frame;
      v.visible = !(fogOn && u.owner !== playerId && !w.visibleTo[playerId]?.has(u.id));
      v.x = u.prev.x + (u.pos.x - u.prev.x) * alpha;
      v.z = u.prev.z + (u.pos.z - u.prev.z) * alpha;
      this.interpolateFacing(v, u, alpha, dt, w.tick);
      // Cull with last frame's height (the sphere is generous); ground only what is on screen.
      _sphere.center.set(v.x, v.y, v.z);
      v.onScreen = this.frustum.intersectsSphere(_sphere);
      const draw = v.visible && v.onScreen;
      if (draw && v.spec.tilt) {
        // Hulls and gun carriages rest on the ground: pitch and roll to the local slope.
        const sc = v.spec.scale;
        const r = this.restOn(v.x, v.z, v.heading, v.spec.foot[0] * sc, v.spec.foot[1] * sc);
        v.y = r[0];
        const k = v.tilted ? Math.min(1, dt * TILT_RATE) : 1;
        v.pitch += (r[1] - v.pitch) * k;
        v.roll += (r[2] - v.roll) * k;
        v.tilted = true;
        if (this.showBlobs) this.hullBlob(v.x, v.y, v.z, v.heading, v.spec.foot[0] * sc, v.spec.foot[1] * sc);
      } else if (v.onScreen) {
        v.y = this.ground(v.x, v.z);
        if (draw && this.showBlobs && v.spec.foot[0] > 0) this.hullBlob(v.x, v.y, v.z, v.heading, v.spec.foot[0] * v.spec.scale, v.spec.foot[1] * v.spec.scale);
      } else v.tilted = false;
      if (v.recoil > 0) v.recoil = Math.max(0, v.recoil - dt * 2.2);
      if (draw && v.spec.vehicle && u.moving && this.onTrackDust && Math.random() < dt * 3.5) {
        const g = w.terrain.groundAt(v.x, v.z);
        if (g !== Ground.Road && g !== Ground.Water && g !== Ground.Ford) this.onTrackDust(v.x, v.y, v.z, u.heading);
      }
      if (v.spec.body || v.spec.turret) this.drawHardware(v, u, dt, draw);
      else if (u.mounted) this.drawConvoy(v, u, dt, draw);
      else {
        if (v.mounted) this.dismount(v);
        this.drawSquad(v, u, dt, draw && this.showSoldiers);
      }
      if (draw && this.selected.has(u.id)) {
        const r = v.spec.vehicle ? RING_VEHICLE : RING_SQUAD;
        _m.makeScale(r, 1, r).setPosition(v.x, v.y + 0.4, v.z);
        this.rings.push(_m, RING_COLOR);
      }
    }
    for (const v of this.views.values()) {
      if (v.seen === frame) continue;
      if (v.visible) this.toWreck(v);
      this.views.delete(v.id);
      this.selected.delete(v.id);
    }
    this.syncCorpses(dt);
    for (const b of this.batches.values()) b.end();
    for (const b of this.wreckBatches.values()) b.end();
    this.rings.end();
    this.blobs.end();
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
