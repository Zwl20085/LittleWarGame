import * as THREE from 'three';

/**
 * 3.0 time-of-day drift (V30_SPEC §4): the war runs from early morning through noon to dusk —
 * never night. The sun swings slowly across the top of the table (cartographic light: it stays
 * on the far side of the default camera, so slopes keep reading the same way), its colour and
 * height change with the hour, and the sky backdrop and haze follow. One game hour from the
 * opening to dusk, then it holds at dusk.
 */
export const DAY = {
  /** Day phase at the opening (0 dawn, 0.5 noon, 1 dusk). */
  startPhase: 0.12,
  /** Game seconds from the opening to dusk. */
  spanSeconds: 3600,
  /** The 2.x fixed late-afternoon look (used when the drift is switched off). */
  fixedPhase: 0.78,
  /** Backdrop repaint step (phase units; ~40 game seconds). */
  repaintStep: 0.012,
} as const;

interface Stop {
  readonly at: number;
  /** Sun azimuth on the ground plane (deg, atan2(z, x)) and elevation above the horizon (deg). */
  readonly az: number;
  readonly el: number;
  readonly sun: string;
  readonly sunI: number;
  readonly sky: string;
  readonly hemiI: number;
  readonly ground: string;
  readonly haze: string;
  /** Backdrop: centre and rim of the vignette, and the sky tint washed over its top. */
  readonly bgIn: string;
  readonly bgOut: string;
  readonly bgSky: string;
}

/** Colour and sun stops; 0.78 reproduces the 2.x constants in atmosphere.ts exactly. */
const STOPS: readonly Stop[] = [
  { at: 0, az: -32, el: 21, sun: '#ffc79c', sunI: 2.0, sky: '#d5dbe4', hemiI: 0.98, ground: '#5e5446', haze: '#c9cbcc', bgIn: '#828189', bgOut: '#35363b', bgSky: '#b9c3d0' },
  { at: 0.5, az: -96, el: 58, sun: '#fff2dc', sunI: 2.45, sky: '#e5e8e6', hemiI: 1.04, ground: '#6b5c43', haze: '#d6d0c0', bgIn: '#8e897c', bgOut: '#3f3b34', bgSky: '#c9cdc8' },
  { at: 0.78, az: -147.65, el: 43.3, sun: '#ffe0b5', sunI: 2.35, sky: '#e2e4e0', hemiI: 1.0, ground: '#6b5a40', haze: '#d3c9b4', bgIn: '#8f8676', bgOut: '#3e3932', bgSky: '#c8bfae' },
  { at: 1, az: -166, el: 22, sun: '#ffb47c', sunI: 2.05, sky: '#dcd3cf', hemiI: 0.9, ground: '#6a5440', haze: '#d9c09f', bgIn: '#8b7564', bgOut: '#3a2e28', bgSky: '#d2b090' },
];

/** Day phase (0 dawn … 1 dusk) at a match time in game seconds. */
export function dayPhase(time: number, drift = true): number {
  if (!drift) return DAY.fixedPhase;
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  return Math.min(1, DAY.startPhase + (t / DAY.spanSeconds) * (1 - DAY.startPhase));
}

export interface Daylight {
  readonly sunDir: THREE.Vector3;
  readonly sunColor: THREE.Color;
  sunIntensity: number;
  readonly skyColor: THREE.Color;
  hemiIntensity: number;
  readonly groundColor: THREE.Color;
  readonly hazeColor: THREE.Color;
  readonly bgIn: THREE.Color;
  readonly bgOut: THREE.Color;
  readonly bgSky: THREE.Color;
}

export function newDaylight(): Daylight {
  return {
    sunDir: new THREE.Vector3(), sunColor: new THREE.Color(), sunIntensity: 0, skyColor: new THREE.Color(), hemiIntensity: 0,
    groundColor: new THREE.Color(), hazeColor: new THREE.Color(), bgIn: new THREE.Color(), bgOut: new THREE.Color(), bgSky: new THREE.Color(),
  };
}

