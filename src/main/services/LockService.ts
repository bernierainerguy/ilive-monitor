import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { MIN_PASSWORD_LENGTH, type LockStatus } from '@shared/lock';
import type { Logger } from '../logging/Logger';
import { readJson, writeJsonAtomic } from '../storage/JsonStore';
import { Emitter } from '../transport/Transport';

/** After this many wrong passwords in a row, each further attempt waits a little longer. */
const FREE_ATTEMPTS = 5;
const BACKOFF_MS = 30_000;
/** Settings relocks on its own after this long unlocked, in case the operator walks away on the page. */
export const AUTO_LOCK_MS = 10 * 60_000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length > 0 && timingSafeEqual(expected, actual);
}

/**
 * The Settings password. The hash lives in its own file (`settings-lock.json`),
 * so deleting that file removes a forgotten password without losing the racks or
 * the mix. Unlocking lasts until Settings is left, the app quits, or
 * AUTO_LOCK_MS passes. The main process checks `unlocked` before any change
 * Settings can make.
 */
export class LockService {
  readonly changed = new Emitter<LockStatus>();
  private hash: string | null = null;
  private open = false;
  private failures = 0;
  private retryAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string, private readonly log: Logger, private readonly now: () => number = Date.now) {}

  async init(): Promise<LockStatus> {
    const stored = await readJson<{ hash?: unknown; failures?: unknown; retryAt?: unknown }>(this.path).catch(() => null);
    this.hash = typeof stored?.hash === 'string' && stored.hash.includes(':') ? stored.hash : null;
    // The wrong-password count survives a relaunch, or quitting would reset the wait between guesses.
    if (this.hash) {
      this.failures = Number.isInteger(stored?.failures) && (stored!.failures as number) > 0 ? (stored!.failures as number) : 0;
      this.retryAt = typeof stored?.retryAt === 'number' && stored.retryAt > this.now() ? stored.retryAt : null;
    }
    return this.status;
  }

  get status(): LockStatus {
    return { hasPassword: this.hash !== null, unlocked: this.unlocked, retryAt: this.retryAt && this.retryAt > this.now() ? this.retryAt : null };
  }

  get unlocked(): boolean {
    return this.hash === null || this.open;
  }

  /** Throws unless Settings may be changed now. */
  require(): void {
    if (!this.unlocked) throw new Error('Settings are locked. Enter the password first.');
  }

  unlock(password: unknown): LockStatus {
    if (this.hash === null) return this.status;
    if (this.retryAt && this.retryAt > this.now()) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((this.retryAt - this.now()) / 1000)} s.`);
    if (typeof password !== 'string' || !verifyPassword(password, this.hash)) {
      this.failures++;
      if (this.failures >= FREE_ATTEMPTS) this.retryAt = this.now() + BACKOFF_MS * (this.failures - FREE_ATTEMPTS + 1);
      this.log.warn('user', `Wrong Settings password (${this.failures} in a row)`);
      this.save();
      this.emit();
      throw new Error('Wrong password');
    }
    if (this.failures) {
      this.failures = 0;
      this.retryAt = null;
      this.save();
    }
    this.setOpen(true);
    this.log.info('user', 'Settings unlocked');
    return this.status;
  }

  lock(): LockStatus {
    if (this.open) this.log.info('user', 'Settings locked');
    this.setOpen(false);
    return this.status;
  }

  /** Set, change (a string) or remove (null) the password. Only while unlocked. */
  async setPassword(next: unknown): Promise<LockStatus> {
    this.require();
    if (next === null) {
      // The file goes first (after any queued write, so a late one can't bring it back). If it can't be removed,
      // the password stays, rather than being gone this session and back at the next launch.
      const removal = this.writing.catch(() => undefined).then(() => rm(this.path, { force: true }));
      this.writing = removal;
      await removal;
      this.hash = null;
      this.failures = 0;
      this.retryAt = null;
      this.log.info('user', 'Settings password removed');
    } else {
      if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      // On disk first: if it can't be saved, keep the old password rather than one that vanishes at relaunch.
      const hash = hashPassword(next);
      await this.write({ hash, failures: 0, retryAt: null });
      this.hash = hash;
      this.failures = 0;
      this.retryAt = null;
      this.log.info('user', 'Settings password set');
    }
    // Whoever set it is at Settings now: stay unlocked until they leave.
    this.setOpen(this.hash !== null);
    return this.status;
  }

  /** Written in order, so a burst of wrong guesses can't leave an older count on disk. */
  private writing: Promise<unknown> = Promise.resolve();
  private write(record = { hash: this.hash, failures: this.failures, retryAt: this.retryAt }): Promise<unknown> {
    // Chained past any earlier failure: one failed write (disk full) mustn't stop every later one.
    const next = this.writing.catch(() => undefined).then(() => writeJsonAtomic(this.path, record));
    this.writing = next;
    return next;
  }
  private save() {
    this.write().catch((err: Error) => this.log.error('system', `Couldn't save the Settings lock: ${err.message}`));
  }

  /** Resolves once the lock file is up to date. */
  flush(): Promise<unknown> {
    return this.writing.catch(() => undefined);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setOpen(open: boolean) {
    this.open = open;
    if (this.timer) clearTimeout(this.timer);
    this.timer = open ? setTimeout(() => this.lock(), AUTO_LOCK_MS) : null;
    this.emit();
  }

  private emit() {
    this.changed.emit(this.status);
  }
}
