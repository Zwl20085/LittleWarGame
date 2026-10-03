import * as THREE from 'three';
import { CONTESTED, NEUTRAL, type FrontlineField } from '../sim/frontline';
import type { MapFeature } from '../sim/mapdef';
import type { Match } from '../sim/sim';
import type { Ground } from '../sim/terrain';
import type { V2 } from '../sim/vec';
import { lang } from '../ui/i18n';
import { Haze, LIGHT, roomBackground } from './atmosphere';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { MapLabels } from './mapLabels';
import { ObjectiveMarkers } from './objectiveMarkers';
import { QualityGovernor, type QualityLevel, type QualityMode } from './quality';
import { OpArrows } from './opArrows';
import { clothFlag, FLAG_TIME } from './flags';
import { FieldWorks, isLineWork } from './fieldWorks';
import { FrontLines } from './frontLines';
import { fortModel } from './models';
import { PontoonView } from './pontoon';
import { ScreenOverlay } from './screenOverlay';
import { TerrainView } from './terrainView';
import { UnitCounters } from './unitCounters';
import { UnitViews } from './unitViews';

export interface Layers {
  front: boolean;
  supply: boolean;
  ranges: boolean;
  sectors: boolean;
  /** Contours, impassable water, fords and steep (vehicle-impassable) slopes. */
  terrain: boolean;
}

/** Ground conditions under a map point (UI tooltips / terrain readout). */
export interface TerrainInfo {
  readonly height: number;
  readonly slopeDeg: number;
  readonly ground: Ground;
  readonly cover: 0 | 1 | 2 | 3;
  /** Vehicles cannot climb slopes above this (VISUAL terrain layer marks them). */
  readonly steep: boolean;
  readonly feature?: MapFeature;
}

/** Slope (deg) above which the terrain layer marks ground as vehicle-impassable. */
export const STEEP_SLOPE_DEG = 18;

const ORDER_RING = new THREE.RingGeometry(2.5, 4, 24).rotateX(-Math.PI / 2);

