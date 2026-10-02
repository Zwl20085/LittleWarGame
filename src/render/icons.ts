import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();
const canvasCache = new Map<string, HTMLCanvasElement>();

/** NATO-flavoured unit counter icon on a faction-coloured plate. `ghost` = remembered-only (hollow). */
export function unitIcon(unitType: string, color: string, roman: string, ghost = false): THREE.Texture {
  const key = `${unitType}|${color}|${ghost}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = new THREE.CanvasTexture(unitIconCanvas(unitType, color, roman, ghost));
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** A pre-scaled icon inside the shared atlas canvas. */
export interface AtlasSlot {
  readonly canvas: HTMLCanvasElement;
  readonly sx: number;
  readonly sy: number;
  readonly w: number;
  readonly h: number;
}

const ATLAS = 2048;
const atlasSlots = new Map<string, AtlasSlot>();
let atlas: HTMLCanvasElement | null = null;
let cursorX = 0;
let cursorY = 0;
let rowH = 0;

/**
 * Counter artwork pre-scaled to a device-pixel size and packed into one atlas canvas, so the
 * overlay draws thousands of counters as unscaled blits from a single source (batches well).
 */
export function unitIconSlot(unitType: string, color: string, roman: string, w: number, h: number, ghost = false): AtlasSlot {
  const key = `${unitType}|${color}|${roman}|${ghost}|${w}x${h}`;
  const hit = atlasSlots.get(key);
  if (hit) return hit;
  if (!atlas || cursorY + h + 1 > ATLAS) {
    // (Re)start a fresh atlas page when full; old slots keep their own canvas reference.
    atlas = document.createElement('canvas');
    atlas.width = ATLAS;
    atlas.height = ATLAS;
    cursorX = 0;
    cursorY = 0;
    rowH = 0;
  }
  if (cursorX + w + 1 > ATLAS) {
    cursorX = 0;
    cursorY += rowH + 1;
    rowH = 0;
  }
  const g = atlas.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(unitIconCanvas(unitType, color, roman, ghost), cursorX, cursorY, w, h);
  const slot = { canvas: atlas, sx: cursorX, sy: cursorY, w, h };
  atlasSlots.set(key, slot);
  cursorX += w + 1;
  rowH = Math.max(rowH, h);
  return slot;
}

/** Counter artwork as a 96×64 canvas (drawn into the 2D overlay). */
export function unitIconCanvas(unitType: string, color: string, roman: string, ghost = false): HTMLCanvasElement {
  const key = `${unitType}|${color}|${roman}|${ghost}`;
  const hit = canvasCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.lineWidth = 4;
  g.strokeStyle = ghost ? color : '#1f231e';
  g.fillStyle = ghost ? 'rgba(233,223,200,0.15)' : color;
  roundRect(g, 6, 8, 84, 50, 6);
  g.fill();
  g.stroke();
  g.strokeStyle = ghost ? color : '#f4ecd9';
  g.fillStyle = ghost ? color : '#f4ecd9';
  g.lineWidth = 3.5;
  const L = 14;
  const R = 82;
  const T = 15;
  const B = 51;
  const cx = 48;
  const cy = 33;
  switch (unitType) {
    case 'infantry':
      line(g, L, T, R, B); line(g, L, B, R, T); break;
    case 'motor_inf':
      // Motorized (wheeled) infantry: the infantry cross over a pair of road wheels.
      line(g, L, T, R, B - 12); line(g, L, B - 12, R, T);
      g.beginPath(); g.arc(cx - 14, B - 4, 6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + 14, B - 4, 6, 0, Math.PI * 2); g.fill();
      break;
    case 'recon':
      line(g, L, B, R, T); break;
    case 'engineer':
      line(g, L, B, L, T + 6); line(g, L, T + 6, R, T + 6); line(g, R, T + 6, R, B); line(g, cx, T + 6, cx, B); break;
    case 'mg':
      line(g, L, T, R, B); line(g, L, B, R, T); g.beginPath(); g.arc(cx, T + 4, 4, 0, Math.PI * 2); g.fill(); break;
    case 'at_gun':
      line(g, L + 8, B - 2, cx, T + 2); line(g, cx, T + 2, R - 8, B - 2); line(g, cx, T + 2, cx, B); break;
    case 'mortar':
      g.beginPath(); g.arc(cx, B - 10, 6, 0, Math.PI * 2); g.stroke(); line(g, cx, B - 16, cx, T + 2); line(g, cx - 7, T + 9, cx, T + 2); line(g, cx + 7, T + 9, cx, T + 2); break;
    case 'howitzer':
      g.beginPath(); g.arc(cx, cy, 9, 0, Math.PI * 2); g.fill(); break;
    case 'aa':
      g.beginPath(); g.arc(cx, B + 4, 26, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); line(g, cx, B - 4, cx, T + 4); break;
    case 'light_tank': case 'medium_tank': case 'heavy_tank': {
      g.beginPath(); g.ellipse(cx, cy, 26, 11, 0, 0, Math.PI * 2); g.stroke();
      if (unitType !== 'light_tank') { g.beginPath(); g.ellipse(cx, cy, 16, 5, 0, 0, Math.PI * 2); g.stroke(); }
      if (unitType === 'heavy_tank') { g.beginPath(); g.ellipse(cx, cy, 6, 2, 0, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case 'supply_truck':
      line(g, L, cy, R, cy); g.beginPath(); g.arc(cx - 16, B - 6, 5, 0, Math.PI * 2); g.arc(cx + 16, B - 6, 5, 0, Math.PI * 2); g.stroke(); break;
    case 'bunker':
      g.fillRect(cx - 18, cy - 9, 36, 18); break;
    default:
      break;
  }
  g.font = 'bold 15px "Oswald", sans-serif';
  g.fillStyle = ghost ? color : '#1f231e';
  g.textAlign = 'right';
  g.fillText(roman, 90, 7 + 4);
  canvasCache.set(key, c);
  return c;
}

function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
