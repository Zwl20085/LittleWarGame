import * as THREE from 'three';

/**
 * Instancing helpers: merged vertex-coloured geometry with a per-vertex `tint` weight, a
 * material that adds `tint × instanceColor` (faction colour) to the vertex colour, and a
 * growable InstancedMesh batch that is refilled every frame.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a TRS matrix (Euler XYZ in radians). */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, out = new THREE.Matrix4()): THREE.Matrix4 {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return out.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Accumulates transformed primitive parts into one non-indexed geometry. */
export class GeoBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly tint: number[] = [];

  /**
   * Add a part. Final colour = `color` + `tint` × instanceColor, so a faction-painted part
   * is `base × (1 - k)` with tint `k` (a linear lerp toward the faction colour).
   */
  add(src: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color, tint = 0): this {
    const g = src.index ? src.toNonIndexed() : src;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.nor.push(v.x, v.y, v.z);
      this.col.push(color.r, color.g, color.b);
      this.tint.push(tint);
    }
    if (g !== src) g.dispose();
    return this;
  }

  /** Faction-painted part: `base` lerped toward the instance colour by `k`, times `shade`. */
  paint(src: THREE.BufferGeometry, m: THREE.Matrix4, base: THREE.Color, k: number, shade = 1): this {
    return this.add(src, m, base.clone().multiplyScalar((1 - k) * shade), k * shade);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('tint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const COLOR_VERTEX = `
#if defined( USE_COLOR_ALPHA )
  vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.xyz *= color.xyz;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz += tint * instanceColor.xyz;
#endif
`;

/** Matte standard material whose instance colour is *added* by the per-vertex tint weight. */
export function tintedMaterial(rough = 0.9, metal = 0.05): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float tint;')
      .replace('#include <color_vertex>', COLOR_VERTEX);
  };
  m.customProgramCacheKey = () => 'tinted';
  return m;
}

/** A growable InstancedMesh filled from scratch each frame (begin → push… → end). */
export class InstanceBatch {
  mesh: THREE.InstancedMesh;
  private n = 0;
  private cap: number;

  constructor(
    private readonly parent: THREE.Object3D,
    readonly geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    cap = 64,
    readonly shadow = true,
  ) {
    this.cap = cap;
    this.mesh = this.make(cap);
    parent.add(this.mesh);
  }

  private make(cap: number): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(this.geometry, this.material, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = this.shadow;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.count = 0;
    return im;
  }

  private grow(): void {
    const cap = this.cap * 2;
    const im = this.make(cap);
    (im.instanceMatrix.array as Float32Array).set(this.mesh.instanceMatrix.array as Float32Array);
    (im.instanceColor!.array as Float32Array).set(this.mesh.instanceColor!.array as Float32Array);
    im.castShadow = this.mesh.castShadow;
    im.visible = this.mesh.visible;
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.parent.add(im);
    this.mesh = im;
    this.cap = cap;
  }

  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  push(m: THREE.Matrix4, c: THREE.Color): void {
    if (this.n >= this.cap) this.grow();
    m.toArray(this.mesh.instanceMatrix.array, this.n * 16);
    c.toArray(this.mesh.instanceColor!.array, this.n * 3);
    this.n++;
  }

  /** Push a matrix stored as 16 floats at `offset` of `src`. */
  pushArray(src: Float32Array, offset: number, c: THREE.Color): void {
    if (this.n >= this.cap) this.grow();
    (this.mesh.instanceMatrix.array as Float32Array).set(src.subarray(offset, offset + 16), this.n * 16);
    c.toArray(this.mesh.instanceColor!.array, this.n * 3);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    const ic = this.mesh.instanceColor!;
    ic.clearUpdateRanges();
    ic.addUpdateRange(0, this.n * 3);
    ic.needsUpdate = true;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}
