import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@main/logging/Logger';
import {
  GRACE_MS, LICENCE_APP, LicenceService, WARN_MS, emptyLicenceState, evaluate, type LicenceDeps, type LicenceState,
} from '@main/services/LicenceService';
import { EULA_VERSION, LegalService } from '@main/services/LegalService';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const DAY = 86_400_000;
const registered = (p: Partial<LicenceState> = {}): LicenceState => ({
  ...emptyLicenceState(), uuid: '9a4f0000-0000-4000-8000-000000000000', name: 'Op', email: 'op@example.com', machineName: 'FOH', ...p,
});
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('evaluate', () => {
  it('follows the WESC entitlement table', () => {
    expect(evaluate(emptyLicenceState(), T0)).toMatchObject({ allowed: false, reason: 'no-identity' });
    expect(evaluate(registered({ email: null }), T0).reason).toBe('no-identity');
    expect(evaluate(registered(), T0)).toMatchObject({ allowed: true, reason: 'no-checkin' });
    const at = new Date(T0).toISOString();
    expect(evaluate(registered({ status: 'granted', lastCheckinAt: at, graceUntil: new Date(T0 + GRACE_MS).toISOString() }), T0))
      .toMatchObject({ allowed: true, reason: 'granted', graceMsRemaining: GRACE_MS });
    expect(evaluate(registered({ status: 'granted', lastCheckinAt: at, graceUntil: new Date(T0 + WARN_MS - 1).toISOString() }), T0))
      .toMatchObject({ allowed: true, reason: 'grace-soon' });
    expect(evaluate(registered({ status: 'granted', lastCheckinAt: at, graceUntil: at }), T0)).toMatchObject({ allowed: false, reason: 'grace-expired' });
    expect(evaluate(registered({ status: 'granted', lastCheckinAt: at, graceUntil: 'garbage' }), T0).reason).toBe('grace-expired');
    expect(evaluate(registered({ status: 'denied', lastCheckinAt: at }), T0)).toMatchObject({ allowed: false, reason: 'denied' });
  });
});

