/**
 * Unit conversions and the on-screen fader law.
 *
 * The fader law is a UI concern (how travel maps to dB) and is intentionally
 * independent from any protocol's wire encoding.
 */
export const FADER_MAX_DB = 10;
export const FADER_MIN_DB = -90; // below this the fader reads -inf

/** Piecewise-linear taper modelled on console faders: [position 0..1, dB]. */
const TAPER: ReadonlyArray<readonly [number, number]> = [
  [0.0, -90],
  [0.05, -60],
  [0.15, -40],
  [0.3, -30],
  [0.45, -20],
  [0.6, -10],
  [0.7, -5],
  [0.8, 0],
  [0.9, 5],
  [1.0, 10],
];

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function faderPosToDb(pos: number): number {
  const p = clamp(pos, 0, 1);
  if (p <= 0) return -Infinity;
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i]!;
    const [p0, d0] = TAPER[i - 1]!;
    if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
  }
  return FADER_MAX_DB;
}

export function dbToFaderPos(db: number): number {
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return 0;
  const d = Math.min(db, FADER_MAX_DB);
  for (let i = 1; i < TAPER.length; i++) {
    const [p1, d1] = TAPER[i]!;
    const [p0, d0] = TAPER[i - 1]!;
    if (d <= d1) return p0 + ((d - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

export function formatDb(db: number, digits = 1): string {
  if (!Number.isFinite(db) || db <= FADER_MIN_DB) return '-∞';
  const s = db.toFixed(digits);
  return db > 0 ? `+${s}` : s;
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}k` : `${Math.round(hz)}`;
}

/** Speed of sound at 20°C, used for delay distance. */
export const SPEED_OF_SOUND_M_S = 343;
export const msToMetres = (ms: number): number => (ms / 1000) * SPEED_OF_SOUND_M_S;
export const metresToMs = (m: number): number => (m / SPEED_OF_SOUND_M_S) * 1000;

export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C';
  const pct = Math.round(Math.abs(pan) * 100);
  return pan < 0 ? `L${pct}` : `R${pct}`;
}

/** Where ↑ opens a closed fader from (−60 dB + the step): audible, but well down. */
export const NUDGE_OPEN_DB = -60;

/**
 * Step a fader by `delta` dB for keyboard control. ↓ from off stays off, ↑ from off opens it from
 * NUDGE_OPEN_DB; going below the bottom of the travel closes it, and +10 dB is the top.
 */
export function nudgeFaderDb(db: number, delta: number): number {
  if (!Number.isFinite(db) && delta <= 0) return -Infinity;
  const base = Number.isFinite(db) ? db : NUDGE_OPEN_DB;
  const next = base + delta;
  if (next <= FADER_MIN_DB) return -Infinity;
  return Math.min(FADER_MAX_DB, next);
}
