import { IDR48, type StripRef } from './domain/ids';

/**
 * Meter frames travel main -> renderer as one transferable Float32Array over a
 * MessagePort (never through React state or JSON IPC). The layout is fixed so
 * both sides agree on offsets without per-frame metadata.
 */
export const METER_LAYOUT = (() => {
  let o = 0;
  const seg = (n: number) => {
    const start = o;
    o += n;
    return { start, length: n };
  };
  const inputs = seg(IDR48.inputChannels);
  const mixesL = seg(IDR48.mixBuses);
  const mixesR = seg(IDR48.mixBuses);
  const fxReturns = seg(IDR48.fxUnits);
  const gateGr = seg(IDR48.inputChannels);
  const compGrInputs = seg(IDR48.inputChannels);
  const compGrMixes = seg(IDR48.mixBuses);
  const gateOpen = seg(IDR48.inputChannels);
  return { inputs, mixesL, mixesR, fxReturns, gateGr, compGrInputs, compGrMixes, gateOpen, size: o };
})();

export const METER_FLOOR_DB = -60;

export function meterOffset(ref: StripRef, channel: 'L' | 'R' = 'L'): number | null {
  switch (ref.kind) {
    case 'input':
      return METER_LAYOUT.inputs.start + ref.index;
    case 'mix':
      return (channel === 'L' ? METER_LAYOUT.mixesL.start : METER_LAYOUT.mixesR.start) + ref.index;
    case 'fxReturn':
      return METER_LAYOUT.fxReturns.start + ref.index;
    default:
      return null;
  }
}

export function compGrOffset(ref: StripRef): number | null {
  if (ref.kind === 'input') return METER_LAYOUT.compGrInputs.start + ref.index;
  if (ref.kind === 'mix') return METER_LAYOUT.compGrMixes.start + ref.index;
  return null;
}

export const createMeterFrame = (): Float32Array => new Float32Array(METER_LAYOUT.size).fill(METER_FLOOR_DB);
