import * as THREE from 'three';

/**
 * 3.0 light tilt-shift (V30_SPEC §4; VISUAL_UX §2.2: no strong default depth of field — a light
 * one as a close-in watching option). Only on the high tier, only at low camera angles and close
 * zoom, so the command view stays sharp. Minimal two-pass separable blur at half resolution, then
 * a composite that keeps a horizontal band around the view centre in focus. No EffectComposer.
 */
export const TILT = {
  /** Fully on below this elevation (deg); off at `elevOff` and above. */
  elevFull: 37,
  elevOff: 44,
  /** Pixels per metre: off below `ppmOff`, full at `ppmFull`. */
  ppmOff: 2.6,
  ppmFull: 5,
  /** Half height of the sharp band (fraction of the screen) and the blend width beyond it. */
  band: 0.16,
  falloff: 0.32,
  /** Blur step in half-resolution texels at full strength. */
  radius: 1.6,
  /** Below this strength the pass is skipped entirely (direct render). */
  minStrength: 0.02,
} as const;

/** How strongly the tilt-shift applies at a camera elevation (deg) and zoom (px per metre). */
export function tiltStrength(elevationDeg: number, ppm: number): number {
  const e = (TILT.elevOff - elevationDeg) / (TILT.elevOff - TILT.elevFull);
  const z = (ppm - TILT.ppmOff) / (TILT.ppmFull - TILT.ppmOff);
  const c = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
  return c(e) * c(z);
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  // 9-tap Gaussian (sigma ~2 taps), linear-filtered.
  vec4 c = texture2D(tSrc, vUv) * 0.2270270270;
  c += texture2D(tSrc, vUv + uStep * 1.3846153846) * 0.3162162162;
  c += texture2D(tSrc, vUv - uStep * 1.3846153846) * 0.3162162162;
  c += texture2D(tSrc, vUv + uStep * 3.2307692308) * 0.0702702703;
  c += texture2D(tSrc, vUv - uStep * 3.2307692308) * 0.0702702703;
  gl_FragColor = c;
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tSharp;
uniform sampler2D tBlur;
uniform float uStrength;
uniform float uBand;
uniform float uFalloff;
varying vec2 vUv;
void main() {
  vec4 sharp = texture2D(tSharp, vUv);
  vec4 soft = texture2D(tBlur, vUv);
  float m = smoothstep(uBand, uBand + uFalloff, abs(vUv.y - 0.5)) * uStrength;
  gl_FragColor = mix(sharp, soft, m);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class TiltShift {
  private scene: THREE.WebGLRenderTarget | null = null;
  private half: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private readonly quad: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blur: THREE.ShaderMaterial;
  private readonly comp: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  /** Current strength 0–1 (eased by the caller). */
  strength = 0;

  constructor() {
    this.blur = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
    });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false,
      uniforms: { tSharp: { value: null }, tBlur: { value: null }, uStrength: { value: 0 }, uBand: { value: TILT.band }, uFalloff: { value: TILT.falloff } },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blur);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Compile both pass shaders up front (no link stall the first time a low angle is reached). */
  prewarm(renderer: THREE.WebGLRenderer): void {
    for (const m of [this.blur, this.comp]) {
      this.quad.material = m;
      renderer.compile(this.quadScene, this.quadCam);
    }
  }

  get active(): boolean {
    return this.strength >= TILT.minStrength;
  }

  private ensureTargets(renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    if (this.scene && this.scene.width === w && this.scene.height === h) return;
    this.disposeTargets();
    this.scene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    const hw = Math.max(1, Math.round(w / 2));
    const hh = Math.max(1, Math.round(h / 2));
    const mk = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false });
    this.half = [mk(), mk()];
  }

  /** Render the scene with the tilt-shift (or straight through when inactive). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.active) {
      renderer.render(scene, camera);
      return;
    }
    this.ensureTargets(renderer);
    const full = this.scene!;
    const [a, b] = this.half!;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(full);
    renderer.render(scene, camera);
    const r = TILT.radius * this.strength;
    this.quad.material = this.blur;
    this.blur.uniforms.tSrc.value = full.texture;
    (this.blur.uniforms.uStep.value as THREE.Vector2).set(r / a.width, 0);
    renderer.setRenderTarget(a);
    renderer.render(this.quadScene, this.quadCam);
    this.blur.uniforms.tSrc.value = a.texture;
    (this.blur.uniforms.uStep.value as THREE.Vector2).set(0, r / b.height);
    renderer.setRenderTarget(b);
    renderer.render(this.quadScene, this.quadCam);
    this.quad.material = this.comp;
    this.comp.uniforms.tSharp.value = full.texture;
    this.comp.uniforms.tBlur.value = b.texture;
    this.comp.uniforms.uStrength.value = this.strength;
    renderer.setRenderTarget(prev);
    renderer.render(this.quadScene, this.quadCam);
  }

  private disposeTargets(): void {
    this.scene?.dispose();
    this.half?.forEach((t) => t.dispose());
    this.scene = null;
    this.half = null;
  }

  /** Free the render targets (e.g. when the tier drops); they are rebuilt on demand. */
  release(): void {
    this.disposeTargets();
  }

  dispose(): void {
    this.disposeTargets();
    this.blur.dispose();
    this.comp.dispose();
    this.quad.geometry.dispose();
  }
}
