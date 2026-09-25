/**
 * iDR48 topology and strip addressing.
 *
 * iLive separates *sockets* (physical preamps on the MixRack) from *processing
 * channels* (patched from any socket). The iDR48 exposes 48 mic sockets, 64 input
 * processing channels and 32 configurable mix buses.
 */
export const IDR48 = {
  micSockets: 48,
  inputChannels: 64,
  mixBuses: 32,
  fxUnits: 8,
  dcas: 16,
  muteGroups: 8,
  sceneSlots: 250,
  paramEqBands: 4,
} as const;

export type StripKind = 'input' | 'mix' | 'fxSend' | 'fxReturn' | 'dca';

/** Zero-based strip address. UI shows `index + 1`. */
export interface StripRef {
  readonly kind: StripKind;
  readonly index: number;
}

export type StripKey = `${StripKind}:${number}`;

export const stripKey = (ref: StripRef): StripKey => `${ref.kind}:${ref.index}`;

const KINDS: readonly StripKind[] = ['input', 'mix', 'fxSend', 'fxReturn', 'dca'];

export function parseStripKey(key: string): StripRef | null {
  const [kind, idx] = key.split(':');
  const index = Number(idx);
  if (!kind || !KINDS.includes(kind as StripKind) || !Number.isInteger(index) || index < 0) return null;
  return { kind: kind as StripKind, index };
}

export const sameStrip = (a: StripRef, b: StripRef): boolean => a.kind === b.kind && a.index === b.index;

export function stripCount(kind: StripKind): number {
  switch (kind) {
    case 'input':
      return IDR48.inputChannels;
    case 'mix':
      return IDR48.mixBuses;
    case 'fxSend':
    case 'fxReturn':
      return IDR48.fxUnits;
    case 'dca':
      return IDR48.dcas;
  }
}

export const isValidStrip = (ref: StripRef): boolean =>
  Number.isInteger(ref.index) && ref.index >= 0 && ref.index < stripCount(ref.kind);

/** How a mix bus is configured in the MixRack's mix configuration. */
export type MixRole = 'aux' | 'group' | 'matrix' | 'mainLR' | 'mainMono' | 'unused';

/** A destination for a send: another mix bus or an FX send. */
export type SendTarget = { readonly kind: 'mix'; readonly index: number } | { readonly kind: 'fxSend'; readonly index: number };

export const sendTargetKey = (t: SendTarget): string => `${t.kind}:${t.index}`;
