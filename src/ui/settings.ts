/** Player settings shared by the title screen and the in-game pause menu (VISUAL_UX §9 "设置"). */
export interface Settings {
  readonly uiScale: number; // 0.8 – 1.5
  readonly smoke: number; // 0 – 1.5
  readonly shake: boolean;
  /** Audio volumes 0 – 1 and mute (src/audio). */
  readonly volMaster: number;
  readonly volMusic: number;
  readonly volSfx: number;
  readonly muted: boolean;
  /** Render quality: 'auto' lowers shadows/resolution when frames are slow (src/render/quality). */
  readonly quality: 'auto' | 'high' | 'medium' | 'low';
}

const KEY = 'lwg.settings';
const DEFAULTS: Settings = { uiScale: 1, smoke: 1, shake: true, volMaster: 0.8, volMusic: 0.55, volSfx: 0.8, muted: false, quality: 'auto' };
const QUALITIES: readonly Settings['quality'][] = ['auto', 'high', 'medium', 'low'];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const vol = (v: unknown, d: number): number => (Number.isFinite(Number(v ?? d)) ? clamp(Number(v ?? d), 0, 1) : d);

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      uiScale: clamp(Number(v.uiScale ?? DEFAULTS.uiScale) || 1, 0.8, 1.5),
      smoke: clamp(Number(v.smoke ?? DEFAULTS.smoke), 0, 1.5),
      shake: typeof v.shake === 'boolean' ? v.shake : DEFAULTS.shake,
      volMaster: vol(v.volMaster, DEFAULTS.volMaster),
      volMusic: vol(v.volMusic, DEFAULTS.volMusic),
      volSfx: vol(v.volSfx, DEFAULTS.volSfx),
      muted: typeof v.muted === 'boolean' ? v.muted : DEFAULTS.muted,
      quality: QUALITIES.includes(v.quality as Settings['quality']) ? (v.quality as Settings['quality']) : DEFAULTS.quality,
    };
  } catch {
    return DEFAULTS;
  }
}

let current: Settings = load();
const listeners = new Set<(s: Settings) => void>();

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage unavailable: settings still apply for this session
  }
  applyUiScale();
  for (const fn of listeners) fn(current);
  return current;
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyUiScale(): void {
  document.documentElement.style.setProperty('--ui', String(current.uiScale));
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