describe('LicenceService', () => {
  let dir: string;
  let path: string;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ilive-lic-'));
    path = join(dir, 'licence-checkin.json');
    now = T0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const make = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: Partial<LicenceDeps> = {}) =>
    new LicenceService({
      statePath: path, version: '0.5.1', hostname: 'Mac-mini', log: new Logger('error'),
      fetch: ((u: string, i?: RequestInit) => fetchImpl(u, i)) as typeof fetch,
      showMode: () => false, now: () => now, ...over,
    });
  const saved = () => JSON.parse(readFileSync(path, 'utf8')) as LicenceState;
  const seed = (s: LicenceState) => writeFileSync(path, JSON.stringify(s));

  it('first run: no identity blocks, registering checks in with the WESC payload and opens the gate', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const svc = make(async (url, init) => (calls.push({ url, body: JSON.parse(String(init?.body)) }), reply({ status: 'granted' })));
    const v0 = await svc.init();
    expect(v0.launch).toEqual({ allowed: false, reason: 'no-identity', showMode: false });
    expect(v0.machineName).toBe('Mac-mini');
    expect(await svc.checkin()).toBe('no-identity');
    expect(calls).toHaveLength(0);

    await expect(svc.register({ name: ' ', email: 'a@b.co' })).rejects.toThrow('name');
    await expect(svc.register({ name: 'Op', email: 'nope' })).rejects.toThrow('email');

    const v = await svc.register({ name: ' Op ', email: 'op@example.com ' });
    expect(calls[0]!.url).toBe('https://whiteleyevents.co.uk/welm-api.php?action=checkin');
    expect(calls[0]!.body).toMatchObject({ name: 'Op', email: 'op@example.com', machine_name: 'Mac-mini', app: LICENCE_APP, version: '0.5.1' });
    expect(calls[0]!.body['uuid']).toMatch(/^[0-9a-f-]{36}$/);
    expect(v).toMatchObject({ reason: 'granted', allowed: true, graceDaysLeft: 30, launch: { allowed: true } });
    expect(v.installId).toBe(String(calls[0]!.body['uuid']).slice(0, 8));
    expect(saved()).toMatchObject({ status: 'granted', lastCheckinAt: new Date(T0).toISOString(), graceUntil: new Date(T0 + GRACE_MS).toISOString() });

    // re-registering keeps the installation id; a machine name smuggled in is ignored
    await svc.register({ name: 'Op 2', email: 'op@example.com', machineName: 'Spoofed' } as never);
    expect(calls[1]!.body['uuid']).toBe(calls[0]!.body['uuid']);
    expect(calls[1]!.body['machine_name']).toBe('Mac-mini');
  });

  it('registering offline still runs (no-checkin) and records the error', async () => {
    const svc = make(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    await svc.init();
    const v = await svc.register({ name: 'Op', email: 'op@example.com' });
    expect(v).toMatchObject({ reason: 'no-checkin', allowed: true, launch: { allowed: true }, lastError: 'getaddrinfo ENOTFOUND' });
  });

  it('interprets replies bluntly: denied, anything else below 500 grants, 5xx and network errors keep state', async () => {
    const granted = registered({ status: 'granted', lastCheckinAt: new Date(T0 - DAY).toISOString(), graceUntil: new Date(T0 + 5 * DAY).toISOString() });
    let res: () => Promise<Response> = async () => reply({ status: 'granted' });
    seed(granted);
    const svc = make(() => res());
    await svc.init();

    res = async () => reply('<html>bad gateway</html>', 502);
    expect(await svc.checkin()).toBe('server-error');
    expect(saved()).toMatchObject({ status: 'granted', graceUntil: granted.graceUntil, lastError: 'licence server replied 502' });

    res = async () => { throw new Error('timeout'); };
    expect(await svc.checkin()).toBe('network-error');
    expect(saved()).toMatchObject({ graceUntil: granted.graceUntil, lastError: 'timeout' });

    res = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    await svc.checkin();
    expect(svc.view.lastError).toBe('fetch failed (ENOTFOUND)');

    res = async () => reply('not json at all', 404); // an unexpected body must not lock out the field
    expect(await svc.checkin()).toBe('granted');
    expect(saved()).toMatchObject({ lastError: null, graceUntil: new Date(T0 + GRACE_MS).toISOString() });

    res = async () => reply({ status: 'denied', denied_reason: 'Refunded' });
    expect(await svc.checkin()).toBe('denied');
    expect(saved()).toMatchObject({ status: 'denied', deniedReason: 'Refunded' });

    res = async () => reply({ status: 'denied', message: 'Contact us' });
    await svc.checkin();
    expect(svc.view.deniedReason).toBe('Contact us');

    res = async () => reply({ success: true });
    await svc.checkin();
    expect(saved()).toMatchObject({ status: 'granted', deniedReason: null });
  });

  it('never closes the gate on a running app: a denial mid-session only takes effect next launch', async () => {
    seed(registered({ status: 'granted', lastCheckinAt: new Date(T0).toISOString(), graceUntil: new Date(T0 + GRACE_MS).toISOString() }));
    const svc = make(async () => reply({ status: 'denied' }));
    expect((await svc.init()).launch.allowed).toBe(true);
    await svc.checkin();
    expect(svc.view).toMatchObject({ reason: 'denied', allowed: false, launch: { allowed: true, reason: 'granted' } });

    now = T0 + GRACE_MS + DAY; // grace also lapses while running: still open
    expect(svc.view.launch.allowed).toBe(true);

    const next = make(async () => reply({ status: 'denied' }));
    expect((await next.init()).launch).toEqual({ allowed: false, reason: 'denied', showMode: false });
  });

  it('a blocked launch opens again when Retry succeeds', async () => {
    seed(registered({ status: 'granted', lastCheckinAt: new Date(T0 - 40 * DAY).toISOString(), graceUntil: new Date(T0 - 10 * DAY).toISOString() }));
    let online = false;
    const svc = make(async () => { if (!online) throw new Error('offline'); return reply({ status: 'granted' }); });
    expect((await svc.init()).launch).toMatchObject({ allowed: false, reason: 'grace-expired' });
    await svc.checkin();
    expect(svc.view.launch.allowed).toBe(false);
    online = true;
    await svc.checkin();
    expect(svc.view.launch).toMatchObject({ allowed: true, reason: 'granted' });
  });

  it('launching in show mode always runs', async () => {
    seed(registered({ status: 'denied' }));
    const svc = make(async () => reply({ status: 'denied' }), { showMode: () => true });
    expect((await svc.init()).launch).toEqual({ allowed: true, reason: 'denied', showMode: true });
  });

  it('shares one check-in between callers, reports progress, honours the server override', async () => {
    seed(registered());
    let release!: () => void;
    const urls: string[] = [];
    const svc = make(async (u) => { urls.push(u); await new Promise<void>((r) => (release = r)); return reply({ status: 'granted' }); }, { server: 'http://127.0.0.1:9' });
    await svc.init();
    const seen: boolean[] = [];
    svc.changed.on((v) => seen.push(v.checking));
    const a = svc.checkin();
    const b = svc.checkin();
    expect(a).toBe(b);
    expect(svc.view.checking).toBe(true);
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    release();
    await a;
    expect(urls[0]).toBe('http://127.0.0.1:9/welm-api.php?action=checkin');
    expect(seen).toEqual([true, false]);
    expect(svc.view.checking).toBe(false);
  });

  it('checks in daily while running', async () => {
    seed(registered());
    const fetchFn = vi.fn(async () => reply({ status: 'granted' }));
    const svc = make(fetchFn, { intervalMs: 20 });
    await svc.init();
    svc.start();
    await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    svc.stop();
    const n = fetchFn.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchFn.mock.calls.length).toBe(n);
  });

  it('always reports the Mac\'s own name, even if the stored one differs', async () => {
    seed(registered({ machineName: 'Edited by hand' }));
    const bodies: Array<Record<string, unknown>> = [];
    const svc = make(async (_u, init) => (bodies.push(JSON.parse(String(init?.body))), reply({ status: 'granted' })));
    expect((await svc.init()).identity?.machineName).toBe('Mac-mini');
    await svc.checkin();
    expect(bodies[0]!['machine_name']).toBe('Mac-mini');
    expect(saved().machineName).toBe('Mac-mini');
  });

  it('changing details during a check-in sends the new details, not the old ones', async () => {
    seed(registered({ status: 'granted', lastCheckinAt: new Date(T0).toISOString(), graceUntil: new Date(T0 + GRACE_MS).toISOString() }));
    let release!: () => void;
    const bodies: Array<Record<string, unknown>> = [];
    const svc = make(async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) await new Promise<void>((r) => (release = r)); // the daily check-in, slow network
      return reply({ status: 'granted' });
    });
    await svc.init();
    const daily = svc.checkin();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    const reg = svc.register({ name: 'New Name', email: 'new@example.com' });
    release();
    await Promise.all([daily, reg]);
    expect(bodies.map((b) => b['name'])).toEqual(['Op', 'New Name']);
  });

  it('a reply that stalls part-way is a network error, not a grant', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    seed(registered({ status: 'granted', lastCheckinAt: new Date(T0 - DAY).toISOString(), graceUntil: new Date(T0 + 5 * DAY).toISOString() }));
    const svc = make(async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"status":"den')); // headers and a partial body, then nothing
          init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200 });
    });
    await svc.init();
    const p = svc.checkin();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe('network-error');
    expect(saved()).toMatchObject({ status: 'granted', graceUntil: new Date(T0 + 5 * DAY).toISOString(), lastError: 'no reply in 10 s' });
  });

  it('a corrupt state file starts fresh instead of failing to launch', async () => {
    writeFileSync(path, '{ torn');
    const svc = make(async () => reply({}));
    expect((await svc.init()).reason).toBe('no-identity');
  });
});

