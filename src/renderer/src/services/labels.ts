import type { StripRef } from '@shared/domain/ids';
import type { MixerState } from '@shared/domain/model';

/** "Ch 12": the channel's number, as on the iLive surface. */
export const sourceLabel = (ref: StripRef): string => `Ch ${ref.index + 1}`;

/** "Aux 3": auxes are numbered in rack order, whatever mix channel they sit on. */
export function busLabel(state: MixerState, index: number): string {
  const n = state.mixes.filter((m) => m.role === 'aux' && m.ref.index <= index).length;
  return `Aux ${n}`;
}