const ca = new THREE.Color();
const cb = new THREE.Color();
const mix = (out: THREE.Color, a: string, b: string, k: number): void => {
  out.copy(ca.set(a)).lerp(cb.set(b), k);
};

/** Light at a day phase, written into `out` (no allocation per frame). */
export function daylightAt(phase: number, out: Daylight = newDaylight()): Daylight {
  const p = Math.min(1, Math.max(0, Number.isFinite(phase) ? phase : DAY.fixedPhase));
  let i = 0;
  while (i < STOPS.length - 2 && p > STOPS[i + 1].at) i++;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const k = (p - a.at) / (b.at - a.at);
  const az = THREE.MathUtils.degToRad(a.az + (b.az - a.az) * k);
  const el = THREE.MathUtils.degToRad(a.el + (b.el - a.el) * k);
  out.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  mix(out.sunColor, a.sun, b.sun, k);
  out.sunIntensity = a.sunI + (b.sunI - a.sunI) * k;
  mix(out.skyColor, a.sky, b.sky, k);
  out.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * k;
  mix(out.groundColor, a.ground, b.ground, k);
  mix(out.hazeColor, a.haze, b.haze, k);
  mix(out.bgIn, a.bgIn, b.bgIn, k);
  mix(out.bgOut, a.bgOut, b.bgOut, k);
  mix(out.bgSky, a.bgSky, b.bgSky, k);
  return out;
}

/**
 * The war-room backdrop around the table: a warm vignette (the table lit on a desk) with the
 * hour's sky washed over the top, so the far side of the board sits against a soft horizon.
 */
export function paintBackdrop(canvas: HTMLCanvasElement, d: Daylight): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const n = canvas.width;
  const css = (c: THREE.Color): string => `#${c.getHexString()}`;
  const grd = g.createRadialGradient(n / 2, n * 0.46, n * 0.08, n / 2, n / 2, n * 0.74);
  grd.addColorStop(0, css(d.bgIn));
  grd.addColorStop(0.6, `#${ca.copy(d.bgIn).lerp(d.bgOut, 0.45).getHexString()}`);
  grd.addColorStop(1, css(d.bgOut));
  g.globalAlpha = 1;
  g.fillStyle = grd;
  g.fillRect(0, 0, n, n);
  const sky = g.createLinearGradient(0, 0, 0, n * 0.62);
  sky.addColorStop(0, css(d.bgSky));
  sky.addColorStop(1, `rgba(${Math.round(d.bgSky.r * 255)}, ${Math.round(d.bgSky.g * 255)}, ${Math.round(d.bgSky.b * 255)}, 0)`);
  g.globalAlpha = 0.42;
  g.fillStyle = sky;
  g.fillRect(0, 0, n, n);
  g.globalAlpha = 1;
}

export interface DayTargets {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Shared with the renderer (shadow placement, water glint): updated in place. */
  readonly sunDir: THREE.Vector3;
  setHaze(c: THREE.Color): void;
  readonly backdrop: { readonly canvas: HTMLCanvasElement; readonly texture: THREE.Texture } | null;
}

/** Applies the drift to the scene lights; cheap per frame (a few lerps, no allocation). */
export class DayCycle {
  drift = true;
  private readonly light = newDaylight();
  private paintedAt = -1;
  phase: number = DAY.fixedPhase;

  constructor(private readonly targets: DayTargets) {}

  update(time: number): void {
    const p = dayPhase(time, this.drift);
    this.phase = p;
    const d = daylightAt(p, this.light);
    const t = this.targets;
    t.sunDir.copy(d.sunDir);
    t.sun.color.copy(d.sunColor);
    t.sun.intensity = d.sunIntensity;
    t.hemi.color.copy(d.skyColor);
    t.hemi.groundColor.copy(d.groundColor);
    t.hemi.intensity = d.hemiIntensity;
    t.setHaze(d.hazeColor);
    if (t.backdrop && Math.abs(p - this.paintedAt) >= DAY.repaintStep) {
      this.paintedAt = p;
      paintBackdrop(t.backdrop.canvas, d);
      t.backdrop.texture.needsUpdate = true;
    }
  }
}
