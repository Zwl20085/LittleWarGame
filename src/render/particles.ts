import * as THREE from 'three';

/** Emission options for one particle. Unset fields take neutral defaults. */
export interface EmitOpts {
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  grow?: number;
  alpha?: number;
  /** Exponent of the alpha fade-out (1 = linear). */
  fade?: number;
  /** Fraction of the lifetime spent fading in (soft smoke onset). */
  fadeIn?: number;
  gravity?: number;
  /** Velocity damping per second (default 0.6). */
  drag?: number;
  /** How strongly the particle drifts with the wind (0..1). */
  drift?: number;
  color?: THREE.Color;
  /** Brightness flicker amplitude (fire). */
  flicker?: number;
}

/**
 * One draw call for up to `cap` camera-facing particles: instanced quads with per-instance
 * position / size / rgba / rotation in struct-of-arrays storage. Dead particles swap-remove.
 * Alpha particles get a cheap top-lit shade so smoke reads as volume, not flat discs.
 */
export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  /** Wind (m/s) applied to particles in proportion to their `drift`. */
  readonly wind = new THREE.Vector3();
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aRot: THREE.InstancedBufferAttribute;
  private readonly attrs: THREE.InstancedBufferAttribute[];
  // Simulation state.
  private readonly px: Float32Array;
  private readonly vel: Float32Array;
  private readonly rgb: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly base: Float32Array;
  private readonly grow: Float32Array;
  private readonly alpha: Float32Array;
  private readonly fade: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly drift: Float32Array;
  private readonly flick: Float32Array;
  private readonly spin: Float32Array;
  private readonly vec3s: Float32Array[];
  private readonly scalars: Float32Array[];
  private time = 0;
  n = 0;

  constructor(readonly cap: number, map: THREE.Texture, additive: boolean) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(3);
    this.aSize = mk(1);
    this.aCol = mk(4);
    this.aRot = mk(1);
    this.attrs = [this.aPos, this.aSize, this.aCol, this.aRot];
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iSize', this.aSize);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iRot', this.aRot);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, uShade: { value: additive ? 0 : 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute float iSize; attribute vec4 iCol; attribute float iRot;
        varying vec2 vUv; varying vec4 vCol; varying float vLit;
        void main() {
          vUv = uv; vCol = iCol;
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float c = cos(iRot), s = sin(iRot);
          vec2 q = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
          vLit = position.y * c + position.x * s;
          mv.xy += q * iSize;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform float uShade; varying vec2 vUv; varying vec4 vCol; varying float vLit;
        void main() {
          vec4 t = texture2D(map, vUv);
          // Screen-up side of a puff catches the sun; the underside sits in its own shadow.
          float shade = mix(1.0, 0.78 + 0.42 * (vLit + 0.5), uShade);
          gl_FragColor = vec4(vCol.rgb * t.rgb * shade, vCol.a * t.a);
          if (gl_FragColor.a < 0.004) discard;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 4 : 3;
    this.px = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.rgb = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.base = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.fade = new Float32Array(cap);
    this.fadeIn = new Float32Array(cap);
    this.gravity = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.drift = new Float32Array(cap);
    this.flick = new Float32Array(cap);
    this.spin = new Float32Array(cap);
    this.vec3s = [this.px, this.vel, this.rgb];
    this.scalars = [this.life, this.maxLife, this.base, this.grow, this.alpha, this.fade, this.fadeIn, this.gravity, this.drag, this.drift, this.flick, this.spin];
  }

  /** Free slots left (callers thin optional detail when the pool is nearly full). */
  get free(): number {
    return this.cap - this.n;
  }

  emit(x: number, y: number, z: number, o: EmitOpts): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const i3 = i * 3;
    this.px[i3] = x; this.px[i3 + 1] = y; this.px[i3 + 2] = z;
    this.vel[i3] = o.vx ?? 0; this.vel[i3 + 1] = o.vy ?? 0; this.vel[i3 + 2] = o.vz ?? 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.base[i] = o.size;
    this.grow[i] = o.grow ?? 0;
    this.alpha[i] = o.alpha ?? 1;
    this.fade[i] = o.fade ?? 1;
    this.fadeIn[i] = o.fadeIn ?? 0;
    this.gravity[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0.6;
    this.drift[i] = o.drift ?? 0;
    this.flick[i] = o.flicker ?? 0;
    const c = o.color;
    this.rgb[i3] = c ? c.r : 1; this.rgb[i3 + 1] = c ? c.g : 1; this.rgb[i3 + 2] = c ? c.b : 1;
    this.spin[i] = Math.random() * Math.PI * 2;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (const a of this.vec3s) {
      a[i * 3] = a[j * 3];
      a[i * 3 + 1] = a[j * 3 + 1];
      a[i * 3 + 2] = a[j * 3 + 2];
    }
    for (const a of this.scalars) a[i] = a[j];
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = this.n - 1; i >= 0; i--) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) this.kill(i);
    }
    const P = this.aPos.array as Float32Array;
    const S = this.aSize.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    const R = this.aRot.array as Float32Array;
    const wx = this.wind.x;
    const wy = this.wind.y;
    const wz = this.wind.z;
    const time = this.time;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];
      const i3 = i * 3;
      const damp = 1 - Math.min(0.95, dt * this.drag[i]);
      const dr = this.drift[i] * dt;
      this.vel[i3 + 1] -= this.gravity[i] * dt;
      this.vel[i3] *= damp;
      this.vel[i3 + 1] *= damp;
      this.vel[i3 + 2] *= damp;
      this.px[i3] += this.vel[i3] * dt + wx * dr;
      this.px[i3 + 1] += this.vel[i3 + 1] * dt + wy * dr;
      this.px[i3 + 2] += this.vel[i3 + 2] * dt + wz * dr;
      P[i3] = this.px[i3];
      P[i3 + 1] = this.px[i3 + 1];
      P[i3 + 2] = this.px[i3 + 2];
      const fl = this.flick[i] > 0 ? 1 + this.flick[i] * Math.sin(time * 31 + i * 1.7) * Math.sin(time * 17 + i) : 1;
      C[i * 4] = this.rgb[i3] * fl;
      C[i * 4 + 1] = this.rgb[i3 + 1] * fl;
      C[i * 4 + 2] = this.rgb[i3 + 2] * fl;
      S[i] = this.base[i] + this.grow[i] * Math.sqrt(t);
      const fi = this.fadeIn[i];
      const onset = fi > 0 && t < fi ? t / fi : 1;
      C[i * 4 + 3] = this.alpha[i] * onset * (1 - t) ** this.fade[i];
      R[i] = this.spin[i] + t * 0.6;
    }
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = this.n;
  }
}

/** Pooled line segments with per-vertex RGBA (tracers, shell trails). Refilled every frame. */
export class LinePool {
  readonly lines: THREE.LineSegments;
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute;
  private n = 0;

  constructor(readonly cap: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 6), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(cap * 8), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
  }

  begin(): void {
    this.n = 0;
  }

  push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color, a0: number, a1 = a0): void {
    if (this.n >= this.cap) return;
    const p = this.pos.array as Float32Array;
    const q = this.col.array as Float32Array;
    const i6 = this.n * 6;
    const i8 = this.n * 8;
    this.n++;
    p[i6] = ax; p[i6 + 1] = ay; p[i6 + 2] = az;
    p[i6 + 3] = bx; p[i6 + 4] = by; p[i6 + 5] = bz;
    q[i8] = c.r; q[i8 + 1] = c.g; q[i8 + 2] = c.b; q[i8 + 3] = a0;
    q[i8 + 4] = c.r; q[i8 + 5] = c.g; q[i8 + 6] = c.b; q[i8 + 7] = a1;
  }

  end(): void {
    for (const a of [this.pos, this.col]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * 2 * a.itemSize);
      a.needsUpdate = true;
    }
    this.lines.geometry.setDrawRange(0, this.n * 2);
  }
}
