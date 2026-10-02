import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateMap } from '../src/sim/mapgen';
import { Ground, Terrain } from '../src/sim/terrain';
import { NavGrid } from '../src/sim/nav';

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('procedural map', () => {
  for (const [seed, n] of [[7, 4], [21, 2]] as const) {
    it(`seed ${seed} / ${n} factions is valid and connected`, () => {
      const t0 = performance.now();
      const def = generateMap({ seed, factions: n, size: 'medium' });
      const terrain = new Terrain(def);
      const ms = performance.now() - t0;
      // Every capital can reach every objective on foot and by vehicle.
      for (const veh of [false, true]) {
        const nav = new NavGrid(terrain, { vehicle: veh, maxSlopeDeg: veh ? 18 : 35 });
        for (const c of def.cities) for (const o of def.objectives) expect(nav.findPath(c.exit, o.pos, 200000).ok).toBe(true);
        for (const c of def.cities) for (const d of def.cities) expect(nav.findPath(c.exit, d.hq, 200000).ok).toBe(true);
      }
      const s = 2;
      const w = Math.floor(def.width / s / 2);
      const h = Math.floor(def.depth / s / 2);
      const rgb = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const wx = x * s * 2; const wz = y * s * 2;
        const g = terrain.groundAt(wx, wz); const ht = terrain.heightAt(wx, wz); const sl = terrain.slopeAt(wx, wz);
        let c = [150 + ht, 160 + ht * 0.6, 110];
        if (sl > 20) c = [140, 130, 120];
        if (g === Ground.Forest) c = [70, 100, 60];
        if (g === Ground.Town) c = [190, 120, 100];
        if (g === Ground.Road) c = [230, 210, 160];
        if (g === Ground.Water) c = [60, 110, 170];
        if (g === Ground.Ford) c = [120, 170, 200];
        const k = (y * w + x) * 3; rgb[k] = Math.min(255, c[0]); rgb[k + 1] = Math.min(255, c[1]); rgb[k + 2] = Math.min(255, c[2]);
      }
      for (const c of def.cities) for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const k = ((Math.round(c.hq.z / 4) + dy) * w + Math.round(c.hq.x / 4) + dx) * 3; if (k >= 0 && k < rgb.length) { rgb[k] = 255; rgb[k + 1] = 0; rgb[k + 2] = 0; } }
      const out = process.env.MAPGEN_OUT;
      if (out) writeFileSync(`${out}/map_${seed}_${n}.png`, png(w, h, rgb));
      console.log(`seed ${seed}: ${def.width}x${def.depth} gen+terrain ${ms.toFixed(0)}ms towns ${def.towns.length} rivers ${def.rivers.length} bridges ${terrain.bridges.length} roads ${def.roads.length} forests ${def.forests.length} objectives ${def.objectives.length} features ${def.features?.length}`);
    }, 120000);
  }
});
