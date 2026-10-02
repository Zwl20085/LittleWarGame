import { Rng } from './rng';

/** Seeded 2D value noise with smooth interpolation, used for gentle terrain undulation. */
export class ValueNoise {
  private readonly perm: Float32Array;
  private readonly size = 256;

  constructor(seed: number) {
    const rng = new Rng(seed);
    this.perm = new Float32Array(this.size * this.size);
    for (let i = 0; i < this.perm.length; i++) this.perm[i] = rng.next();
  }

  private at(ix: number, iz: number): number {
    const s = this.size;
    return this.perm[(((iz % s) + s) % s) * s + (((ix % s) + s) % s)];
  }

  sample(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = this.at(ix, iz);
    const b = this.at(ix + 1, iz);
    const c = this.at(ix, iz + 1);
    const d = this.at(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }

  fbm(x: number, z: number, octaves = 3): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
