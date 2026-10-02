import * as THREE from 'three';
import { PAL } from './palette';

export interface TerrainUniforms {
  readonly uOverlay: { value: THREE.Texture };
  readonly uSize: { value: THREE.Vector2 };
  readonly uTerrainLayer: { value: number };
  /** Territory tint strength (softer when zoomed in). */
  readonly uOverlayK: { value: number };
  readonly uFieldCols: { value: THREE.Color[] };
  readonly uHedge: { value: THREE.Color };
  readonly uRoad: { value: THREE.Color };
}

const VERT_PARS = /* glsl */ `
attribute float aFarm;
attribute float aFieldAng;
attribute float aRoadD;
varying float vRoadD;
varying vec3 vWPos;
varying vec3 vWNor;
varying float vFarm;
varying float vFieldAng;
`;

const VERT_MAIN = /* glsl */ `
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNor = normalize(mat3(modelMatrix) * objectNormal);
vFarm = aFarm;
vFieldAng = aFieldAng;
vRoadD = aRoadD;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uOverlay;
uniform vec2 uSize;
uniform float uTerrainLayer;
uniform float uOverlayK;
uniform vec3 uFieldCols[6];
uniform vec3 uHedge;
uniform vec3 uRoad;
varying float vRoadD;
varying vec3 vWPos;
varying vec3 vWNor;
varying float vFarm;
varying float vFieldAng;
float th(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lineAA(float v, float width) {
  float fw = max(fwidth(v), 1e-4);
  float d = abs(fract(v - 0.5) - 0.5) / fw;
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.0, d);
}
`;

const FRAG_MAIN = /* glsl */ `
// Field patchwork (crisp at any zoom): rotated grid, hashed crop colour, hedgerows, furrows.
if (vFarm > 0.02) {
  // Farm blocks (~260 m, wavy lane borders) each keep one field orientation, so the patchwork
  // never fans or bends (a per-vertex angle would curve the furrows).
  vec2 wq = vWPos.xz + vec2(sin(vWPos.z / 230.0) * 9.0, sin(vWPos.x / 260.0) * 9.0);
  vec2 blk = floor(wq / 260.0);
  vec2 bf = fract(wq / 260.0) * 260.0;
  float blockEdge = min(min(bf.x, 260.0 - bf.x), min(bf.y, 260.0 - bf.y));
  float ang = (th(blk + 17.0) - 0.5) * 1.6;
  float ca = cos(ang), sa = sin(ang);
  vec2 p = vec2(ca * vWPos.x + sa * vWPos.z, -sa * vWPos.x + ca * vWPos.z);
  float row = floor(p.y / 48.0);
  vec2 size = vec2(60.0 + 70.0 * th(vec2(row, 3.0) + blk), 48.0);
  p.x += th(vec2(row, 7.0) + blk) * size.x;
  vec2 cellId = floor(p / size);
  float hsh = th(cellId + blk * 7.0);
  int ci = int(floor(hsh * 5.999));
  vec3 fc = uFieldCols[0];
  for (int i = 1; i < 6; i++) if (i == ci) fc = uFieldCols[i];
  vec2 f = fract(p / size) * size;
  float edge = min(min(f.x, size.x - f.x), min(f.y, size.y - f.y));
  // Crop rows / plough furrows, along or across the field; faded out before they can alias.
  float rowCoord = (hsh > 0.5 ? p.y : p.x) * 1.6;
  float rowAA = 1.0 - smoothstep(0.25, 0.6, fwidth(rowCoord));
  float furrow = 1.0 + (0.035 + 0.05 * step(0.66, fract(hsh * 7.3))) * sin(rowCoord * 6.2832) * rowAA;
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11)) / 0.32;
  vec3 crop = fc * furrow * clamp(lum, 0.75, 1.15);
  diffuseColor.rgb = mix(diffuseColor.rgb, crop, vFarm * 0.8);
  // Hedgerows on field borders, a slightly wider darker hedge + lane on block borders.
  float hedge = max(1.0 - smoothstep(0.8, 2.2, edge), (1.0 - smoothstep(1.4, 3.2, blockEdge)) * 1.1);
  diffuseColor.rgb = mix(diffuseColor.rgb, uHedge, min(1.0, hedge) * vFarm * 0.78);
}
// Carriageway: crisp packed-earth road with darker verges and wheel ruts (fade before aliasing).
if (vRoadD < 30.0 && vRoadD > -30.0) {
  float d = abs(vRoadD);
  float aa = max(fwidth(d), 0.02);
  float onRoad = 1.0 - smoothstep(3.9 - aa, 3.9 + aa, d);
  float n = th(floor(vWPos.xz * 1.3));
  vec3 rc = uRoad * (0.95 + 0.07 * n);
  // Ruts: worn wheel tracks either side of the crown, only when they are a few pixels wide.
  float rutAA = 1.0 - smoothstep(0.08, 0.22, aa);
  float rut = 1.0 - smoothstep(0.2, 0.5, abs(d - 2.4));
  rc *= 1.0 - 0.13 * rut * rutAA;
  // Crown is a touch lighter; the verge where grass meets the road is darker and worn.
  rc *= 1.0 + 0.05 * (1.0 - smoothstep(0.0, 1.5, d));
  diffuseColor.rgb = mix(diffuseColor.rgb, rc, onRoad * 0.92);
  float verge = smoothstep(3.6, 4.1, d) * (1.0 - smoothstep(4.3, 5.6, d));
  diffuseColor.rgb *= 1.0 - 0.14 * verge;
}
vec4 ov = texture2D(uOverlay, vec2(vWPos.x / uSize.x, 1.0 - vWPos.z / uSize.y));
diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * uOverlayK);
if (uTerrainLayer > 0.5) {
  // Paper-map reading of the ground: wash, contours every 10 m (index every 50 m), steep hatch.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.74, 0.62), 0.35);
  float slope = degrees(acos(clamp(vWNor.y, 0.0, 1.0)));
  float steep = smoothstep(17.0, 19.0, slope);
  float hatch = lineAA((vWPos.x + vWPos.z) / 7.0, 1.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.13, 0.07), steep * (0.15 + 0.45 * hatch));
  float minor = lineAA(vWPos.y / 10.0, 1.0);
  float major = lineAA(vWPos.y / 50.0, 2.2);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.17, 0.07), max(minor * 0.5, major * 0.9));
}
`;

/** Matte vertex-coloured ground with shader-side fields, the overlay map and the terrain layer. */
export function terrainMaterial(overlay: THREE.Texture, width: number, depth: number): { material: THREE.MeshStandardMaterial; uniforms: TerrainUniforms } {
  const uniforms: TerrainUniforms = {
    uOverlay: { value: overlay },
    uSize: { value: new THREE.Vector2(width, depth) },
    uTerrainLayer: { value: 0 },
    uOverlayK: { value: 1 },
    uFieldCols: { value: PAL.fields.slice(0, 6) },
    uHedge: { value: PAL.hedge },
    uRoad: { value: PAL.road },
  };
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_MAIN}`);
  };
  material.customProgramCacheKey = () => 'terrain-v3';
  return { material, uniforms };
}
