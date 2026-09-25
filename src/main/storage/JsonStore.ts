import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Crash-safe JSON persistence: write to a temp file, fsync, then atomic rename.
 * A power cut mid-save leaves either the old file or the new one, never a torn one.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<number> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const data = JSON.stringify(value, replacer, 2);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
  return Buffer.byteLength(data);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'), reviver) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** JSON has no -Infinity; faders at -inf are extremely common, so encode them explicitly. */
const NEG_INF = '__-inf__';
export function replacer(_k: string, v: unknown) {
  return v === -Infinity ? NEG_INF : v;
}
export function reviver(_k: string, v: unknown) {
  return v === NEG_INF ? -Infinity : v;
}

export const stringify = (v: unknown, space?: number) => JSON.stringify(v, replacer, space);
export const parse = <T>(s: string): T => JSON.parse(s, reviver) as T;
