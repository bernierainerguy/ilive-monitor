import { mixChannelCount, mixConfigError, mixLayout, type RackMixConfig } from './mixLayout';

/**
 * Reading the rack's mix configuration from its mix-channel names.
 *
 * MIDI can't report the configuration, but the rack answers a name query for every mix channel it uses, in its
 * own order: mono groups, stereo groups, mono auxes, stereo auxes, main (2 or 4 channels), mono matrices, stereo
 * matrices. Both halves of a stereo mix carry the same name. That shows most of the layout. It can't show:
 *  - groups from auxes (both come before the main, in the same shapes), so mono and stereo mixes before the main
 *    are read as auxes unless there are two separate runs of each;
 *  - FX sends, which have send buses but no mix channels.
 * Both decide which send number reaches which aux, so the operator confirms them before saving.
 */

export interface MixConfigReading {
  /** The best reading. FX counts are carried over from `current` (or 0): names can't show them. */
  config: RackMixConfig;
  /** The names followed the rack's order cleanly. False: fill in by hand, using the names as a guide. */
  clean: boolean;
  /** Plain-language points for the operator to check. */
  notes: string[];
}

const MAIN_RE = /^(main|mst|master|l\s*\/?\s*r\b|st(ereo)?\s*mix|foh)/i;
const MAIN_MONO_RE = /(mono|sub|centre|center|\bm$|\bc$)/i;

type Run = { stereo: boolean; count: number };

/** Split channel names into alternating runs of mono channels and stereo pairs (a pair = two equal names). */
function runs(names: string[]): Run[] {
  const out: Run[] = [];
  let i = 0;
  while (i < names.length) {
    const stereo = i + 1 < names.length && names[i] === names[i + 1];
    const last = out[out.length - 1];
    if (last && last.stereo === stereo) last.count++;
    else out.push({ stereo, count: 1 });
    i += stereo ? 2 : 1;
  }
  return out;
}

/** Fit runs onto slot shapes, right-aligned (so a lone mono run is auxes, not groups). Null if they don't fit. */
function fit(rs: Run[], shapes: boolean[]): number[] | null {
  const counts = shapes.map(() => 0);
  let slot = shapes.length - 1;
  for (let r = rs.length - 1; r >= 0; r--) {
    while (slot >= 0 && shapes[slot] !== rs[r]!.stereo) slot--;
    if (slot < 0) return null;
    counts[slot] = rs[r]!.count;
    slot--;
  }
  return counts;
}

export function suggestMixConfig(mixNames: Array<string | null>, current?: RackMixConfig): MixConfigReading {
  const used = mixNames.reduce((n, name, i) => (name !== null ? i + 1 : n), 0);
  const names = mixNames.slice(0, used).map((n) => n ?? '');
  const fx = { monoFx: current?.monoFx ?? 0, stereoFx: current?.stereoFx ?? 0 };
  const notes: string[] = [];
  const blank: RackMixConfig = {
    monoGroups: 0, stereoGroups: 0, monoAuxes: 0, stereoAuxes: 0, main: 'lr', monoMatrices: 0, stereoMatrices: 0, ...fx,
  };
  const unclear = (why: string): MixConfigReading => ({ config: current ?? blank, clean: false, notes: [why, 'Enter the numbers from the rack’s Mixer Config, using the names below as a guide.'] });

  if (!used) return unclear('The rack didn’t name any mix channels.');
  const mainAt = names.findIndex((n) => MAIN_RE.test(n));
  if (mainAt < 0) return unclear('Couldn’t find the main mix among the names (none starts “Main”, “LR” or similar).');

  const lrMono = mainAt + 2 < used && MAIN_MONO_RE.test(names[mainAt + 2] ?? '');
  const mainEnd = mainAt + (lrMono ? 4 : 2);
  const before = fit(runs(names.slice(0, mainAt)), [false, true, false, true]);
  const after = fit(runs(names.slice(mainEnd, used)), [false, true]);
  if (!before || !after) return unclear('The names don’t follow the rack’s order (groups, auxes, main, matrices).');

  const [monoGroups, stereoGroups, monoAuxes, stereoAuxes] = before as [number, number, number, number];
  const [monoMatrices, stereoMatrices] = after as [number, number];
  const config: RackMixConfig = { monoGroups, stereoGroups, monoAuxes, stereoAuxes, main: lrMono ? 'lrMono' : 'lr', monoMatrices, stereoMatrices, ...fx };

  if (mixChannelCount(config) !== used && !(lrMono && mixChannelCount(config) === used + 1)) {
    return unclear('The names and the rack’s channel count don’t add up.');
  }
  notes.push(
    monoGroups || stereoGroups
      ? 'Check which of the mixes before the main are groups: the names can’t tell groups from auxes.'
      : 'Every mix before the main is read as an aux. If some are groups, move them to Groups: the names can’t tell groups from auxes.',
    'Set the FX sends (mono and stereo) from the rack’s Mixer Config: they have no mix channels, so the names can’t show them.',
  );
  if (stereoGroups || stereoAuxes || stereoMatrices) {
    notes.push('Stereo mixes are read from two neighbouring channels with the same name. Two mono mixes that happen to share a name would read as one stereo mix: check the stereo counts too.');
  }
  const error = mixConfigError(config);
  if (error) notes.push(error);
  return { config, clean: true, notes };
}

/** What a configuration calls each of the rack's 32 mix channels: "Aux 3", "Aux 5 L", "Main R", "—". */
export function channelLabels(config: RackMixConfig): string[] {
  const labels: string[] = Array.from({ length: 32 }, () => '—');
  const numbers: Record<string, number> = {};
  for (const slot of mixLayout(config).slots) {
    if (slot.role === 'unused' || !slot.channels.length) continue;
    const base =
      slot.role === 'mainLR' ? 'Main' : slot.role === 'mainMono' ? 'Main M' : `${{ aux: 'Aux', group: 'Grp', matrix: 'Mtx' }[slot.role as 'aux' | 'group' | 'matrix']} ${(numbers[slot.role] = (numbers[slot.role] ?? 0) + 1)}`;
    slot.channels.forEach((ch, i) => {
      labels[ch - 0x60] = slot.channels.length === 2 ? `${base} ${i ? 'R' : 'L'}` : base;
    });
  }
  return labels;
}

/**
 * Where a configuration and the rack's names disagree: channels the configuration uses but the rack doesn't answer
 * for (or the other way round), and stereo mixes whose halves the rack names differently. Main is exempt from the
 * last: its L and R are often named separately.
 */
export function layoutMismatches(config: RackMixConfig, mixNames: Array<string | null>): number[] {
  const bad = new Set<number>();
  const slots = mixLayout(config).slots;
  const inUse = new Set(slots.flatMap((s) => s.channels.map((ch) => ch - 0x60)));
  mixNames.forEach((name, i) => {
    if ((name !== null) !== inUse.has(i)) bad.add(i);
  });
  // The spare fourth main channel (LR + mono) is in no slot, and may or may not answer.
  if (config.main === 'lrMono') {
    const m = slots.find((s) => s.role === 'mainMono')?.channels[0];
    if (m !== undefined) bad.delete(m + 1 - 0x60);
  }
  for (const s of slots) {
    if (s.role === 'mainLR' || s.channels.length !== 2) continue;
    const [l, r] = s.channels.map((ch) => mixNames[ch - 0x60]);
    if (l !== undefined && r !== undefined && l !== r) {
      bad.add(s.channels[0]! - 0x60);
      bad.add(s.channels[1]! - 0x60);
    }
  }
  return [...bad].sort((a, b) => a - b);
}
