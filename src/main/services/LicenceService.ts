import { randomUUID } from 'node:crypto';
import type { Logger } from '../logging/Logger';
import { readJson, writeJsonAtomic } from '../storage/JsonStore';
import { Emitter } from '../transport/Transport';
import { EMAIL_RE, type LicenceReason, type LicenceRegistration, type LicenceView } from '@shared/licence';

/**
 * Licence check-in against whiteleyevents.co.uk, the WESC way (see
 * ~/Developer/wesc-licensing.md): the install says who it is, the server may
 * say "no", and the cached answer stands for 30 days when the server can't be
 * reached.
 *
 * One deliberate difference: the verdict is taken once, when the app starts.
 * A denial or lapse learned while running is only reported; the app won't
 * start next time. A running mix is never interrupted, and a launch in show
 * mode (e.g. a restart mid-event) always runs.
 */
export const LICENCE_SERVER = 'https://whiteleyevents.co.uk';
export const LICENCE_APP = 'weim';
export const GRACE_MS = 30 * 24 * 3600_000;
export const WARN_MS = 7 * 24 * 3600_000;
export const CHECKIN_INTERVAL_MS = 24 * 3600_000;
export const CHECKIN_TIMEOUT_MS = 10_000;

export interface LicenceState {
  uuid: string | null;
  name: string | null;
  email: string | null;
  machineName: string | null;
  status: 'unknown' | 'granted' | 'denied';
  deniedReason: string | null;
  lastCheckinAt: string | null;
  graceUntil: string | null;
  lastError: string | null;
}

export const emptyLicenceState = (): LicenceState => ({
  uuid: null, name: null, email: null, machineName: null, status: 'unknown', deniedReason: null, lastCheckinAt: null, graceUntil: null, lastError: null,
});

export interface Evaluation {
  allowed: boolean;
  reason: LicenceReason;
  graceMsRemaining: number | null;
}

/** Pure: what the local state entitles, at `now`. No network. */
export function evaluate(s: LicenceState, now: number): Evaluation {
  if (!s.uuid || !s.name || !s.email) return { allowed: false, reason: 'no-identity', graceMsRemaining: null };
  if (s.status === 'denied') return { allowed: false, reason: 'denied', graceMsRemaining: null };
  if (!s.lastCheckinAt || !s.graceUntil) return { allowed: true, reason: 'no-checkin', graceMsRemaining: null };
  const left = Date.parse(s.graceUntil) - now;
  if (!(left > 0)) return { allowed: false, reason: 'grace-expired', graceMsRemaining: 0 };
  return { allowed: true, reason: left < WARN_MS ? 'grace-soon' : 'granted', graceMsRemaining: left };
}

type CheckinReply = { status?: unknown; denied_reason?: unknown; message?: unknown } | null;

export type CheckinOutcome = 'granted' | 'denied' | 'server-error' | 'network-error' | 'no-identity';

export interface LicenceDeps {
  statePath: string;
  version: string;
  /** The computer's name from macOS. Always used as the machine name; the operator can't change it. */
  hostname: string;
  log: Logger;
  fetch: typeof fetch;
  /** Show mode at launch: the gate is always open then. */
  showMode(): boolean;
  server?: string;
  now?: () => number;
  intervalMs?: number;
}

export class LicenceService {
  readonly changed = new Emitter<LicenceView>();
  private state: LicenceState = emptyLicenceState();
  private gate: LicenceView['launch'] = { allowed: false, reason: 'no-identity', showMode: false };
  private checking: Promise<CheckinOutcome> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: LicenceDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Load the cached state and take the launch verdict from it. */
  async init(): Promise<LicenceView> {
    try {
      this.state = { ...emptyLicenceState(), ...((await readJson<Partial<LicenceState>>(this.d.statePath)) ?? {}) };
    } catch (err) {
      // A corrupt file must not stop the app: treat as unregistered (the operator re-enters name and email).
      this.d.log.warn('system', `Licence state unreadable, starting fresh: ${(err as Error).message}`);
    }
    if (this.state.uuid) this.state = { ...this.state, machineName: this.d.hostname }; // follows a renamed Mac
    const ev = evaluate(this.state, this.now());
    const showMode = this.d.showMode();
    this.gate = { allowed: ev.allowed || showMode, reason: ev.reason, showMode };
    if (!ev.allowed) this.d.log.warn('system', `Licence: ${ev.reason}${showMode ? ' (show mode: running anyway)' : ''}`);
    return this.view;
  }

