import type { MixRole } from './domain/ids';
import { IDR48 } from './domain/ids';
import type { MixerState } from './domain/model';
import { createMixStrip } from './domain/defaults';

/**
 * The MixRack's mixer configuration, as far as the iLive MIDI / TCP protocol
 * needs it. The rack numbers its mix channels (CH 60..7F) and its send buses
 * (Snd 20..3D) in the order of this configuration, a stereo mix taking two
 * numbers (L then R). MIDI can't ask the rack for it, so the operator enters it.
 */
export interface RackMixConfig {
  monoGroups: number;
  stereoGroups: number;
  monoAuxes: number;
  stereoAuxes: number;
  /** Main LR takes two mix channels; LR + mono/sub takes four (L, R, M, spare). */
  main: 'lr' | 'lrMono';
  monoMatrices: number;
  stereoMatrices: number;
  /** FX send buses: they sit in the send-bus order but have their own fader channels (CH 00..07). */
  monoFx: number;
  stereoFx: number;
}

export const MIX_CHANNELS = 32; // CH 60..7F
export const SEND_BUSES = 30; // Snd 20..3D
const MIX_CH_BASE = 0x60;
const SND_BASE = 0x20;

/** One app mix strip and the rack numbers behind it. */
export interface MixSlot {
  role: MixRole;
  stereo: boolean;
  /** CH numbers: one for mono, L and R for stereo, empty for an unused strip. */
  channels: number[];
}

export interface MixLayout {
  /** One entry per app mix index (always IDR48.mixBuses long, padded with unused). */
  slots: MixSlot[];
  /** Snd numbers by app mix index (auxes only: matrices aren't in the rack's send-bus list). */
  mixSends: Map<number, number[]>;
  /** Snd numbers by FX send index. */
  fxSends: Map<number, number[]>;
}

export function mixChannelCount(c: RackMixConfig): number {
  return c.monoGroups + 2 * c.stereoGroups + c.monoAuxes + 2 * c.stereoAuxes + (c.main === 'lrMono' ? 4 : 2) + c.monoMatrices + 2 * c.stereoMatrices;
}

/** Send-bus numbers used up to the last aux (the main mix comes after and takes no sends). */
export function sendBusCount(c: RackMixConfig): number {
  return c.monoGroups + 2 * c.stereoGroups + c.monoFx + c.monoAuxes + 2 * c.stereoFx + 2 * c.stereoAuxes;
}

/** Why a configuration can't be right, or null. */
export function mixConfigError(c: RackMixConfig): string | null {
  const counts = [c.monoGroups, c.stereoGroups, c.monoAuxes, c.stereoAuxes, c.monoMatrices, c.stereoMatrices, c.monoFx, c.stereoFx];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) return 'Counts must be whole numbers, 0 or more.';
  if (c.main !== 'lr' && c.main !== 'lrMono') return 'Choose a main mix.';
  if (c.monoFx + c.stereoFx > IDR48.fxUnits) return `The rack has ${IDR48.fxUnits} FX sends at most.`;
  const ch = mixChannelCount(c);
  if (ch > MIX_CHANNELS) return `That uses ${ch} mix channels; the rack has ${MIX_CHANNELS} (a stereo mix counts as 2).`;
  const snd = sendBusCount(c);
  if (snd > SEND_BUSES) return `That uses ${snd} send buses; the rack has ${SEND_BUSES} (FX sends count, a stereo bus counts as 2).`;
  return null;
}

/** Normalise untrusted input (IPC, profile file) into a config, or null if it isn't one. */
export function parseMixConfig(v: unknown): RackMixConfig | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : NaN);
  if (o.main !== 'lr' && o.main !== 'lrMono') return null;
  const c: RackMixConfig = {
    monoGroups: n('monoGroups'), stereoGroups: n('stereoGroups'), monoAuxes: n('monoAuxes'), stereoAuxes: n('stereoAuxes'),
    main: o.main,
    monoMatrices: n('monoMatrices'), stereoMatrices: n('stereoMatrices'), monoFx: n('monoFx'), stereoFx: n('stereoFx'),
  };
  return mixConfigError(c) ? null : c;
}

/** Build the app's mix strips and the rack numbers behind them, in the rack's order. */
export function mixLayout(c: RackMixConfig): MixLayout {
  const slots: MixSlot[] = [];
  let ch = MIX_CH_BASE;
  const add = (role: MixRole, stereo: boolean, count: number) => {
    for (let i = 0; i < count; i++) {
      slots.push({ role, stereo, channels: stereo ? [ch, ch + 1] : [ch] });
      ch += stereo ? 2 : 1;
    }
  };
  add('group', false, c.monoGroups);
  add('group', true, c.stereoGroups);
  add('aux', false, c.monoAuxes);
  add('aux', true, c.stereoAuxes);
  add('mainLR', true, 1);
  if (c.main === 'lrMono') {
    slots.push({ role: 'mainMono', stereo: false, channels: [ch] });
    ch += 2; // M plus the spare fourth main channel
  }
  add('matrix', false, c.monoMatrices);
  add('matrix', true, c.stereoMatrices);
  while (slots.length < IDR48.mixBuses) slots.push({ role: 'unused', stereo: false, channels: [] });

  // Send buses: groups, mono FX, mono auxes, stereo FX, stereo auxes, then main (main and groups take no sends).
  const mixSends = new Map<number, number[]>();
  const fxSends = new Map<number, number[]>();
  let snd = SND_BASE;
  const take = (stereo: boolean) => {
    const r = stereo ? [snd, snd + 1] : [snd];
    snd += r.length;
    return r;
  };
  const indexes = (role: MixRole, stereo: boolean) => slots.flatMap((s, i) => (s.role === role && s.stereo === stereo ? [i] : []));
  // Groups hold send-bus numbers but take no sends, so they only move the count on.
  snd += c.monoGroups + 2 * c.stereoGroups;
  for (let f = 0; f < c.monoFx; f++) fxSends.set(f, take(false));
  for (const i of indexes('aux', false)) mixSends.set(i, take(false));
  for (let f = 0; f < c.stereoFx; f++) fxSends.set(c.monoFx + f, take(true));
  for (const i of indexes('aux', true)) mixSends.set(i, take(true));
  return { slots, mixSends, fxSends };
}

/**
 * Reshape a show's mixes to match the rack's configuration. Strips whose role
 * and width already match keep everything; changed slots get a fresh strip, and
 * sends that pointed at a changed slot are dropped (they addressed a different
 * mix). Returns null when nothing needs to change.
 */
export function applyMixLayout(state: MixerState, layout: MixLayout): MixerState | null {
  const roles = layout.slots.map((s) => s.role);
  const changed = new Set<number>();
  const mixes = state.mixes.map((m, i) => {
    const slot = layout.slots[i]!;
    if (m.role === slot.role && m.stereo === slot.stereo) return m;
    changed.add(i);
    return createMixStrip(i, roles, slot.stereo);
  });
  if (!changed.size) return null;
  const dropSends = <T extends { sends: Record<number, unknown> }>(s: T): T => {
    const keys = Object.keys(s.sends).map(Number);
    if (!keys.some((k) => changed.has(k))) return s;
    return { ...s, sends: Object.fromEntries(Object.entries(s.sends).filter(([k]) => !changed.has(Number(k)))) };
  };
  return {
    ...state,
    inputs: state.inputs.map(dropSends),
    fxReturns: state.fxReturns.map(dropSends),
    mixes: mixes.map(dropSends),
  };
}
