import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@main/logging/Logger';
import { AUTO_LOCK_MS, LockService, hashPassword, verifyPassword } from '@main/services/LockService';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ilm-lock-'));
  path = join(dir, 'settings-lock.json');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const service = async (now = () => Date.now()) => {
  const s = new LockService(path, new Logger('error'), now);
  await s.init();
  return s;
};

describe('password hashing', () => {
  it('salts, verifies, and rejects the wrong password or a damaged hash', () => {
    const a = hashPassword('stage-left');
    expect(a).not.toContain('stage-left');
    expect(hashPassword('stage-left')).not.toBe(a); // salted
    expect(verifyPassword('stage-left', a)).toBe(true);
    expect(verifyPassword('stage-right', a)).toBe(false);
    expect(verifyPassword('stage-left', 'nonsense')).toBe(false);
    expect(verifyPassword('stage-left', 'abcd:')).toBe(false);
  });
});

describe('LockService', () => {
  it('is open with no password, and setting one keeps the setter unlocked until they leave', async () => {
    const s = await service();
    expect(s.status).toEqual({ hasPassword: false, unlocked: true, retryAt: null });
    expect(() => s.require()).not.toThrow();
    await s.setPassword('1234');
    expect(s.status).toMatchObject({ hasPassword: true, unlocked: true });
    s.lock();
    expect(s.status.unlocked).toBe(false);
    expect(() => s.require()).toThrow(/locked/);
    expect(JSON.parse(await readFile(path, 'utf8')).hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('unlocks with the right password only, and a new instance (relaunch) starts locked', async () => {
    const s = await service();
    await s.setPassword('monitors');
    s.lock();
    expect(() => s.unlock('Monitors')).toThrow('Wrong password');
    expect(() => s.unlock(undefined)).toThrow('Wrong password');
    expect(s.unlock('monitors').unlocked).toBe(true);
    const relaunched = await service();
    expect(relaunched.status).toMatchObject({ hasPassword: true, unlocked: false });
  });

  it('only changes or removes the password while unlocked; removing deletes the file', async () => {
    const s = await service();
    await s.setPassword('abcd');
    s.lock();
    await expect(s.setPassword('hijack')).rejects.toThrow(/locked/);
    await expect(s.setPassword(null)).rejects.toThrow(/locked/);
    s.unlock('abcd');
    await expect(s.setPassword('abc')).rejects.toThrow(/at least 4/);
    await expect(s.setPassword(42)).rejects.toThrow(/at least 4/);
    await s.setPassword('efgh');
    s.lock();
    expect(() => s.unlock('abcd')).toThrow();
    s.unlock('efgh');
    await s.setPassword(null);
    expect(existsSync(path)).toBe(false);
    expect(s.status).toEqual({ hasPassword: false, unlocked: true, retryAt: null });
  });

  it('slows down guessing after 5 wrong passwords, and a right one resets the count', async () => {
    let t = 1_000_000;
    const s = await service(() => t);
    await s.setPassword('right');
    s.lock();
    for (let i = 0; i < 5; i++) expect(() => s.unlock('wrong')).toThrow('Wrong password');
    expect(s.status.retryAt).toBe(t + 30_000);
    expect(() => s.unlock('right')).toThrow(/Try again in 30 s/); // even the right one waits
    t += 30_001;
    expect(() => s.unlock('wrong')).toThrow('Wrong password');
    expect(s.status.retryAt).toBe(t + 60_000); // longer each time
    t += 60_001;
    expect(s.unlock('right')).toMatchObject({ unlocked: true, retryAt: null });
    s.lock();
    expect(() => s.unlock('wrong')).toThrow('Wrong password');
    expect(s.status.retryAt).toBeNull();
  });

  it('quitting and relaunching does not reset the wait between guesses', async () => {
    let t = 1_000_000;
    const s = await service(() => t);
    await s.setPassword('right');
    s.lock();
    for (let i = 0; i < 5; i++) expect(() => s.unlock('wrong')).toThrow('Wrong password');
    await s.flush();
    const relaunched = await service(() => t);
    expect(relaunched.status.retryAt).toBe(t + 30_000);
    expect(() => relaunched.unlock('right')).toThrow(/Try again/);
    t += 30_001;
    expect(() => relaunched.unlock('wrong')).toThrow('Wrong password'); // the count carried over: a longer wait
    expect(relaunched.status.retryAt).toBe(t + 60_000);
    t += 60_001;
    relaunched.unlock('right');
    await relaunched.flush();
    expect((await service(() => t)).status.retryAt).toBeNull();
  });

  it('removing the password isn\'t undone by a write still queued', async () => {
    const s = await service();
    await s.setPassword('right');
    s.lock();
    expect(() => s.unlock('wrong')).toThrow(); // queues a write
    s.unlock('right'); // queues another
    await s.setPassword(null);
    expect(existsSync(path)).toBe(false);
  });

  it('one failed save doesn\'t stop later ones, and a password that can\'t be saved isn\'t set', async () => {
    const sub = join(dir, 'locked-dir');
    mkdirSync(sub);
    const file = join(sub, 'settings-lock.json');
    const s = new LockService(file, new Logger('error'));
    await s.init();
    await s.setPassword('first');
    chmodSync(sub, 0o500); // disk refuses writes
    await expect(s.setPassword('second')).rejects.toThrow();
    s.lock();
    expect(() => s.unlock('second')).toThrow('Wrong password'); // still the old one
    chmodSync(sub, 0o700); // disk back
    s.unlock('first');
    await s.setPassword('third');
    const relaunched = new LockService(file, new Logger('error'));
    await relaunched.init();
    expect(relaunched.unlock('third').unlocked).toBe(true);
  });

  it('a password whose file can\'t be removed stays, rather than coming back at the next launch', async () => {
    const sub = join(dir, 'locked-dir2');
    mkdirSync(sub);
    const file = join(sub, 'settings-lock.json');
    const s = new LockService(file, new Logger('error'));
    await s.init();
    await s.setPassword('keep');
    chmodSync(sub, 0o500);
    await expect(s.setPassword(null)).rejects.toThrow();
    expect(s.status.hasPassword).toBe(true);
    chmodSync(sub, 0o700);
  });

  it('locks itself after 10 minutes unlocked', async () => {
    vi.useFakeTimers();
    const s = await service();
    await s.setPassword('abcd');
    const seen = vi.fn();
    s.changed.on(seen);
    vi.advanceTimersByTime(AUTO_LOCK_MS - 1);
    expect(s.unlocked).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.unlocked).toBe(false);
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ unlocked: false }));
    s.dispose();
  });

  it('a damaged lock file means no password, not a lock-out', async () => {
    writeFileSync(path, '{"hash": 5}');
    expect((await service()).status.hasPassword).toBe(false);
    writeFileSync(path, 'not json');
    expect((await service()).status.hasPassword).toBe(false);
  });
});
