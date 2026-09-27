import { mixLayout, parseMixConfig } from '@shared/mixLayout';
import type { RackNames } from '@shared/rack';

/** The names a rack set up with this mix configuration gives its channels: one per mix, both halves of a stereo one. */
export function rackNamesFor(mixConfig: unknown): RackNames {
  const mixes: Array<string | null> = Array.from({ length: 32 }, () => null);
  const cfg = parseMixConfig(mixConfig);
  if (cfg) mixLayout(cfg).slots.forEach((s, i) => s.channels.forEach((ch) => (mixes[ch - 0x60] = `${s.role}${i}`)));
  return { mixes, fx: Array.from({ length: 8 }, (_, i) => `FX${i + 1}`) };
}
