import type { StripRef } from '@shared/domain/ids';

/** A page of strips that fits the window: the bank keys choose which one is on the faders. */
export interface Bank {
  id: string;
  label: string;
  strips: StripRef[];
}

/** Bank sizes, as on a console: whole groups of 8, so banks line up with 1–8, 1–16, 1–32. */
const SIZES: readonly number[] = [32, 16, 8, 4];

/** The largest bank size whose strips all fit `width` without scrolling (4 on even the narrowest window). */
export function bankSize(width: number, minStrip: number): number {
  const fit = Math.floor(width / minStrip);
  return SIZES.find((n) => n <= fit) ?? 4;
}

/** The input channels in banks of `size`: Ch 1–16, Ch 17–32… */
export function makeBanks(size: number, inputs: number): Bank[] {
  const out: Bank[] = [];
  for (let a = 0; a < inputs; a += size) {
    const b = Math.min(inputs, a + size);
    out.push({
      id: `input:${a}`,
      label: b - a === 1 ? `Ch ${a + 1}` : `Ch ${a + 1}–${b}`,
      strips: Array.from({ length: b - a }, (_, i) => ({ kind: 'input' as const, index: a + i })),
    });
  }
  return out;
}

/** After a resize changes the bank size, stay on the bank holding the first channel that was on screen. */
export function bankFor(banks: Bank[], first: number): Bank | undefined {
  return banks.find((b) => b.strips.some((s) => s.index === first)) ?? banks[0];
}
