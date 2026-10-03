import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Faction, Objective } from '../sim/types';
import { WIND } from './effects';
import { FLAG_TIME } from './flags';

/**
 * Settlement markers (pole, cloth flag, owner ring, capture-progress arc) for every objective,
 * drawn as four instanced meshes instead of four meshes per settlement: on a 150-settlement map
 * that is 4 scene objects and 2 shadow casters instead of ~600 and ~300, and the per-frame sync
 * uploads instance colours only when an owner, contest state or capture progress changed.
 */
export class ObjectiveMarkers {
  readonly group = new THREE.Group();
  private readonly poles: THREE.InstancedMesh;
  private readonly flags: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly arcs: THREE.InstancedMesh;
  private readonly arcFrac: THREE.InstancedBufferAttribute;
  private readonly index = new Map<string, number>();
  /** Last synced state per objective (owner, contested, progress leader, progress fraction). */
  private readonly lastOwner: Int16Array;
  private readonly lastContested: Uint8Array;
  private readonly lastLeader: Int16Array;
  private readonly lastFrac: Float32Array;
  private readonly color = new THREE.Color();
  private readonly neutral = new THREE.Color('#d8cfb8');
  private readonly contestedColor = new THREE.Color('#e0b050');

  constructor(objectives: readonly Objective[], terrain: Terrain) {
    const n = objectives.length;
    const m = new THREE.Matrix4();
    const windYaw = -Math.atan2(WIND.z, WIND.x);
    const poleGeo = new THREE.CylinderGeometry(0.25, 0.25, 14, 6);
    this.poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: '#4a4236' }), n);
    this.poles.castShadow = true;
    this.flags = new THREE.InstancedMesh(flagGeometry(), clothMaterial(), n);
    this.flags.castShadow = true;
    const ringGeo = new THREE.RingGeometry(28.5, 30, 48).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.65, depthWrite: false }), n);
    this.rings.renderOrder = 2;
    const arcGeo = new THREE.RingGeometry(26, 28.4, 48, 1, Math.PI / 2, -Math.PI * 2).rotateX(-Math.PI / 2);
    this.arcFrac = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.arcFrac.setUsage(THREE.DynamicDrawUsage);
    arcGeo.setAttribute('aFrac', this.arcFrac);
    this.arcs = new THREE.InstancedMesh(arcGeo, arcMaterial(), n);
    this.arcs.renderOrder = 3;
    this.lastOwner = new Int16Array(n).fill(-9);
    this.lastContested = new Uint8Array(n).fill(9);
    this.lastLeader = new Int16Array(n).fill(-9);
    this.lastFrac = new Float32Array(n).fill(-1);
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    objectives.forEach((o, i) => {
      this.index.set(o.id, i);
      const y = terrain.heightAt(o.pos.x, o.pos.z);
      q.identity();
      this.poles.setMatrixAt(i, m.compose(p.set(o.pos.x, y + 7, o.pos.z), q, one));
      q.setFromAxisAngle(UP, windYaw);
      this.flags.setMatrixAt(i, m.compose(p.set(o.pos.x, y + 12, o.pos.z), q, one));
      q.identity();
      this.rings.setMatrixAt(i, m.compose(p.set(o.pos.x, y + 1.2, o.pos.z), q, one));
      this.arcs.setMatrixAt(i, m);
      this.flags.setColorAt(i, this.neutral);
      this.rings.setColorAt(i, this.neutral);
      this.arcs.setColorAt(i, this.neutral);
    });
    for (const im of [this.poles, this.flags, this.rings, this.arcs]) {
      im.computeBoundingSphere();
      im.frustumCulled = false; // one object spanning the whole map: culling it as a whole never helps
      im.matrixAutoUpdate = false;
      this.group.add(im);
    }
    this.group.matrixAutoUpdate = false;
  }

  /** Reflect owners, contests and capture progress; uploads only what changed. */
  sync(objectives: readonly Objective[], factions: readonly Faction[], captureSecondsOf: (o: Objective) => number): void {
    let colorsDirty = false;
    let arcsDirty = false;
    let fracDirty = false;
    for (const o of objectives) {
      const i = this.index.get(o.id);
      if (i === undefined) continue;
      const contested = o.contested ? 1 : 0;
      if (o.owner !== this.lastOwner[i] || contested !== this.lastContested[i]) {
        this.lastOwner[i] = o.owner;
        this.lastContested[i] = contested;
        const own = o.owner >= 0 ? this.color.set(factions[o.owner].color) : this.neutral;
        this.flags.setColorAt(i, own);
        this.rings.setColorAt(i, o.contested ? this.contestedColor : own);
        colorsDirty = true;
      }
      let leader = -1;
      let best = 0;
      for (const k in o.progress) {
        const v = o.progress[k as unknown as number];
        if (v > best) { best = v; leader = Number(k); }
      }
      const frac = leader >= 0 ? Math.min(1, best / captureSecondsOf(o)) : 0;
      if (frac !== this.lastFrac[i]) {
        this.lastFrac[i] = frac;
        this.arcFrac.setX(i, frac);
        fracDirty = true;
      }
      if (leader !== this.lastLeader[i]) {
        this.lastLeader[i] = leader;
        if (leader >= 0) this.arcs.setColorAt(i, this.color.set(factions[leader].color));
        arcsDirty = true;
      }
    }
    if (colorsDirty) {
      this.flags.instanceColor!.needsUpdate = true;
      this.rings.instanceColor!.needsUpdate = true;
    }
    if (arcsDirty) this.arcs.instanceColor!.needsUpdate = true;
    if (fracDirty) this.arcFrac.needsUpdate = true;
  }

  dispose(): void {
    for (const im of [this.poles, this.flags, this.rings, this.arcs]) {
      im.geometry.dispose();
      (im.material as THREE.Material).dispose();
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const FLAG_W = 6;
const FLAG_H = 3.6;

function flagGeometry(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(FLAG_W, FLAG_H, 12, 2).translate(FLAG_W / 2, 0, 0);
}

/** Same travelling-wave cloth as flags.ts, phased by the instance position (instanced variant). */
function clothMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 1 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlagTime = FLAG_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlagTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float fly = clamp(position.x / ${FLAG_W.toFixed(1)}, 0.0, 1.0);
        float ph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.07;
        transformed.z += sin(position.x * 1.15 - uFlagTime * 5.5 + ph) * 0.42 * fly
          + sin(position.x * 2.3 + position.y * 0.8 - uFlagTime * 8.0 + ph) * 0.12 * fly;
        transformed.y -= fly * fly * 0.35;`,
      );
  };
  mat.customProgramCacheKey = () => 'cloth-flag-instanced';
  return mat;
}

/** Capture arc: a full ring whose visible angular span is the per-instance fraction `aFrac`. */
function arcMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFrac;\nvarying float vFrac;\nvarying vec2 vArc;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFrac = aFrac;\nvArc = vec2(position.x, position.z);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFrac;\nvarying vec2 vArc;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // Angle measured clockwise from "north" (−z), matching the ring's start angle of π/2.
        float ang = atan(vArc.x, -vArc.y);
        if (ang < 0.0) ang += 6.2831853;
        if (vFrac <= 0.0 || ang > vFrac * 6.2831853) discard;`,
      );
  };
  mat.customProgramCacheKey = () => 'capture-arc';
  return mat;
}