  get view(): LicenceView {
    const s = this.state;
    const ev = evaluate(s, this.now());
    return {
      identity: s.name && s.email ? { name: s.name, email: s.email, machineName: this.d.hostname } : null,
      installId: s.uuid ? s.uuid.slice(0, 8) : null,
      status: s.status,
      deniedReason: s.deniedReason,
      lastCheckinAt: s.lastCheckinAt,
      graceUntil: s.graceUntil,
      lastError: s.lastError,
      reason: ev.reason,
      allowed: ev.allowed,
      graceDaysLeft: ev.graceMsRemaining === null ? null : Math.ceil(ev.graceMsRemaining / 86_400_000),
      launch: { ...this.gate },
      checking: this.checking !== null,
      machineName: this.d.hostname,
    };
  }

  /** Daily check-ins while running. Errors are recorded, never thrown. */
  start() {
    this.stop();
    this.interval = setInterval(() => void this.checkin(), this.d.intervalMs ?? CHECKIN_INTERVAL_MS);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** First run (or correcting details): store the identity and check in straight away. */
  async register(id: LicenceRegistration): Promise<LicenceView> {
    const name = id.name.trim();
    const email = id.email.trim();
    const machineName = this.d.hostname;
    if (!name) throw new Error('Enter your name');
    if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address');
    this.state = { ...this.state, uuid: this.state.uuid ?? randomUUID(), name, email, machineName };
    await this.persist();
    this.d.log.info('system', `Licence registered to ${name} on ${machineName}`);
    // A check-in already on the wire carries the old details: let it land, then send the new ones.
    if (this.checking) await this.checking;
    // Still at the launch screen: let the first check-in answer before opening (a refusal keeps it shut; offline opens).
    await this.checkin();
    this.reopenGate();
    this.emit();
    return this.view;
  }

  /** One check-in at a time; concurrent callers share it. */
  checkin(): Promise<CheckinOutcome> {
    if (!this.checking) {
      this.checking = this.doCheckin().finally(() => {
        this.checking = null;
        this.emit();
      });
      this.emit();
    }
    return this.checking;
  }

  private async doCheckin(): Promise<CheckinOutcome> {
    const s = this.state;
    if (!s.uuid || !s.name || !s.email) return 'no-identity';
    const url = `${this.d.server ?? LICENCE_SERVER}/welm-api.php?action=checkin`;
    const body = { uuid: s.uuid, name: s.name, email: s.email, machine_name: this.d.hostname, app: LICENCE_APP, version: this.d.version };
    let res: Response;
    let json = null as CheckinReply | null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`no reply in ${CHECKIN_TIMEOUT_MS / 1000} s`)), CHECKIN_TIMEOUT_MS);
    try {
      res = await this.d.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      try {
        json = (await res.json()) as CheckinReply;
      } catch (err) {
        // A reply that stalled or broke off is a network error, not a grant.
        if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : err;
        json = null; // An unexpected body still grants below 500: a server-side change must not lock out the field.
      }
    } catch (err) {
      // Node's fetch says only "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, a timeout) is on `cause`.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message;
      return this.failed('network-error', `${(err as Error).message}${why ? ` (${why})` : ''}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) return this.failed('server-error', `licence server replied ${res.status}`);

    const at = new Date(this.now()).toISOString();
    if (json?.status === 'denied') {
      const reason = typeof json.denied_reason === 'string' ? json.denied_reason : typeof json.message === 'string' ? json.message : null;
      this.state = { ...this.state, status: 'denied', deniedReason: reason, lastCheckinAt: at, lastError: null };
      this.d.log.warn('system', `Licence denied${reason ? `: ${reason}` : ''}${this.gate.allowed ? ' (takes effect next launch)' : ''}`);
    } else {
      const wasDenied = this.state.status === 'denied';
      this.state = {
        ...this.state, status: 'granted', deniedReason: null, lastCheckinAt: at,
        graceUntil: new Date(this.now() + GRACE_MS).toISOString(), lastError: null,
      };
      if (wasDenied) this.d.log.info('system', 'Licence granted again');
    }
    await this.persist();
    this.reopenGate();
    return this.state.status === 'denied' ? 'denied' : 'granted';
  }

  private async failed(outcome: 'server-error' | 'network-error', message: string): Promise<CheckinOutcome> {
    this.state = { ...this.state, lastError: message };
    this.d.log.info('system', `Licence check-in failed (${outcome}): ${message}`);
    await this.persist().catch(() => undefined);
    return outcome;
  }

  /** The gate only ever opens during a session (registration, Retry): it never closes on a running app. */
  private reopenGate() {
    if (this.gate.allowed) return;
    const ev = evaluate(this.state, this.now());
    this.gate = { ...this.gate, allowed: ev.allowed, reason: ev.reason };
  }

  private async persist() {
    await writeJsonAtomic(this.d.statePath, this.state).catch((err) => this.d.log.error('system', `Could not save licence state: ${(err as Error).message}`));
  }

  private emit() {
    this.changed.emit(this.view);
  }
}
