import type { FeatureKind, MapDef, MapFeature } from '../sim/mapdef';
import type { Terrain } from '../sim/terrain';
import { Declutter, type ScreenOverlay } from './screenOverlay';

interface Style {
  readonly font: (px: number) => string;
  readonly size: number;
  readonly color: string;
  readonly halo: string;
  readonly caps: boolean;
  readonly spacing: number;
  /** Minimum pixels-per-metre at which the label appears. */
  readonly minPpm: number;
  readonly priority: number;
  readonly symbol?: 'peak' | 'pass' | 'city' | 'town';
}

const SERIF = '"Georgia", "Times New Roman", "Songti SC", "SimSun", serif';
const SANS = '"Oswald", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const HALO = 'rgba(244,236,217,0.88)';

/** Cartographic conventions: caps for cities, italic blue for water, brown for relief. */
const STYLES: Record<FeatureKind, Style> = {
  city: { font: (px) => `700 ${px}px ${SANS}`, size: 17, color: '#23261f', halo: HALO, caps: true, spacing: 0.18, minPpm: 0, priority: 10, symbol: 'city' },
  mountain: { font: (px) => `italic 700 ${px}px ${SERIF}`, size: 15, color: '#5a3d22', halo: HALO, caps: false, spacing: 0.08, minPpm: 0, priority: 9, symbol: 'peak' },
  river: { font: (px) => `italic 600 ${px}px ${SERIF}`, size: 15, color: '#1f5878', halo: 'rgba(235,242,240,0.85)', caps: false, spacing: 0.22, minPpm: 0, priority: 8 },
  lake: { font: (px) => `italic 600 ${px}px ${SERIF}`, size: 14, color: '#1f5878', halo: 'rgba(235,242,240,0.85)', caps: false, spacing: 0.15, minPpm: 0, priority: 7 },
  town: { font: (px) => `600 ${px}px ${SANS}`, size: 13, color: '#2b2e27', halo: HALO, caps: false, spacing: 0.06, minPpm: 0.3, priority: 6, symbol: 'town' },
  hill: { font: (px) => `italic 600 ${px}px ${SERIF}`, size: 12, color: '#6b4a2b', halo: HALO, caps: false, spacing: 0.05, minPpm: 0.5, priority: 5, symbol: 'peak' },
  pass: { font: (px) => `italic 600 ${px}px ${SERIF}`, size: 12, color: '#6b4a2b', halo: HALO, caps: false, spacing: 0.05, minPpm: 0.5, priority: 5, symbol: 'pass' },
  forest: { font: (px) => `italic ${px}px ${SERIF}`, size: 12, color: '#36502a', halo: 'rgba(236,236,214,0.8)', caps: false, spacing: 0.12, minPpm: 0.7, priority: 3 },
  bridge: { font: (px) => `${px}px ${SANS}`, size: 11, color: '#3a3a33', halo: HALO, caps: false, spacing: 0.04, minPpm: 2.2, priority: 2 },
  ford: { font: (px) => `italic ${px}px ${SERIF}`, size: 11, color: '#1f5878', halo: HALO, caps: false, spacing: 0.04, minPpm: 1.6, priority: 2 },
};

const P = { x: 0, y: 0 };

interface LabelSprite {
  readonly canvas: HTMLCanvasElement;
  /** CSS-pixel size (the bitmap is dpr times larger). */
  readonly w: number;
  readonly h: number;
}

/** Map name labels drawn on the overlay, scaled with zoom and decluttered by priority. */
export class MapLabels {
  private readonly features: MapFeature[];
  private readonly declutter = new Declutter();
  /** Measured text widths by font/spacing/text (perf: no measureText per label per frame). */
  private readonly widths = new Map<string, number>();
  /** Pre-rendered label text (halo + fill) at device resolution, keyed by font/text/colour/dpr. */
  private readonly sprites = new Map<string, LabelSprite>();

  constructor(map: MapDef, private readonly terrain: Terrain) {
    const list = [...(map.features ?? [])];
    // Hand-made maps without features: at least name the capitals.
    for (const c of map.cities) {
      if (!list.some((f) => f.kind === 'city' && Math.hypot(f.pos.x - c.hq.x, f.pos.z - c.hq.z) < 200)) {
        list.push({ kind: 'city', name: c.name, pos: c.hq, radius: 120 });
      }
    }
    this.features = list.sort((a, b) => STYLES[b.kind].priority - STYLES[a.kind].priority || b.radius - a.radius);
  }

  get all(): readonly MapFeature[] {
    return this.features;
  }