describe('LegalService', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ilive-eula-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('needs acceptance of the exact current version', async () => {
    const path = join(dir, 'eula-acceptance.json');
    const svc = new LegalService(path, new Logger('error'), () => T0);
    expect(await svc.init()).toEqual({ eulaVersion: EULA_VERSION, accepted: false, acceptedAt: null });
    const events: boolean[] = [];
    svc.changed.on((v) => events.push(v.accepted));
    expect(await svc.accept()).toEqual({ eulaVersion: EULA_VERSION, accepted: true, acceptedAt: new Date(T0).toISOString() });
    expect(events).toEqual([true]);
    expect((await new LegalService(path, new Logger('error')).init()).accepted).toBe(true);

    writeFileSync(path, JSON.stringify({ version: '2020-01-01', acceptedAt: 'x' }));
    expect((await new LegalService(path, new Logger('error')).init()).accepted).toBe(false);
    writeFileSync(path, '{ torn');
    expect((await new LegalService(path, new Logger('error')).init()).accepted).toBe(false);
  });

  it("accepts for the session even if the file can't be saved, so nobody is trapped behind the dialog", async () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const svc = new LegalService(join(blocker, 'eula-acceptance.json'), new Logger('error'), () => T0);
    await svc.init();
    const events: boolean[] = [];
    svc.changed.on((v) => events.push(v.accepted));
    expect((await svc.accept()).accepted).toBe(true);
    expect(events).toEqual([true]); // every window hears about it
  });

  it('the EULA version, the documents and the PDF builder agree', () => {
    const root = join(__dirname, '../..');
    const eula = readFileSync(join(root, 'legal/WEIM-EULA.md'), 'utf8');
    const privacy = readFileSync(join(root, 'legal/WEIM-Privacy-Notice.md'), 'utf8');
    const py = readFileSync(join(root, 'scripts/build-legal-pdfs.py'), 'utf8');
    const effective = new Date(`${EULA_VERSION}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    expect(eula).toContain(`EULA version ${EULA_VERSION} • Effective ${effective}`);
    expect(privacy).toContain(`Effective ${effective}`);
    expect(py).toContain(`EFFECTIVE = "${effective}"`);
  });
});
