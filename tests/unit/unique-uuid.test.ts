import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchMachOUuid, uuidFor } = require('../../scripts/unique-uuid.cjs') as {
  patchMachOUuid(b: Buffer, u: Buffer): number;
  uuidFor(seed: string): Buffer;
};

const ELECTRON = join(__dirname, '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const dwarfUuid = (file: string) => execFileSync('dwarfdump', ['--uuid', file], { encoding: 'utf8' }).split(' ')[1];
const hyphenate = (b: Buffer) => b.toString('hex').toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

describe('unique Mach-O UUID (Local Network privacy)', () => {
  it('stable per app and file, different between them, and a valid version 5 UUID', () => {
    const a = uuidFor('uk.co.whiteleyevents.ilivemonitor:Contents/MacOS/iLive Monitor');
    expect(uuidFor('uk.co.whiteleyevents.ilivemonitor:Contents/MacOS/iLive Monitor')).toEqual(a);
    expect(uuidFor('uk.co.whiteleyevents.ilivetouch:Contents/MacOS/iLive Touch')).not.toEqual(a);
    expect(a[6]! >> 4).toBe(5);
    expect(a[8]! >> 6).toBe(2);
  });

  it.runIf(process.platform === 'darwin')('patches the real Electron binary so macOS sees the new UUID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ilm-uuid-'));
    try {
      const copy = join(dir, 'exe');
      copyFileSync(ELECTRON, copy);
      const stock = dwarfUuid(copy);
      const uuid = uuidFor('test');
      const buf = readFileSync(copy);
      expect(patchMachOUuid(buf, uuid)).toBeGreaterThan(0);
      require('node:fs').writeFileSync(copy, buf);
      expect(dwarfUuid(copy)).toBe(hyphenate(uuid));
      expect(dwarfUuid(copy)).not.toBe(stock);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not a 64-bit Mach-O', () => {
    expect(() => patchMachOUuid(Buffer.alloc(64), uuidFor('x'))).toThrow(/not a 64-bit Mach-O/);
  });
});
