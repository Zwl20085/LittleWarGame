import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import { smoothBankHeights } from './bankSmoothing';
import { buildBridges } from './bridges';
import { roadDistanceField } from './roadField';
import { buildScatter } from './scatter';
import { buildSettlements } from './settlements';
import { computeTerrainAttribs } from './terrainColor';
import { terrainMaterial, type TerrainUniforms } from './terrainMaterial';
import { buildForests } from './vegetation';
import { WaterView } from './water';

/** Grid cells per terrain tile (tiles let the camera and shadow passes cull). */
const TILE_CELLS = 64;

/**
 * The diorama table: tiled vertex-coloured heightfield (fields, contours and the front-line
 * overlay are applied in its shader), animated rivers, bridges, forests, towns and the
 * wooden table edge.
 */
export class TerrainView {
  readonly group = new THREE.Group();
  readonly overlayCanvas: HTMLCanvasElement;
  readonly overlayTex: THREE.CanvasTexture;
  readonly water: WaterView;
  readonly uniforms: TerrainUniforms;
  readonly forests: THREE.Group;
  /** Rocks and edge shrubs (hidden at overview zoom where they are sub-pixel). */
  readonly scatter: THREE.Group;

  /** Render heights (visual heights with eased river banks). */
  readonly heights: Float32Array;

  constructor(private readonly terrain: Terrain) {
    this.heights = smoothBankHeights(terrain);
    this.overlayCanvas = document.createElement('canvas');
    // 2.5 m per pixel; the 10 m field is upscaled with blur for soft contours.
    this.overlayCanvas.width = Math.ceil(terrain.width / 2.5);
    this.overlayCanvas.height = Math.ceil(terrain.depth / 2.5);
    this.overlayTex = new THREE.CanvasTexture(this.overlayCanvas);
    this.overlayTex.magFilter = THREE.LinearFilter;
    this.overlayTex.minFilter = THREE.LinearFilter;
    this.overlayTex.generateMipmaps = false;
    this.overlayTex.colorSpace = THREE.SRGBColorSpace;
    const { material, uniforms } = terrainMaterial(this.overlayTex, terrain.width, terrain.depth);
    this.uniforms = uniforms;
    this.group.add(this.buildTiles(material));
    this.water = new WaterView(terrain, this.heights);
    if (this.water.mesh) this.group.add(this.water.mesh);
    this.forests = buildForests(terrain);
    this.scatter = buildScatter(terrain);
    this.group.add(this.forests, this.scatter, buildSettlements(terrain), buildBridges(terrain), this.buildBase());
  }

  private buildTiles(material: THREE.Material): THREE.Group {
    const t = this.terrain;
    const a = computeTerrainAttribs(t, this.heights);
    const roadD = roadDistanceField(t);
    const g = new THREE.Group();
    const nx = t.nx;
    for (let tj = 0; tj < t.nz - 1; tj += TILE_CELLS) {
      for (let ti = 0; ti < nx - 1; ti += TILE_CELLS) {
        const ci = Math.min(TILE_CELLS, nx - 1 - ti);
        const cj = Math.min(TILE_CELLS, t.nz - 1 - tj);
        const vx = ci + 1;
        const vz = cj + 1;
        const pos = new Float32Array(vx * vz * 3);
        const nor = new Float32Array(vx * vz * 3);
        const col = new Float32Array(vx * vz * 3);
        const farm = new Float32Array(vx * vz);
        const ang = new Float32Array(vx * vz);
        const road = new Float32Array(vx * vz);
        for (let j = 0; j < vz; j++) {
          for (let i = 0; i < vx; i++) {
            const k = j * vx + i;
            const src = (tj + j) * nx + ti + i;
            pos[k * 3] = (ti + i) * t.cell;
            pos[k * 3 + 1] = this.heights[src];
            pos[k * 3 + 2] = (tj + j) * t.cell;
            for (let c = 0; c < 3; c++) {
              nor[k * 3 + c] = a.normal[src * 3 + c];
              col[k * 3 + c] = a.color[src * 3 + c];
            }
            farm[k] = a.farm[src];
            ang[k] = a.fieldAngle[src];
            road[k] = roadD[src];
          }
        }
        const idx: number[] = [];
        for (let j = 0; j < cj; j++) {
          for (let i = 0; i < ci; i++) {
            const p = j * vx + i;
            idx.push(p, p + vx, p + 1, p + 1, p + vx, p + vx + 1);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('aFarm', new THREE.BufferAttribute(farm, 1));
        geo.setAttribute('aFieldAng', new THREE.BufferAttribute(ang, 1));
        geo.setAttribute('aRoadD', new THREE.BufferAttribute(road, 1));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        g.add(mesh);
      }
    }
    return g;
  }

  /** Wooden table edge under the diorama — sells the miniature look. */
  private buildBase(): THREE.Group {
    const g = new THREE.Group();
    const t = this.terrain;
    const depth = 30;
    const mat = new THREE.MeshStandardMaterial({ color: '#5a4632', roughness: 0.85 });
    const side = new THREE.MeshStandardMaterial({ color: '#7b6247', roughness: 0.9 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(t.width + 24, depth, t.depth + 24), [side, side, mat, mat, side, side]);
    slab.position.set(t.width / 2, -depth / 2 - 0.5, t.depth / 2);
    slab.receiveShadow = true;
    g.add(slab);
    // Skirt walls from ground to slab so edges look like a cut terrain block.
    const skirtMat = new THREE.MeshStandardMaterial({ color: '#8a7454', roughness: 1, side: THREE.DoubleSide });
    const edges: [number, number, number, number][] = [
      [0, 0, t.width, 0], [t.width, 0, t.width, t.depth], [t.width, t.depth, 0, t.depth], [0, t.depth, 0, 0],
    ];
    for (const [x0, z0, x1, z1] of edges) {
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 8);
      const pos: number[] = [];
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        pos.push(x, t.heightAt(x, z), z, x, -1, z);
      }
      const idx: number[] = [];
      for (let k = 0; k < n; k++) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, skirtMat));
    }
    return g;
  }
}
