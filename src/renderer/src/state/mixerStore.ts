import { create } from 'zustand';
import { applyChanges, getStrip, type MixerChange } from '@shared/domain/changes';
import type { StripRef } from '@shared/domain/ids';
import type { AnyStrip, MixerState } from '@shared/domain/model';

/** Stable empty array for selector fallbacks (a fresh `[]` would loop zustand v5). */
export const EMPTY: readonly never[] = Object.freeze([]);

/**
 * Renderer replica of the main-process StateCache. Updated by sequenced batches;
 * a sequence gap means we missed something and must re-snapshot.
 */
interface MixerStore {
  state: MixerState | null;
  seq: number;
  reset(seq: number, state: MixerState): void;
  /** Returns false if a gap was detected (caller re-snapshots). */
  applyBatch(seq: number, changes: MixerChange[]): boolean;
  /** Optimistic local apply, before the round trip through main. */
  applyLocal(changes: MixerChange[]): void;
}

export const useMixerStore = create<MixerStore>((set, get) => ({
  state: null,
  seq: -1,
  reset: (seq, state) => set({ seq, state }),
  applyBatch: (seq, changes) => {
    const { state, seq: cur } = get();
    if (!state || seq !== cur + 1) return false;
    set({ seq, state: applyChanges(state, changes) });
    return true;
  },
  applyLocal: (changes) => {
    const { state } = get();
    if (state) set({ state: applyChanges(state, changes) });
  },
}));

/** Subscribes to exactly one strip; structural sharing means unrelated changes don't re-render. */
export const useStrip = <T extends AnyStrip = AnyStrip>(ref: StripRef | null): T | undefined =>
  useMixerStore((s) => (s.state && ref ? (getStrip(s.state, ref) as T | undefined) : undefined));

export const useMixerSlice = <T>(sel: (s: MixerState) => T): T | undefined =>
  useMixerStore((s) => (s.state ? sel(s.state) : undefined));