/** Owns the Three.js scene for one match. Reads sim state; never mutates it. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly terrainView: TerrainView;
  readonly units: UnitViews;
  readonly effects: Effects;
  readonly layers: Layers = { front: true, supply: false, ranges: false, sectors: true, terrain: false };
  readonly overlay: ScreenOverlay;
  private readonly counters: UnitCounters;
  private readonly sun: THREE.DirectionalLight;
  /** Unit vector toward the sun (afternoon light from the north-west). */
  private readonly sunDir = LIGHT.sunDir.clone();
  private readonly haze: Haze;
  private readonly objectiveMarkers: ObjectiveMarkers;
  private readonly fortViews = new Map<number, THREE.Group>();
  private readonly pontoonViews = new Map<number, PontoonView>();
  private readonly fieldWorks: FieldWorks;
  private readonly opArrows: OpArrows;
  private readonly overlayGroup = new THREE.Group();
  private readonly orderMarkers: { mesh: THREE.Mesh; life: number }[] = [];
  private frontVersion = -1;
  private readonly raycaster = new THREE.Raycaster();
  private readonly labels: MapLabels;
  private overlayTimer = 0;
  private overlayKey = '';
  playerId = 0;
  /** Spectating: operation arrows are drawn for every faction (thinner). */
  spectator = false;
  private lastFrameAt = performance.now();
  private shadowTick = 0;
  fog = false;
  /** Render quality tier (auto mode steps down when the frame rate drops). */
  private readonly quality = new QualityGovernor();
  /** Called when auto mode lowers the tier (the HUD shows a notice). */
  onQualityChange: ((level: QualityLevel) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly match: Match) {
    const w = match.world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = roomBackground();

    this.rig = new CameraRig({ w: w.terrain.width, d: w.terrain.depth });
    this.haze = new Haze(this.scene, Math.max(w.terrain.width, w.terrain.depth) / 2, 4500);
    const hemi = new THREE.HemisphereLight(LIGHT.skyColor, LIGHT.groundColor, LIGHT.hemiIntensity);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(LIGHT.sunColor, LIGHT.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    const sc = this.sun.shadow.camera;
    sc.left = -260;
    sc.right = 260;
    sc.top = 260;
    sc.bottom = -260;
    sc.near = 10;
    sc.far = 1500;
    this.scene.add(this.sun, this.sun.target);

    this.terrainView = new TerrainView(w.terrain);
    this.scene.add(this.terrainView.group);
    this.units = new UnitViews(w);
    this.scene.add(this.units.group);
    this.overlay = new ScreenOverlay(canvas);
    this.counters = new UnitCounters(w, this.units);
    this.labels = new MapLabels(w.map, w.terrain);
    this.effects = new Effects((x, z) => w.terrain.heightAt(x, z));
    this.scene.add(this.effects.group, this.overlayGroup, this.frontLines.mesh);
    this.units.onWreckFire = (x, y, z, k) => this.effects.wreckFire(x, y, z, k);
    this.units.onTrackDust = (x, y, z, h) => this.effects.trackDust(x, y, z, h);
    this.effects.onBigMuzzle = (x, z) => this.units.recoilAt(x, z);
    this.effects.setTowns(w.objectives.filter((o) => o.kind !== 'point').map((o) => ({ x: o.pos.x, z: o.pos.z, r: Math.max(30, o.radius), y: w.terrain.heightAt(o.pos.x, o.pos.z) })));
    this.fieldWorks = new FieldWorks(w.terrain, (owner) => w.factions[owner]?.color ?? '#888888');
    this.scene.add(this.fieldWorks.group);
    this.opArrows = new OpArrows((x, z) => w.terrain.heightAt(x, z));
    this.scene.add(this.opArrows.mesh);
    this.objectiveMarkers = new ObjectiveMarkers(w.objectives, w.terrain);
    this.scene.add(this.objectiveMarkers.group);
    this.buildCities();
    this.freezeStatic();
  }

  /**
   * Everything built once (terrain chunks, buildings, trees, markers, city blocks) never moves:
   * mark it static so Three.js skips recomposing ~1 000 matrices every frame.
   */
  private freezeStatic(): void {
    for (const root of [this.terrainView.group, this.objectiveMarkers.group]) {
      root.traverse((o) => {
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      });
    }
    this.scene.updateMatrixWorld(true);
  }

  private buildCities(): void {
    const w = this.match.world;
    for (const f of w.factions) {
      const c = w.cityOf(f.id);
      const y = w.terrain.heightAt(c.hq.x, c.hq.z);
      const g = new THREE.Group();
      const stone = new THREE.MeshStandardMaterial({ color: '#cfc6b0', roughness: 0.95 });
      const roof = new THREE.MeshStandardMaterial({ color: '#5f5a52', roughness: 0.9 });
      const main = new THREE.Mesh(new THREE.BoxGeometry(22, 12, 16), stone);
      main.position.y = 6;
      const top = new THREE.Mesh(new THREE.BoxGeometry(24, 2, 18), roof);
      top.position.y = 13;
      const tower = new THREE.Mesh(new THREE.BoxGeometry(6, 22, 6), stone);
      tower.position.set(6, 11, 0);
      const flag = clothFlag(f.color);
      flag.scale.setScalar(1.35);
      flag.position.set(6, 28.5, 0);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 10, 6), roof);
      pole.position.set(6, 26, 0);
      for (const m of [main, top, tower, flag, pole]) {
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      g.position.set(c.hq.x, y, c.hq.z);
      g.rotation.y = -(c.forwardDeg * Math.PI) / 180;
      flag.rotation.y -= g.rotation.y; // stream with the world wind, not the building axis
      const ring = new THREE.Mesh(new THREE.RingGeometry(33.5, 35, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.7, depthWrite: false }));
      ring.position.set(c.hq.x, y + 1.2, c.hq.z);
      this.scene.add(g, ring);
    }
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
    this.overlay.resize(w, h, Math.min(2, window.devicePixelRatio));
  }

  /**
   * Mouse NDC → terrain surface by marching the camera ray against the heightfield
   * (VISUAL_UX §3.2 — no screen-ratio mapping). Null when the ray misses the table.
   */
  groundAt(ndc: THREE.Vector2): V2 | null {
    const t = this.match.world.terrain;
    this.raycaster.setFromCamera(ndc, this.rig.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    if (d.y >= -1e-4) return null;
    const top = t.maxHeight + 5;
    let s0 = Math.max(0, (o.y - top) / -d.y);
    const s1 = (o.y + 5) / -d.y;
    const step = 1.5;
    const above = (s: number): boolean => o.y + d.y * s > t.heightAt(o.x + d.x * s, o.z + d.z * s);
    for (let s = s0; s <= s1; s += step) {
      if (above(s)) {
        s0 = s;
        continue;
      }
      let lo = s0;
      let hi = s;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (above(mid)) lo = mid;
        else hi = mid;
      }
      const x = o.x + d.x * hi;
      const z = o.z + d.z * hi;
      return t.inBounds(x, z) ? { x, z } : null;
    }
    return null;
  }

  /** Height, slope, ground type, cover and the named feature under a map point. */
  terrainInfoAt(p: V2): TerrainInfo {
    const t = this.match.world.terrain;
    const slopeDeg = t.slopeAt(p.x, p.z);
    let feature: MapFeature | undefined;
    let best = Infinity;
    for (const f of this.labels.all) {
      const d = Math.hypot(f.pos.x - p.x, f.pos.z - p.z);
      if (d <= f.radius && f.radius < best) {
        best = f.radius;
        feature = f;
      }
    }
    return { height: t.heightAt(p.x, p.z), slopeDeg, ground: t.groundAt(p.x, p.z), cover: t.coverAt(p.x, p.z), steep: slopeDeg > STEEP_SLOPE_DEG, feature };
  }

  orderMarker(p: V2, color: string): void {
    const y = this.match.world.terrain.heightAt(p.x, p.z);
    const mesh = new THREE.Mesh(ORDER_RING, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
    mesh.position.set(p.x, y + 0.6, p.z);
    this.scene.add(mesh);
    this.orderMarkers.push({ mesh, life: 0 });
  }

  private syncObjectives(): void {
    const w = this.match.world;
    const rules = w.data.rules;
    // Capture time depends on the settlement kind (the arc used to assume the point rule).
    this.objectiveMarkers.sync(w.objectives, w.factions, (o) => rules.territory?.capture_seconds[o.kind] ?? rules.victory.point_capture_seconds);
  }

  private syncForts(dt: number): void {
    const w = this.match.world;
    const seen = new Set<number>();
    // Trenches and barricades (including wrecked ones) are batched separately.
    this.fieldWorks.sync(w.forts, w.time);
    for (let i = 0; i < this.fieldWorks.siteCount; i++) this.effects.workSite(this.fieldWorks.sites[i], dt);
    for (const f of w.forts) {
      if (f.hp <= 0 || isLineWork(f.kind)) continue;
      seen.add(f.id);
      if (f.kind === 'pontoon') {
        let pv = this.pontoonViews.get(f.id);
        if (!pv) {
          pv = new PontoonView(f, w.terrain);
          this.scene.add(pv.group);
          this.pontoonViews.set(f.id, pv);
        }
        pv.update(f.progress);
        if (pv.building) this.effects.workSite(pv.tip, dt);
        continue;
      }
      let v = this.fortViews.get(f.id);
      if (!v) {
        v = fortModel(f.kind);
        v.position.set(f.pos.x, w.terrain.heightAt(f.pos.x, f.pos.z), f.pos.z);
        v.rotation.y = -f.facing;
        v.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        this.scene.add(v);
        this.fortViews.set(f.id, v);
      }
      v.scale.set(1, Math.max(0.15, f.progress), 1);
    }
    for (const [id, v] of this.fortViews) if (!seen.has(id)) { this.scene.remove(v); this.fortViews.delete(id); }
    for (const [id, v] of this.pontoonViews) if (!seen.has(id)) { v.dispose(); this.pontoonViews.delete(id); }
  }

  private readonly fieldCanvas = document.createElement('canvas');
  private readonly frontLines = new FrontLines();

  /**
   * Paint the control field: a soft translucent fill per owner (the 10 m grid drawn small, then
   * upscaled with blur — no blocky cells) plus crisp ink contact lines (FrontLines).
   */
  private paintFront(field: FrontlineField): void {
    if (field.version === this.frontVersion) return;
    this.frontVersion = field.version;
    const cv = this.terrainView.overlayCanvas;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    if (!this.layers.front) {
      this.terrainView.overlayTex.needsUpdate = true;
      this.frontLines.clear();
      return;
    }
    const nx = field.nx;
    const nz = field.nz;
    if (this.fieldCanvas.width !== nx) { this.fieldCanvas.width = nx; this.fieldCanvas.height = nz; }
    const fill = this.fieldCanvas.getContext('2d')!.createImageData(nx, nz);
    const w = this.match.world;
    const cols = w.factions.map((f) => new THREE.Color(f.color));
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const o = field.owner[j * nx + i];
        const k = (j * nx + i) * 4;
        if (o === NEUTRAL) continue;
        if (o === CONTESTED) {
          fill.data[k] = 235; fill.data[k + 1] = 195; fill.data[k + 2] = 95; fill.data[k + 3] = 48;
          continue;
        }
        const c = cols[o];
        fill.data[k] = c.r * 255; fill.data[k + 1] = c.g * 255; fill.data[k + 2] = c.b * 255; fill.data[k + 3] = 40;
      }
    }
    this.fieldCanvas.getContext('2d')!.putImageData(fill, 0, 0);
    g.imageSmoothingEnabled = true;
    g.filter = 'blur(6px)';
    g.drawImage(this.fieldCanvas, 0, 0, cv.width, cv.height);
    g.filter = 'none';
    this.terrainView.overlayTex.needsUpdate = true;
    this.frontLines.rebuild(field, cols, (x, z) => w.terrain.heightAt(x, z));
  }

  /** Rebuild route/supply/range lines a few times a second (not every frame), disposing the old ones. */
  private drawOverlays(realDt: number): void {
    const key = `${this.layers.sectors}|${this.layers.supply}|${this.layers.ranges}|${[...this.units.selected].join(',')}`;
    this.overlayTimer -= realDt;
    if (this.overlayTimer > 0 && key === this.overlayKey) return;
    this.overlayTimer = 0.25;
    this.overlayKey = key;
    for (const o of this.overlayGroup.children) {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.overlayGroup.clear();
    const w = this.match.world;
    const f = w.factions[this.playerId];
    if (!f) return;
    const mk = (pts: THREE.Vector3[], color: string, dashed: boolean, opacity = 0.9): THREE.Line => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 4, transparent: true, opacity, depthTest: false })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
      const l = new THREE.Line(geo, mat);
      if (dashed) l.computeLineDistances();
      l.renderOrder = 5;
      return l;
    };
    const lift = (p: V2, dy = 2): THREE.Vector3 => new THREE.Vector3(p.x, w.terrain.heightAt(p.x, p.z) + dy, p.z);
    const along = (a: V2, b: V2, dy = 2): THREE.Vector3[] => {
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 15));
      return Array.from({ length: n + 1 }, (_, k) => lift({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }, dy));
    };
    if (this.layers.sectors && f.alive) {
      const exit = w.cityOf(f.id).exit;
      for (const s of f.sectors) {
        const main = s.id === f.mainSector;
        this.overlayGroup.add(mk(along(exit, s.rally, 3).concat(along(s.rally, s.targetPos, 3)), main ? '#f4ecd9' : '#d8cfb8', true, main ? 0.95 : 0.6));
        const tip = lift(s.targetPos, 3);
        const head = new THREE.Mesh(new THREE.ConeGeometry(4, 9, 3), new THREE.MeshBasicMaterial({ color: '#f4ecd9', depthTest: false, transparent: true, opacity: 0.9 }));
        head.position.copy(tip).setY(tip.y + 8);
        head.rotation.x = Math.PI;
        head.renderOrder = 6;
        this.overlayGroup.add(head);
      }
    }
    if (this.layers.supply) {
      const nodes = this.match.supplyNodes[this.playerId] ?? [];
      for (const n of nodes) {
        if (n.parent) this.overlayGroup.add(mk(along(n.parent, n.pos, 2.5), n.cut ? '#a63f36' : '#e0c070', n.cut, 0.9));
        if (n.radius > 0) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(n.radius - 1.5, n.radius, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#e0c070', transparent: true, opacity: 0.35, depthTest: false }));
          ring.position.set(n.pos.x, w.terrain.heightAt(n.pos.x, n.pos.z) + 2, n.pos.z);
          this.overlayGroup.add(ring);
        }
      }
    }
    if (this.layers.ranges) {
      for (const id of this.units.selected) {
        const u = w.unitAlive(id);
        if (!u?.primary) continue;
        for (const r of [u.primary.range, u.primary.minRange]) {
          if (r <= 0) continue;
          const pts: THREE.Vector3[] = [];
          for (let k = 0; k <= 72; k++) {
            const a = (k / 72) * Math.PI * 2;
            pts.push(lift({ x: u.pos.x + Math.cos(a) * r, z: u.pos.z + Math.sin(a) * r }, 1.5));
          }
          this.overlayGroup.add(mk(pts, r === u.primary.minRange ? '#a63f36' : '#f4ecd9', r === u.primary.minRange, 0.8));
        }
      }
    }
    // Manual task destinations of selected units.
    for (const id of this.units.selected) {
      const u = w.unitAlive(id);
      if (!u?.manual) continue;
      const m = u.manual;
      const dest = m.type === 'move' || m.type === 'attackMove' ? m.dest : m.type === 'hold' ? m.pos : null;
      if (dest) this.overlayGroup.add(mk(along(u.pos, dest, 1.5), m.type === 'attackMove' ? '#e08050' : '#9fd08a', true, 0.8));
    }
  }

  frame(alpha: number, dt: number): void {
    const w = this.match.world;
    for (const e of w.fx) this.effects.handle(e);
    w.fx.length = 0;
    this.rig.shake = this.effects.shake;
    // Camera eases in real time so it still responds while the sim is paused.
    const now = performance.now();
    const realDt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    const stepped = this.quality.update((now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    if (stepped !== null) {
      this.applyQuality();
      this.onQualityChange?.(stepped);
    }
    this.rig.update(realDt, (x, z) => w.terrain.heightAt(x, z));
    // Shadow camera follows the view target.
    const t = this.rig.target;
    const ext = Math.min(1700, 300 / this.rig.zoom);
    const sc = this.sun.shadow.camera;
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
    sc.far = 3000 + ext * 2;
    sc.updateProjectionMatrix();
    const back = 1500 + ext;
    this.sun.position.set(t.x - this.sunDir.x * -back, t.y + this.sunDir.y * back, t.z - this.sunDir.z * -back);
    this.sun.target.position.copy(t);
    const ppm = this.pixelsPerMetre();
    this.effects.pxPerM = ppm;
    this.haze.update(ppm);
    const q = this.quality.profile;
    this.terrainView.scatter.visible = ppm > 1 && q.scatter;
    this.frontLines.update(realDt, ppm);
    this.opArrows.sync(w, this.playerId, this.spectator, this.layers.sectors);
    this.opArrows.update(ppm);
    FLAG_TIME.value += realDt;
    this.terrainView.uniforms.uOverlayK.value = ppm > 4 ? 0.5 : ppm > 1.5 ? 0.8 : 1;
    this.units.showSoldiers = ppm > 0.7;
    this.units.setSoldierShadows(ppm > 3.5 && q.soldierShadows);
    // Far zoom: the shadow map barely changes on screen — refresh it a few times a second.
    this.shadowTick++;
    const far = ppm < 1;
    this.renderer.shadowMap.autoUpdate = !far;
    if (far && this.shadowTick % 8 === 0) this.renderer.shadowMap.needsUpdate = true;
    this.units.sync(alpha, dt, this.rig.camera, this.playerId, this.fog);
    this.rig.camera.getWorldDirection(this.effects.viewDir);
    this.effects.syncProjectiles(w.projectiles, alpha, dt);
    this.effects.update(dt);
    this.syncObjectives();
    this.syncForts(dt);
    this.paintFront(this.match.frontView ?? this.match.front);
    this.drawOverlays(realDt);
    for (let i = this.orderMarkers.length - 1; i >= 0; i--) {
      const m = this.orderMarkers[i];
      m.life += realDt;
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - m.life;
      m.mesh.scale.setScalar(1 + m.life);
      if (m.life > 1) {
        this.scene.remove(m.mesh);
        (m.mesh.material as THREE.Material).dispose();
        this.orderMarkers.splice(i, 1);
      }
    }
    const mapMode = this.layers.terrain;
    this.terrainView.uniforms.uTerrainLayer.value = mapMode ? 1 : 0;
    this.terrainView.water.update(realDt, this.rig.camera, this.sunDir, mapMode);
    this.renderer.render(this.scene, this.rig.camera);
    this.overlay.begin(this.rig.camera);
    this.labels.draw(this.overlay, ppm, this.rig.zoom, lang(), null);
    this.counters.draw(this.overlay, ppm, this.playerId, this.fog);
  }

  /** Player setting: fixed tier, or auto (start high, step down on slow frames). */
  setQualityMode(mode: QualityMode): void {
    this.quality.setMode(mode);
    this.applyQuality();
  }

  private applyQuality(): void {
    const q = this.quality.profile;
    this.renderer.setPixelRatio(Math.min(q.maxPixelRatio, window.devicePixelRatio));
    const shadows = q.shadowMap > 0;
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      // Materials bake the shadow-map define: force a recompile.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    this.sun.castShadow = shadows;
    if (shadows && this.sun.shadow.mapSize.x !== q.shadowMap) {
      this.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
  }

  /** CSS pixels per metre at the current zoom. */
  pixelsPerMetre(): number {
    const cam = this.rig.camera;
    return this.overlay.h / ((cam.top - cam.bottom) / cam.zoom);
  }

  forceFrontRepaint(): void {
    this.frontVersion = -1;
  }

  dispose(): void {
    this.objectiveMarkers.dispose();
    this.overlay.dispose();
    this.renderer.dispose();
  }
}
