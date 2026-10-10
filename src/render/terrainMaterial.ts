import * as THREE from 'three';
import { GLSL_NOISE } from './glslNoise';
import type { RoadTexture } from './roadField';
import { PAL } from './palette';

export interface TerrainUniforms {
  readonly uOverlay: { value: THREE.Texture };
  readonly uSize: { value: THREE.Vector2 };
  /** Overlay texture size in texels (for the blur taps). */
  readonly uOverlayRes: { value: THREE.Vector2 };
  readonly uTerrainLayer: { value: number };
  /** Territory tint strength (softer when zoomed in). */
  readonly uOverlayK: { value: number };
  readonly uFieldCols: { value: THREE.Color[] };
  readonly uHedge: { value: THREE.Color };
  readonly uRoad: { value: THREE.Color };
  /** Town paving: setts, kerb stone, pavement flags, square flags. */
  readonly uSett: { value: THREE.Color };
  readonly uKerb: { value: THREE.Color };
  readonly uFlag: { value: THREE.Color };
  readonly uGarden: { value: THREE.Color };
  /** Road distance texture (2.2) and its grid: (metres per texel, width, height), byte scale. */
  readonly uRoadTex: { value: THREE.Texture | null };
  readonly uRoadGrid: { value: THREE.Vector3 };
  readonly uRoadScale: { value: number };
}

const VERT_PARS = /* glsl */ `
attribute float aFarm;
attribute float aFieldAng;
attribute float aRoadD;
attribute vec4 aTown;
attribute float aSquare;
varying float vRoadD;
varying vec4 vTown;
varying float vSquare;
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
vTown = aTown;
vSquare = aSquare;
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uOverlay;
uniform vec2 uSize;
uniform vec2 uOverlayRes;
uniform float uTerrainLayer;
uniform float uOverlayK;
uniform vec3 uFieldCols[6];
uniform vec3 uHedge;
uniform vec3 uRoad;
uniform vec3 uSett;
uniform vec3 uKerb;
uniform vec3 uFlag;
uniform vec3 uGarden;
uniform sampler2D uRoadTex;
uniform vec3 uRoadGrid;
uniform float uRoadScale;
varying float vRoadD;
varying vec4 vTown;
varying float vSquare;
varying vec3 vWPos;
varying vec3 vWNor;
varying float vFarm;
varying float vFieldAng;
${GLSL_NOISE}
float th(vec2 p) { return hash12(p); }
float lineAA(float v, float width) {
  float fw = max(fwidth(v), 1e-4);
  float d = abs(fract(v - 0.5) - 0.5) / fw;
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.0, d);
}
`;

