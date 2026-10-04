import * as THREE from 'three';

/** Late-afternoon light: warm low sun, cool sky fill, warm earth bounce (VISUAL_UX §2.2). */
export const LIGHT = {
  sunColor: '#ffe0b5',
  sunIntensity: 2.35,
  skyColor: '#e2e4e0',
  groundColor: '#6b5a40',
  hemiIntensity: 1.0,
  /** Toward the sun: west-north-west, ~42° above the horizon (cartographic top-left light). */
  sunDir: new THREE.Vector3(-300, 335, -190).normalize(),
  /**
   * Shadowless fill from the default camera side (south-south-east, low): the key light sits
   * behind the camera, so without it every wall, hull side and uniform the player looks at is
   * in core shadow and model detail reads as a dark silhouette (2.1 visual pass).
   */
  fillColor: '#dfe6ee',
  fillIntensity: 0.55,
  fillDir: new THREE.Vector3(140, 160, 420).normalize(),
} as const;

const HAZE_COLOR = new THREE.Color('#d3c9b4');

/**
 * Dim war-room backdrop around the table: a warm vignette rather than a flat colour, so the
 * diorama reads as an object lit on a desk.
 */
export function roomBackground(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 118, 20, 128, 128, 190);
  grd.addColorStop(0, '#8f8676');
  grd.addColorStop(0.6, '#6c6457');
  grd.addColorStop(1, '#3e3932');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Subtle aerial perspective at overview zoom: linear fog along the view depth so the far side of
 * the table softens a little. Fades out completely by normal command zoom.
 */
export class Haze {
  private readonly fog = new THREE.Fog(HAZE_COLOR, 1, 2);

  constructor(private readonly scene: THREE.Scene, private readonly span: number, private readonly camDist: number) {}

  /** `ppm` = screen pixels per metre. */
  update(ppm: number): void {
    const t = Math.max(0, Math.min(1, (1.3 - ppm) / 0.9));
    if (t <= 0.01) {
      this.scene.fog = null;
      return;
    }
    this.scene.fog = this.fog;
    this.fog.near = this.camDist - this.span * 0.5;
    this.fog.far = this.camDist + this.span * (3.4 + 18 * (1 - t));
  }
}