  draw(o: ScreenOverlay, ppm: number, zoom: number, lang: 'zh' | 'en', avoid: Declutter | null): void {
    const g = o.ctx;
    this.declutter.clear();
    const k = Math.max(0.8, Math.min(1.45, 0.95 + 0.3 * Math.log2(Math.max(0.2, zoom))));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const f of this.features) {
      const st = STYLES[f.kind];
      if (ppm < st.minPpm) continue;
      const y = this.terrain.heightAt(f.pos.x, f.pos.z);
      if (!o.project(f.pos.x, y, f.pos.z, P) || !o.onScreen(P, 60)) continue;
      const px = Math.round(st.size * k * (f.kind === 'city' && f.radius >= 140 ? 1.15 : 1));
      const raw = f.name[lang] ?? f.name.en;
      const text = st.caps && lang === 'en' ? raw.toUpperCase() : raw;
      g.font = st.font(px);
      const spacing = `${(st.spacing * px).toFixed(1)}px`;
      (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = spacing;
      // measureText is the most expensive call per label: widths only depend on font, spacing, text.
      const wk = `${g.font}|${spacing}|${text}`;
      let tw = this.widths.get(wk);
      if (tw === undefined) {
        tw = g.measureText(text).width;
        if (this.widths.size > 4000) this.widths.clear();
        this.widths.set(wk, tw);
      }
      // Settlements: label above the centre; relief: under the peak symbol.
      const ly = st.symbol === 'peak' ? P.y + px * 0.9 : st.symbol === 'city' || st.symbol === 'town' ? P.y - px * 1.2 : P.y;
      const x0 = P.x - tw / 2 - 4;
      const x1 = P.x + tw / 2 + 4;
      if (!this.declutter.place(x0, ly - px * 0.7, x1, ly + px * 0.7)) continue;
      avoid?.place(x0, ly - px * 0.7, x1, ly + px * 0.7, true);
      this.symbol(g, st, P.x, P.y, px);
      // Text is drawn once into a cached sprite per (font, text, colour, dpr); stroke+fill of
      // ~150 labels per frame was the overlay's main cost at the overview zoom.
      const sprite = this.sprite(g.font, spacing, text, st.color, st.halo, Math.max(3, px * 0.28), o.dpr);
      g.drawImage(sprite.canvas, P.x - sprite.w / 2, ly - sprite.h / 2, sprite.w, sprite.h);
      if (f.kind === 'mountain' || f.kind === 'hill') {
        const elev = `${Math.round(y)} m`;
        const es = this.sprite(`${Math.round(px * 0.68)}px ${SANS}`, '0px', elev, st.color, st.halo, Math.max(3, px * 0.28), o.dpr);
        g.drawImage(es.canvas, P.x - es.w / 2, ly + px * 0.95 - es.h / 2, es.w, es.h);
      }
    }
    (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  }

  private sprite(font: string, spacing: string, text: string, color: string, halo: string, lineWidth: number, dpr: number): LabelSprite {
    const key = `${font}|${spacing}|${text}|${color}|${halo}|${dpr}`;
    const hit = this.sprites.get(key);
    if (hit) return hit;
    if (this.sprites.size > 1500) this.sprites.clear();
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14);
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = font;
    (measure as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = spacing;
    const tw = measure.measureText(text).width;
    const w = Math.ceil(tw + lineWidth * 2 + 6);
    const h = Math.ceil(px * 1.5 + lineWidth * 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * dpr));
    canvas.height = Math.max(1, Math.ceil(h * dpr));
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.font = font;
    (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = spacing;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.strokeStyle = halo;
    c.lineWidth = lineWidth;
    c.strokeText(text, w / 2, h / 2);
    c.fillStyle = color;
    c.fillText(text, w / 2, h / 2);
    const sprite = { canvas, w, h };
    this.sprites.set(key, sprite);
    return sprite;
  }

  private symbol(g: CanvasRenderingContext2D, st: Style, x: number, y: number, px: number): void {
    const s = px * 0.42;
    g.fillStyle = st.color;
    g.strokeStyle = st.halo;
    g.lineWidth = 2;
    switch (st.symbol) {
      case 'peak':
        g.beginPath();
        g.moveTo(x, y - s);
        g.lineTo(x + s * 0.9, y + s * 0.6);
        g.lineTo(x - s * 0.9, y + s * 0.6);
        g.closePath();
        g.stroke();
        g.fill();
        break;
      case 'pass':
        g.lineWidth = 2.2;
        g.strokeStyle = st.color;
        g.beginPath();
        g.arc(x - s * 1.1, y, s, -0.9, 0.9);
        g.stroke();
        g.beginPath();
        g.arc(x + s * 1.1, y, s, Math.PI - 0.9, Math.PI + 0.9);
        g.stroke();
        break;
      case 'city':
        g.fillStyle = '#23261f';
        g.fillRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2);
        g.strokeRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2);
        g.fillStyle = '#f4ecd9';
        g.fillRect(x - s * 0.22, y - s * 0.22, s * 0.44, s * 0.44);
        break;
      case 'town':
        g.beginPath();
        g.arc(x, y, s * 0.45, 0, Math.PI * 2);
        g.stroke();
        g.fill();
        break;
      default:
        break;
    }
  }
}
