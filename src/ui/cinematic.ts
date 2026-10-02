import type { GameRenderer } from '../render/renderer';
import type { World } from '../sim/world';

interface Hotspot {
  x: number;
  z: number;
  score: number;
}

interface Shot {
  x: number;
  z: number;
  /** yaw rate (rad/s) — orbit */
  spin: number;
  /** drift velocity along ground (m/s) */
  vx: number;
  vz: number;
  duration: number;
}

const CELL = 90;
const FADE_LEAD = 0.45; // seconds of dip-to-black before each cut

/**
 * Attract-mode camera director: finds where hostile units are mixing, then frames those
 * fights with slow orbits and drifts, cutting every 8–12 s through a short dip to black.
 */
export class CinematicDirector {
  private shot: Shot | null = null;
  private t = 0;
  private last: Hotspot | null = null;
  private dipping = false;
  private rng = Math.random;

  constructor(
    private readonly world: World,
    private readonly renderer: GameRenderer,
    private readonly fadeEl: HTMLElement,
    private readonly still: boolean,
  ) {}

  /** Frame the first shot immediately (call after the fast-forward). */
  start(): void {
    this.cut();
  }

  update(dt: number): void {
    if (!this.shot) return;
    if (this.still) return;
    const rig = this.renderer.rig;
    this.t += dt;
    rig.rotate(this.shot.spin * dt);
    this.shot.x += this.shot.vx * dt;
    this.shot.z += this.shot.vz * dt;
    rig.lookAt(this.shot.x, this.shot.z);
    const left = this.shot.duration - this.t;
    if (left < FADE_LEAD && !this.dipping) {
      this.dipping = true;
      this.fadeEl.classList.add('dip');
    }
    if (left <= 0) this.cut();
  }

  private cut(): void {
    const rig = this.renderer.rig;
    const spot = this.pickHotspot();
    this.last = spot;
    const heading = this.rng() * Math.PI * 2;
    const orbit = this.rng() < 0.55;
    const driftDir = this.rng() * Math.PI * 2;
    const drift = orbit ? 0 : 4 + this.rng() * 4;
    this.shot = {
      x: spot.x - Math.cos(driftDir) * drift * 5,
      z: spot.z - Math.sin(driftDir) * drift * 5,
      spin: orbit ? (this.rng() < 0.5 ? -1 : 1) * (0.05 + this.rng() * 0.04) : (this.rng() - 0.5) * 0.02,
      vx: Math.cos(driftDir) * drift,
      vz: Math.sin(driftDir) * drift,
      duration: 8 + this.rng() * 4,
    };
    this.t = 0;
    rig.follow = null;
    rig.faceHeading(heading, true);
    rig.lookAt(this.shot.x, this.shot.z);
    rig.setElevation(35 + this.rng() * 5);
    rig.setZoom(spot.score > 0 ? 1.7 + this.rng() * 0.8 : 1.1);
    this.dipping = false;
    // Let the new frame settle for a beat before lifting the black.
    window.setTimeout(() => this.fadeEl.classList.remove('dip'), 120);
  }

  private pickHotspot(): Hotspot {
    const w = this.world;
    const cols = Math.ceil(w.terrain.width / CELL);
    const rows = Math.ceil(w.terrain.depth / CELL);
    const nf = w.factions.length;
    const counts = new Map<number, number[]>();
    for (const u of w.units.values()) {
      if (u.hp <= 0 || u.fixed) continue;
      const i = Math.min(cols - 1, Math.max(0, Math.floor(u.pos.x / CELL)));
      const j = Math.min(rows - 1, Math.max(0, Math.floor(u.pos.z / CELL)));
      const key = j * cols + i;
      let c = counts.get(key);
      if (!c) {
        c = new Array<number>(nf).fill(0);
        counts.set(key, c);
      }
      c[u.owner] += u.def.kind === 'vehicle' ? 2 : 1;
    }
    // Score each cell by the strength of the two strongest *hostile* sides in its 3×3 block.
    const spots: Hotspot[] = [];
    for (const key of counts.keys()) {
      const i = key % cols;
      const j = Math.floor(key / cols);
      const sum = new Array<number>(nf).fill(0);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const c = counts.get((j + dj) * cols + (i + di));
          if (!c || i + di < 0 || i + di >= cols) continue;
          for (let f = 0; f < nf; f++) sum[f] += c[f];
        }
      }
      const sorted = [...sum].sort((a, b) => b - a);
      const score = Math.min(sorted[0], sorted[1] ?? 0) * 3 + (sorted[0] + (sorted[1] ?? 0)) * 0.3;
      if (score > 0) spots.push({ x: (i + 0.5) * CELL, z: (j + 0.5) * CELL, score });
    }
    spots.sort((a, b) => b.score - a.score);
    const prev = this.last;
    const fresh = spots.filter((s) => !prev || Math.hypot(s.x - prev.x, s.z - prev.z) > 260);
    const pool = (fresh.length ? fresh : spots).slice(0, 3);
    if (pool.length) return pool[Math.floor(this.rng() * pool.length)];
    const o = w.objectives[Math.floor(this.rng() * Math.max(1, w.objectives.length))];
    return o ? { x: o.pos.x, z: o.pos.z, score: 0 } : { x: w.terrain.width / 2, z: w.terrain.depth / 2, score: 0 };
  }
}
