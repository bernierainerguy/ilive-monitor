import type { MixerChange } from './domain/changes';
import { isValidStrip, type StripRef } from './domain/ids';
import type { MixStrip, MixerState } from './domain/model';
import { FADER_MAX_DB } from './domain/units';

/**
 * What iLive Monitor may change, and nothing else: the level of a send from an
 * input channel to the one mix bus chosen in Settings. No channel faders, mutes,
 * pan, send mutes, FX returns, processing, routing, scenes or other buses.
 *
 * This runs in the main process on every change from the renderer, so the
 * restriction holds even if the UI is bypassed. The renderer calls it too, but
 * only to disable controls.
 */

export type PolicyResult = { ok: true } | { ok: false; reason: string };

/** Only auxes are monitor mixes. Groups, matrices and mains are never offered. */
export const isMonitorBus = (state: MixerState, index: number | null): boolean =>
  index !== null && state.mixes[index]?.role === 'aux';

/** The auxes Settings offers, in rack order. */
export const monitorBuses = (state: MixerState): MixStrip[] => state.mixes.filter((m) => m.role === 'aux');

/** The mix index of aux number `aux` (1-based) under the current mix configuration, or null if there's no such aux. */
export function auxBusIndex(state: MixerState, aux: number | null): number | null {
  if (aux === null || !Number.isInteger(aux) || aux < 1) return null;
  return monitorBuses(state)[aux - 1]?.ref.index ?? null;
}

/** The strips this app sends from: the 64 input channels. FX returns are deliberately left out. */
export const monitorSources = (state: MixerState): StripRef[] => state.inputs.map((s) => s.ref);

const isSource = (ref: StripRef): boolean => ref.kind === 'input' && isValidStrip(ref);

const isLevel = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v) && v !== Infinity && v <= FADER_MAX_DB;

export function authorizeMonitorChange(state: MixerState, bus: number | null, c: MixerChange): PolicyResult {
  if (c.t !== 'send') return { ok: false, reason: 'iLive Monitor only adjusts send levels' };
  if (bus === null) return { ok: false, reason: 'Choose a mix bus in Settings first' };
  if (!isMonitorBus(state, bus)) return { ok: false, reason: 'The mix bus in Settings is not an aux on this rack' };
  if (c.target.kind !== 'mix' || c.target.index !== bus) return { ok: false, reason: 'Only sends to the mix bus in Settings can be changed' };
  if (!c.strip || !isSource(c.strip)) return { ok: false, reason: 'Only input channel sends can be changed' };
  const keys = Object.keys(c.patch ?? {});
  if (keys.length !== 1 || keys[0] !== 'levelDb' || !isLevel(c.patch.levelDb)) return { ok: false, reason: 'Only the send level can be changed' };
  return { ok: true };
}
