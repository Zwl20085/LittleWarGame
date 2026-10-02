import { FRONTLINE } from './config';
import type { V2 } from './vec';
import type { World } from './world';

export const NEUTRAL = -1;
export const CONTESTED = -2;

/** Ground-influence field (BALANCE_SPEC §10); explains the front, never blocks anything. */
export class FrontlineField {
  readonly cell = FRONTLINE.cell;
  readonly nx: number;
  readonly nz: number;
  readonly smooth: Float32Array[];
  readonly owner: Int8Array;
  private readonly pending: Int8Array;
  private readonly pendingSince: Float32Array;
  private readonly raw: Float32Array[];
  /** Per-column Gaussian factors of the current stamp (scratch, sized for the widest kernel). */
  private readonly kernelX: Float64Array;
  version = 0;

  constructor(private readonly world: World, private readonly observer: number | null) {
    this.nx = Math.ceil(world.terrain.width / this.cell);
    this.nz = Math.ceil(world.terrain.depth / this.cell);
    const n = this.nx * this.nz;
    const nf = world.factions.length;
    this.smooth = Array.from({ length: nf }, () => new Float32Array(n));
    this.raw = Array.from({ length: nf }, () => new Float32Array(n));
    this.owner = new Int8Array(n).fill(NEUTRAL);
    this.pending = new Int8Array(n).fill(NEUTRAL);
    this.pendingSince = new Float32Array(n);
    this.kernelX = new Float64Array(this.nx + 1);
  }

  ownerAt(p: V2): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor(p.x / this.cell)));
    const j = Math.min(this.nz - 1, Math.max(0, Math.floor(p.z / this.cell)));
    return this.owner[j * this.nx + i];
  }

  private stamp(f: number, x: number, z: number, weight: number, radius: number): void {
    const r2 = radius * 1.6;
    const i0 = Math.max(0, Math.floor((x - r2) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.floor((x + r2) / this.cell));
    const j0 = Math.max(0, Math.floor((z - r2) / this.cell));
    const j1 = Math.min(this.nz - 1, Math.floor((z + r2) / this.cell));
    const raw = this.raw[f];
    const inv = 1 / (radius * radius);
    // The Gaussian is separable: exp(-(cx²+cz²)/r²) = exp(-cx²/r²)·exp(-cz²/r²), so one exp per
    // column and per row instead of one per cell (~30× fewer exp calls; equal up to rounding).
    const ex = this.kernelX;
    for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * this.cell - x;
      ex[i - i0] = Math.exp(-cx * cx * inv);
    }
    const lim = r2 * r2;
    for (let j = j0; j <= j1; j++) {
      const cz = (j + 0.5) * this.cell - z;
      const wz = weight * Math.exp(-cz * cz * inv);
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * this.cell - x;
        if (cx * cx + cz * cz > lim) continue;
        raw[row + i] += wz * ex[i - i0];
      }
    }
  }

  update(seconds: number): void {
    const w = this.world;
    for (const r of this.raw) r.fill(0);
    for (const f of w.factions) {
      if (!f.alive) continue;
      const c = w.cityOf(f.id);
      this.stamp(f.id, c.hq.x, c.hq.z, FRONTLINE.cityWeight, FRONTLINE.radiusCity);
    }
    for (const o of w.objectives) if (o.owner >= 0 && w.factions[o.owner].alive) this.stamp(o.owner, o.pos.x, o.pos.z, FRONTLINE.pointWeight, FRONTLINE.radiusPoint);
    for (const u of w.units.values()) {
      if (u.hp <= 0 || u.fixed || !w.factions[u.owner].alive) continue;
      if (this.observer !== null && u.owner !== this.observer && !w.visibleTo[this.observer].has(u.id)) continue;
      const base = FRONTLINE.weights[u.def.id] ?? 0;
      if (base <= 0) continue;
      const morale = u.routing ? 0.2 : u.moraleState === 'pinned' ? 0.6 : 1;
      this.stamp(u.owner, u.pos.x, u.pos.z, base * Math.sqrt(u.hp / u.def.maxHp) * morale, FRONTLINE.radiusGround);
    }
    const alpha = 1 - Math.exp(-seconds / FRONTLINE.smoothingSeconds);
    const n = this.owner.length;
    const nf = w.factions.length;
    const smooth = this.smooth;
    const raw = this.raw;
    const owner = this.owner;
    const pending = this.pending;
    const since = this.pendingSince;
    const now = w.time;
    for (let k = 0; k < n; k++) {
      let best = -1;
      let bv = 0;
      let second = 0;
      for (let f = 0; f < nf; f++) {
        const s = smooth[f];
        s[k] += (raw[f][k] - s[k]) * alpha;
        const v = s[k];
        if (v > bv) {
          second = bv;
          bv = v;
          best = f;
        } else if (v > second) second = v;
      }
      let cand: number;
      if (bv < FRONTLINE.neutralBelow) cand = NEUTRAL;
      else if (bv - second < FRONTLINE.contestedDelta) cand = CONTESTED;
      else cand = best;
      if (cand === owner[k]) continue;
      if (pending[k] !== cand) {
        pending[k] = cand;
        since[k] = now;
      } else if (now - since[k] >= 2) {
        owner[k] = cand;
      }
    }
    this.version++;
  }
}
