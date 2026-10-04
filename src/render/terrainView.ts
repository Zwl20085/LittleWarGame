import * as THREE from 'three';
import { Ground, type Terrain } from '../sim/terrain';
import { smoothBankHeights } from './bankSmoothing';
import { buildBridges } from './bridges';
import { roadDistanceField } from './roadField';
import { buildScatter } from './scatter';
import { buildSettlements, type Settlements } from './settlements';
import { computeTerrainAttribs } from './terrainColor';
import { terrainMaterial, type TerrainUniforms } from './terrainMaterial';
import { buildForests } from './vegetation';
import { townField, townGrids, type TownGrid } from './townPlan';
import { buildTownProps } from './townProps';
import { WaterView } from './water';

/** Dry cells within this many cells of water get a shore level. */
const SHORE_REACH = 4;

/** Per cell: for dry ground near water, the highest nearby water surface; NaN elsewhere. */
function shoreLevels(t: Terrain): Float32Array {
  const nx = t.nx;
  const nz = t.nz;
  const out = new Float32Array(nx * nz).fill(NaN);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const w = t.waterSurface[j * nx + i];
      if (Number.isNaN(w)) continue;
      for (let dj = -SHORE_REACH; dj <= SHORE_REACH; dj++) {
        for (let di = -SHORE_REACH; di <= SHORE_REACH; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const k = jj * nx + ii;
          const g = t.ground[k];
          if (g === Ground.Water || g === Ground.Ford || !Number.isNaN(t.waterSurface[k])) continue;
          if (!(out[k] >= w)) out[k] = w;
        }
      }
    }
  }
  return out;
}

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
  /** Dry cells near water: the local water level (NaN elsewhere); see surfaceAt. */
  private readonly shore: Float32Array;
  /** Street grids of the towns and cities (render-side reconstruction). */
  readonly towns: TownGrid[];
  /** Buildings and landmarks; `setDetail` swaps in the town props (overview / lower tiers off). */
  readonly settlements: Settlements;

  constructor(private readonly terrain: Terrain) {
    this.heights = smoothBankHeights(terrain);
    this.shore = shoreLevels(terrain);
    this.towns = townGrids(terrain);
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
    const props = buildTownProps(terrain, this.towns, (x, z) => this.surfaceAt(x, z));
    this.settlements = buildSettlements(terrain, props);
    this.group.add(this.forests, this.scatter, this.settlements.group, buildBridges(terrain), this.buildBase());
  }

  /**
   * Height of the *rendered* ground at (x, z): the same render heights and the same triangle
   * split as the tile meshes (diagonal from (i+1, j) to (i, j+1)), so anything placed with it
   * touches the visible surface exactly. The sim's `heightAt` is bilinear on the un-eased sim
   * grid; it differs by up to a few decimetres on curved ground and by metres on eased river
   * banks. Bridge decks (road cells over water, incl. pontoons) keep the sim height: the render
   * mesh is the carved channel under them.
   */
  surfaceAt(x: number, z: number): number {
    const t = this.terrain;
    const nx = t.nx;
    const fx = Math.min(Math.max(x / t.cell, 0), nx - 1.0001);
    const fz = Math.min(Math.max(z / t.cell, 0), t.nz - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const k = j * nx + i;
    // Bridge cells: sim deck height (nearest cell, as the sim rasterises roads).
    const kn = Math.round(fz) * nx + Math.round(fx);
    if (t.ground[kn] === Ground.Road && !Number.isNaN(t.waterSurface[kn])) return t.heightAt(x, z);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    let y: number;
    if (tx + tz <= 1) y = h[k] + (h[k + 1] - h[k]) * tx + (h[k + nx] - h[k]) * tz;
    else {
      const d = h[k + nx + 1];
      y = d + (h[k + nx] - d) * (1 - tx) + (h[k + 1] - d) * (1 - tz);
    }
    // Eased banks push the drawn shoreline onto cells the sim treats as dry: keep units there
    // at the water's edge (never under the water sheet, never above the sim ground).
    const sh = this.shore[kn];
    if (!Number.isNaN(sh) && y < sh + 0.15) y = Math.min(t.heightAt(x, z), sh + 0.15);
    return y;
  }

  private buildTiles(material: THREE.Material): THREE.Group {
    const t = this.terrain;
    const a = computeTerrainAttribs(t, this.heights);
    const roadD = roadDistanceField(t);
    const townD = townField(t, this.towns);
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
        const town = new Float32Array(vx * vz * 4);
        const square = new Float32Array(vx * vz);
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
            for (let c = 0; c < 4; c++) town[k * 4 + c] = townD[src * 5 + c];
            square[k] = townD[src * 5 + 4];
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
        geo.setAttribute('aTown', new THREE.BufferAttribute(town, 4));
        geo.setAttribute('aSquare', new THREE.BufferAttribute(square, 1));
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
