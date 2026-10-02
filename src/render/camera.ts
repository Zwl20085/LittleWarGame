import * as THREE from 'three';
import { clamp } from '../sim/vec';

/**
 * Orthographic rig. Elevation is measured from the ground plane (45° default, 35°–70°,
 * VISUAL_UX §3.1); yaw rotates 360°; zoom is smoothed.
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  readonly target = new THREE.Vector3();
  yaw = Math.PI / 2;
  elevationDeg = 45;
  zoom = 1;
  private zoomGoal = 1;
  private elevGoal = 45;
  private yawGoal = Math.PI / 2;
  private readonly baseHalfHeight = 160;
  follow: (() => THREE.Vector3 | null) | null = null;
  shake = 0;

  /** Farthest zoom: the whole table fits on screen. */
  readonly minZoom: number;

  constructor(private readonly bounds: { w: number; d: number }) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 12000);
    this.minZoom = clamp((this.baseHalfHeight * 2) / (Math.max(bounds.w, bounds.d) * 0.85), 0.08, 0.35);
    this.target.set(bounds.w / 2, 0, bounds.d / 2);
  }

  resize(w: number, h: number): void {
    const aspect = w / h;
    const hh = this.baseHalfHeight;
    this.camera.left = -hh * aspect;
    this.camera.right = hh * aspect;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
  }

  setElevation(deg: number): void {
    this.elevGoal = clamp(deg, 35, 70);
  }
  get elevationGoal(): number {
    return this.elevGoal;
  }

  rotate(delta: number): void {
    this.yawGoal += delta;
  }

  /** Face the camera so that `headingRad` (sim heading) points up the screen. */
  faceHeading(headingRad: number, instant = false): void {
    this.yawGoal = headingRad + Math.PI;
    if (instant) this.yaw = this.yawGoal;
  }

  zoomBy(factor: number): void {
    this.zoomGoal = clamp(this.zoomGoal * factor, this.minZoom, 6);
  }

  setZoom(z: number): void {
    this.zoomGoal = clamp(z, this.minZoom, 6);
  }

  /** Pan in screen-aligned ground directions (metres). */
  pan(right: number, forward: number): void {
    this.follow = null;
    const fx = Math.cos(this.yaw);
    const fz = Math.sin(this.yaw);
    // Forward on screen = direction the camera looks across the ground.
    this.target.x += -fx * forward + -fz * right * -1;
    this.target.z += -fz * forward + fx * right * -1;
    this.clampTarget();
  }

  lookAt(x: number, z: number): void {
    this.target.x = x;
    this.target.z = z;
    this.clampTarget();
  }

  private clampTarget(): void {
    this.target.x = clamp(this.target.x, -50, this.bounds.w + 50);
    this.target.z = clamp(this.target.z, -50, this.bounds.d + 50);
    if (!Number.isFinite(this.target.x) || !Number.isFinite(this.target.z)) this.target.set(this.bounds.w / 2, 0, this.bounds.d / 2);
  }

  update(dt: number, groundY: (x: number, z: number) => number): void {
    const k = 1 - Math.exp(-dt * 10);
    this.zoom += (this.zoomGoal - this.zoom) * k;
    this.elevationDeg += (this.elevGoal - this.elevationDeg) * k;
    this.yaw += (this.yawGoal - this.yaw) * k;
    if (this.follow) {
      const p = this.follow();
      if (p) {
        this.target.x += (p.x - this.target.x) * k;
        this.target.z += (p.z - this.target.z) * k;
      } else this.follow = null;
    }
    this.target.y = groundY(this.target.x, this.target.z);
    const el = (this.elevationDeg * Math.PI) / 180;
    const dist = 4500;
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 3 : 0;
    const sz = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 3 : 0;
    this.camera.position.set(
      this.target.x + Math.cos(this.yaw) * Math.cos(el) * dist + sx,
      this.target.y + Math.sin(el) * dist,
      this.target.z + Math.sin(this.yaw) * Math.cos(el) * dist + sz,
    );
    this.camera.lookAt(this.target.x + sx, this.target.y, this.target.z + sz);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Ground-plane corners of the view (approximate, at target height) for the minimap. */
  viewCorners(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.target.y);
    const ray = new THREE.Raycaster();
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, p)) out.push(p);
    }
    return out;
  }
}
