import * as THREE from 'three';
import { WIND } from './effects';

/** Shared clock for every flag's cloth wave (advanced by the renderer in real time). */
export const FLAG_TIME = { value: 0 };

const FLAG_W = 6;
const FLAG_H = 3.6;
/** Flags stream downwind, matching the drift of the battlefield smoke. */
const WIND_YAW = -Math.atan2(WIND.z, WIND.x);

let flagGeo: THREE.BufferGeometry | null = null;

function geometry(): THREE.BufferGeometry {
  if (!flagGeo) {
    // Hoist edge at x = 0 so the cloth hangs from the pole.
    flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 12, 2).translate(FLAG_W / 2, 0, 0);
  }
  return flagGeo;
}

/**
 * Matte cloth flag: a travelling wave along the fly, growing from the hoist, with a little
 * droop at the free end. Per-flag phase comes from its world position (no per-flag uniforms).
 */
export function clothFlag(color: THREE.ColorRepresentation): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 1 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlagTime = FLAG_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFlagTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float fly = clamp(position.x / ${FLAG_W.toFixed(1)}, 0.0, 1.0);
        float ph = modelMatrix[3].x * 0.13 + modelMatrix[3].z * 0.07;
        transformed.z += sin(position.x * 1.15 - uFlagTime * 5.5 + ph) * 0.42 * fly
          + sin(position.x * 2.3 + position.y * 0.8 - uFlagTime * 8.0 + ph) * 0.12 * fly;
        transformed.y -= fly * fly * 0.35;`,
      );
  };
  mat.customProgramCacheKey = () => 'cloth-flag';
  const mesh = new THREE.Mesh(geometry(), mat);
  mesh.rotation.y = WIND_YAW;
  mesh.castShadow = true;
  return mesh;
}
