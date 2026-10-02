import * as THREE from 'three';
import type { ParticleSystem } from './particles';

/** A settlement that can smoulder: centre, radius (m) and the ground height there. */
export interface TownSite {
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly y: number;
}

const BURN_POINTS = 4;
const MAX_HEAT = 4;
/** Heat lost per second — a heavily shelled town keeps smoking for a few minutes. */
const COOL_RATE = 1 / 75;

const SMOKE = new THREE.Color('#57524a');
const SMOKE_LIGHT = new THREE.Color('#7b746a');
const FIRE = new THREE.Color('#ff8a3a');
const FIRE_DEEP = new THREE.Color('#d8541a');

/**
 * Building fires derived from nearby shelling (no sim data needed): each explosion inside a
 * settlement adds heat; hot towns send up wind-bent smoke columns from a few fixed spots, with
 * flames at the base while the heat is high.
 */
export class TownFires {
  private sites: readonly TownSite[] = [];
  private heatOf = new Float32Array(0);
  private pts = new Float32Array(0);

  constructor(private readonly smoke: ParticleSystem, private readonly glow: ParticleSystem) {}

  setSites(sites: readonly TownSite[]): void {
    this.sites = sites;
    this.heatOf = new Float32Array(sites.length);
    this.pts = new Float32Array(sites.length * BURN_POINTS * 2);
    let s = 1234567;
    const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    sites.forEach((t, i) => {
      for (let k = 0; k < BURN_POINTS; k++) {
        const a = rnd() * Math.PI * 2;
        const d = t.r * (0.15 + rnd() * 0.4);
        this.pts[(i * BURN_POINTS + k) * 2] = t.x + Math.cos(a) * d;
        this.pts[(i * BURN_POINTS + k) * 2 + 1] = t.z + Math.sin(a) * d;
      }
    });
  }

  heat(x: number, z: number, r: number): void {
    for (let i = 0; i < this.sites.length; i++) {
      const t = this.sites[i];
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz > t.r * t.r) continue;
      this.heatOf[i] = Math.min(MAX_HEAT, this.heatOf[i] + r * 0.05);
    }
  }

  update(dt: number, smokeScale: number): void {
    if (dt <= 0) return;
    for (let i = 0; i < this.sites.length; i++) {
      const h = this.heatOf[i];
      if (h <= 0.05) continue;
      this.heatOf[i] = Math.max(0, h - dt * COOL_RATE);
      const t = this.sites[i];
      // More burning spots as the heat builds up.
      const spots = Math.min(BURN_POINTS, 1 + Math.floor(h));
      const k = (i * BURN_POINTS + Math.floor(Math.random() * spots)) * 2;
      const x = this.pts[k];
      const z = this.pts[k + 1];
      const y = t.y + 5;
      if (smokeScale > 0 && Math.random() < dt * (1 + h * 1.6)) {
        this.smoke.emit(x + (Math.random() - 0.5) * 3, y, z + (Math.random() - 0.5) * 3, {
          color: h > 1.5 ? SMOKE : SMOKE_LIGHT, alpha: Math.min(0.6, 0.45 * smokeScale) * Math.min(1, 0.4 + h * 0.3), life: 12 + Math.random() * 5,
          size: 3.5, grow: (12 + h * 3) * smokeScale, vy: 3 + h * 0.4, drag: 0.15, drift: 1, fadeIn: 0.05, fade: 0.85,
          vx: (Math.random() - 0.5) * 0.6, vz: (Math.random() - 0.5) * 0.6,
        });
      }
      if (h > 1 && Math.random() < dt * h * 2.2) {
        this.glow.emit(x + (Math.random() - 0.5) * 3, y - 3 + Math.random() * 2, z + (Math.random() - 0.5) * 3, {
          life: 0.4 + Math.random() * 0.4, size: 1.6 + h * 0.5, grow: 1, color: Math.random() < 0.5 ? FIRE : FIRE_DEEP, flicker: 0.5, vy: 1.5,
        });
      }
    }
  }
}