const FRAG_MAIN = /* glsl */ `
// Ground texture (2.2): the vertex colours are 4 m cells — smooth washes that read as blur once
// the camera is down among the troops. Layered value noise breaks them into tufts, patches and
// soil, each octave fading out before it is small enough to shimmer.
float mpp = length(fwidth(vWPos.xz)) * 0.7071; // metres per pixel
// Road distance per fragment from the 2 m texture (straight edges); the 4 m vertex field is the
// fallback when no texture is bound.
float roadD = uRoadGrid.x > 0.0 ? texture2D(uRoadTex, (vWPos.xz / uRoadGrid.x + 0.5) / uRoadGrid.yz).r * 255.0 / uRoadScale : vRoadD;
float flatK = smoothstep(0.55, 0.85, vWNor.y);
{
  float n0 = vnoise(vWPos.xz * 0.055 + 7.0);
  float n1 = vnoise(vWPos.xz * 0.21 + 3.0);
  float n2 = vnoise(vWPos.xz * 0.83);
  float n3 = vnoise(vWPos.xz * 2.9 + 11.0);
  float k1 = 1.0 - smoothstep(1.2, 2.4, mpp);
  float k2 = 1.0 - smoothstep(0.35, 0.7, mpp);
  float k3 = 1.0 - smoothstep(0.1, 0.2, mpp);
  float det = (n0 - 0.5) * 0.10 + (n1 - 0.5) * 0.10 * k1 + (n2 - 0.5) * 0.10 * k2 + (n3 - 0.5) * 0.08 * k3;
  diffuseColor.rgb *= 1.0 + det;
  // Large dry / lush patches shift the hue a little (sun-bleached grass vs. damp hollows).
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.02, 0.9), smoothstep(0.55, 0.8, n0) * 0.6 * flatK);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.9, 0.98, 0.88), smoothstep(0.45, 0.2, n0) * 0.5 * flatK);
  // Steep ground shows bare soil and rock through the turf.
  float bare = (1.0 - flatK) * smoothstep(0.35, 0.65, n1);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.49, 0.40) * (0.9 + 0.2 * n2), bare * 0.45);
}
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
  // Hedgerows on field borders, a wider hedge + lane on block borders: ragged bushes with crisp
  // (anti-aliased) edges up close, a soft band from afar; a little shade on the lee side.
  float bushN = vnoise(vWPos.xz * 0.42 + 5.0);
  float hw = 1.0 + 1.3 * bushN;
  float bw = 2.0 + 1.6 * bushN;
  float aE = max(fwidth(edge), 0.05) + 0.25;
  float aB = max(fwidth(blockEdge), 0.05) + 0.25;
  float hedge = max(1.0 - smoothstep(hw - aE, hw + aE, edge), (1.0 - smoothstep(bw - aB, bw + aB, blockEdge)) * 1.1);
  float lee = (1.0 - smoothstep(hw, hw + 3.5, edge)) * 0.1 + (1.0 - smoothstep(bw, bw + 4.5, blockEdge)) * 0.1;
  diffuseColor.rgb *= 1.0 - lee * vFarm;
  vec3 bush = uHedge * (0.78 + 0.4 * vnoise(vWPos.xz * 1.1 + 9.0) * (1.0 - smoothstep(0.25, 0.6, mpp)) + 0.12 * bushN);
  diffuseColor.rgb = mix(diffuseColor.rgb, bush, min(1.0, hedge) * vFarm * 0.85);
}
// Carriageway: crisp packed-earth road with darker verges and wheel ruts (fade before aliasing).
if (roadD < 30.0) {
  float d = roadD;
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
// Town streets (2.1): granite setts in transverse courses between kerbs, flagged pavements,
// garden ground inside the blocks, a flagged square with a kerb ring. The street distance is
// computed per fragment from interpolated grid coordinates (exact, crisp at any zoom).
if (vTown.z > 0.5) {
  vec2 q = vTown.xy / vTown.z;
  vec2 fq = abs(fract(q + 0.5) - 0.5) * vTown.z;
  bool alongV = fq.x < fq.y;
  float dGrid = min(fq.x, fq.y);
  // Map roads crossing the town are paved too (no course direction for them).
  float d = min(dGrid, roadD);
  float along = alongV ? vTown.y : vTown.x;
  // Streets fade out over the last metres instead of ending in a clipped rim.
  float inTown = smoothstep(-10.0, 0.0, vTown.w);
  float aa = max(fwidth(d), 0.03);
  float fine = 1.0 - smoothstep(0.12, 0.35, fwidth(along * 2.2));
  float n1 = th(floor(vec2(along * 2.2, d * 2.6)));
  float n2 = th(floor(vWPos.xz * 0.35) + 31.0);
  // Garden / yard ground deep inside the blocks, with a little plot variation.
  float yard = smoothstep(9.0, 13.0, d) * inTown;
  diffuseColor.rgb = mix(diffuseColor.rgb, uGarden * (0.9 + 0.16 * n2), yard * 0.5);
  float carriage = 1.0 - smoothstep(3.6 - aa, 3.6 + aa, d);
  float kerbIn = 1.0 - smoothstep(4.05 - aa, 4.05 + aa, d);
  float walkOut = 1.0 - smoothstep(6.0 - aa, 6.0 + aa, d);
  float course = lineAA(along / 0.42, 0.9) * fine * step(dGrid, d + 0.01);
  float gutter = 1.0 - smoothstep(0.0, 0.35, abs(d - 3.35));
  vec3 sett = uSett * (0.9 + 0.16 * n1 * fine) * (1.0 - 0.18 * course) * (1.0 - 0.12 * gutter);
  // From far away the setts lighten toward the flags so street grids do not read as dark hashes.
  sett = mix(sett, uFlag * 0.86, 0.5 * smoothstep(0.25, 1.2, aa));
  float joint = max(lineAA(along / 1.5, 0.9), lineAA((d - 4.05) / 1.0, 0.9) * step(4.5, d)) * fine;
  vec3 flag = uFlag * (0.96 + 0.07 * th(floor(vec2(along / 1.5, d)))) * (1.0 - 0.12 * joint);
  vec3 street = mix(flag, uKerb, kerbIn);
  street = mix(street, sett, carriage);
  diffuseColor.rgb = mix(diffuseColor.rgb, street, walkOut * 0.96 * inTown);
  float ds = vSquare;
  float aas = max(fwidth(ds), 0.03);
  float sq = 1.0 - smoothstep(13.0 - aas, 13.0 + aas, ds);
  float ring = sq - (1.0 - smoothstep(12.4 - aas, 12.4 + aas, ds));
  float sqCourse = lineAA(ds / 1.8, 1.0) * fine;
  vec3 sqc = uFlag * (1.04 + 0.05 * n1 * fine) * (1.0 - 0.12 * sqCourse);
  diffuseColor.rgb = mix(diffuseColor.rgb, sqc, sq);
  diffuseColor.rgb = mix(diffuseColor.rgb, uKerb * 0.92, ring);
}
// Territory wash: one texel per control cell, softened with five bilinear taps (premultiplied).
vec2 ouv = vec2(vWPos.x / uSize.x, 1.0 - vWPos.z / uSize.y);
vec2 ot = 0.9 / uOverlayRes;
vec4 ov = texture2D(uOverlay, ouv) * 0.32
  + (texture2D(uOverlay, ouv + vec2(ot.x, ot.y)) + texture2D(uOverlay, ouv + vec2(-ot.x, ot.y))
   + texture2D(uOverlay, ouv + vec2(ot.x, -ot.y)) + texture2D(uOverlay, ouv + vec2(-ot.x, -ot.y))) * 0.17;
diffuseColor.rgb = diffuseColor.rgb * (1.0 - ov.a * uOverlayK) + ov.rgb * uOverlayK;
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
export function terrainMaterial(overlay: THREE.Texture, width: number, depth: number, road: RoadTexture | null = null, overlayRes = new THREE.Vector2(width / 2.5, depth / 2.5)): { material: THREE.MeshStandardMaterial; uniforms: TerrainUniforms } {
  const rg = road?.texture.userData as { texel: number; w: number; h: number } | undefined;
  const uniforms: TerrainUniforms = {
    uOverlay: { value: overlay },
    uSize: { value: new THREE.Vector2(width, depth) },
    uOverlayRes: { value: overlayRes },
    uTerrainLayer: { value: 0 },
    uOverlayK: { value: 1 },
    uFieldCols: { value: PAL.fields.slice(0, 6) },
    uHedge: { value: PAL.hedge },
    uRoad: { value: PAL.road },
    uSett: { value: PAL.sett },
    uKerb: { value: PAL.kerb },
    uFlag: { value: PAL.flag },
    uGarden: { value: PAL.garden },
    uRoadTex: { value: road?.texture ?? null },
    uRoadGrid: { value: rg ? new THREE.Vector3(rg.texel, rg.w, rg.h) : new THREE.Vector3(0, 1, 1) },
    uRoadScale: { value: road?.scale ?? 1 },
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
  material.customProgramCacheKey = () => 'terrain-v7';
  return { material, uniforms };
}
