/**
 * Shared GLSL noise. The classic `fract(sin(dot(p, …)) * 43758.5)` hash breaks down on GPUs
 * once its argument reaches the hundreds of thousands (world coordinates in metres × a few):
 * `sin` loses precision and the "random" field turns into visible contour bands (the 2.1
 * river showed circuit-board patterns). This hash uses only `fract` and products, which stay
 * well-behaved for coordinates up to ~1e5.
 */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;
