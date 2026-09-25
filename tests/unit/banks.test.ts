import { describe, expect, it } from 'vitest';
import { bankFor, bankSize, makeBanks } from '@renderer/services/banks';

describe('banks', () => {
  it('picks the biggest console-sized bank that fits the width, never fewer than 4', () => {
    expect(bankSize(2600, 76)).toBe(32);
    expect(bankSize(1436, 76)).toBe(16);
    expect(bankSize(1200, 76)).toBe(8);
    expect(bankSize(400, 76)).toBe(4);
    expect(bankSize(100, 76)).toBe(4);
  });

  it('splits the 64 inputs into whole banks', () => {
    expect(makeBanks(16, 64).map((b) => b.label)).toEqual(['Ch 1–16', 'Ch 17–32', 'Ch 33–48', 'Ch 49–64']);
    expect(makeBanks(32, 64)[1]!.strips.map((s) => s.index)).toEqual(Array.from({ length: 32 }, (_, i) => 32 + i));
    expect(makeBanks(8, 3).map((b) => b.label)).toEqual(['Ch 1–3']);
    expect(makeBanks(4, 5).map((b) => b.label)).toEqual(['Ch 1–4', 'Ch 5']);
    expect(makeBanks(8, 0)).toEqual([]);
  });

  it('keeps the same channels in view when a resize changes the bank size', () => {
    expect(bankFor(makeBanks(16, 64), 40)!.label).toBe('Ch 33–48'); // was on Ch 41–48 at 8 wide
    expect(bankFor(makeBanks(8, 64), 32)!.label).toBe('Ch 33–40');
    expect(bankFor(makeBanks(8, 64), 99)!.label).toBe('Ch 1–8');
    expect(bankFor([], 0)).toBeUndefined();
  });
});
