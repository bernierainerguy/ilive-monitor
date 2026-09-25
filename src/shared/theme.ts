import type { StripColour } from './domain/model';

export interface ThemeTokens {
  readonly id: string;
  name: string;
  mode: 'dark' | 'light';
  builtIn: boolean;
  colours: {
    background: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    danger: string;
    mute: string;
    pafl: string;
    select: string;
    sofActive: string;
    faderTrack: string;
    faderCap: string;
    /** "All good" status (e.g. rack online). Optional: defaults to the standard green. */
    ok?: string;
  };
  /** EQ band colours LF, LMF, HMF, HF. Optional: defaults to red, yellow, green, blue. */
  eqBands?: readonly [string, string, string, string];
  meter: { low: string; mid: string; high: string; clip: string; midDb: number; highDb: number; clipDb: number; background: string };
  strip: Record<StripColour, string>;
  fonts: { ui: string; mono: string; stripName: number };
  controls: { radius: number; faderCapStyle: 'classic' | 'flat'; stripWidth: number };
}

const stripPalette: Record<StripColour, string> = {
  off: '#3a3d42',
  red: '#e53935',
  green: '#43a047',
  yellow: '#fdd835',
  blue: '#1e88e5',
  purple: '#8e24aa',
  lightBlue: '#4fc3f7',
  white: '#eceff1',
};

const base: Omit<ThemeTokens, 'id' | 'name' | 'mode' | 'colours'> = {
  builtIn: true,
  meter: { low: '#2ecc71', mid: '#f1c40f', high: '#e67e22', clip: '#e74c3c', midDb: -18, highDb: -6, clipDb: -1, background: '#101214' },
  strip: stripPalette,
  fonts: { ui: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif', mono: '"SF Mono", Menlo, monospace', stripName: 12 },
  controls: { radius: 4, faderCapStyle: 'classic', stripWidth: 84 },
};

export const BUILTIN_THEMES: readonly ThemeTokens[] = [
  {
    ...base,
    id: 'dark',
    name: 'Dark',
    mode: 'dark',
    colours: {
      background: '#131517', surface: '#1c1f22', surfaceRaised: '#262a2e', border: '#33383d', text: '#e8eaed', textMuted: '#9aa0a6',
      accent: '#4fc3f7', danger: '#ef5350', mute: '#e53935', pafl: '#fdd835', select: '#4fc3f7', sofActive: '#ab47bc',
      faderTrack: '#0c0d0e', faderCap: '#cfd4d9',
    },
  },
  {
    ...base,
    id: 'light',
    name: 'Light',
    mode: 'light',
    meter: { ...base.meter, background: '#dfe3e6' },
    colours: {
      background: '#eef0f2', surface: '#ffffff', surfaceRaised: '#f5f6f7', border: '#cfd4d9', text: '#1c1f22', textMuted: '#5f6368',
      accent: '#0277bd', danger: '#c62828', mute: '#d32f2f', pafl: '#f9a825', select: '#0277bd', sofActive: '#7b1fa2',
      faderTrack: '#c7ccd1', faderCap: '#37474f',
    },
  },
  {
    ...base,
    id: 'red',
    name: 'Red (Night)',
    mode: 'dark',
    meter: { ...base.meter, low: '#b71c1c', mid: '#e53935', high: '#ff7043', background: '#0a0000' },
    // Night: nothing bright, nothing blue or white. Channel colours stay distinguishable but dim.
    strip: {
      off: '#1c0707', red: '#8e1b1b', green: '#3f4a17', yellow: '#6e4d10', blue: '#26284f', purple: '#4a1c45', lightBlue: '#1e3a40', white: '#5a3a36',
    },
    eqBands: ['#ff5252', '#ff9e40', '#d4a15a', '#e57373'],
    colours: {
      background: '#0a0000', surface: '#160303', surfaceRaised: '#220606', border: '#3d0c0c', text: '#ff8a80', textMuted: '#b0564f',
      accent: '#ff5252', danger: '#ff1744', mute: '#ff1744', pafl: '#ff9e80', select: '#ff5252', sofActive: '#ff4081',
      faderTrack: '#050000', faderCap: '#ff8a80', ok: '#7d8a36',
    },
  },
  {
    ...base,
    id: 'blue',
    name: 'Blue',
    mode: 'dark',
    colours: {
      background: '#0b1420', surface: '#11202f', surfaceRaised: '#172a3d', border: '#23405c', text: '#e3f2fd', textMuted: '#90a4ae',
      accent: '#40c4ff', danger: '#ff5252', mute: '#ff5252', pafl: '#ffd740', select: '#40c4ff', sofActive: '#b388ff',
      faderTrack: '#060c13', faderCap: '#bbdefb',
    },
  },
];

export const DEFAULT_THEME_ID = 'dark';

export const DEFAULT_EQ_BANDS = ['#ef5350', '#ffca28', '#66bb6a', '#42a5f5'] as const;

/**
 * Text colour for a lit name plate: dark on bright plates; on deep ones the theme's own
 * text colour in dark themes (so the night theme stays dim), white in light ones.
 */
export function plateInk(bg: string, t: Pick<ThemeTokens, 'mode' | 'colours'>): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg);
  if (!m) return t.colours.text;
  const n = parseInt(m[1]!, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  if (lum > 0.6) return '#101114';
  return t.mode === 'dark' ? t.colours.text : '#ffffff';
}
