import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@main/logging/Logger';
import { signingTeam } from '@main/services/codesign';
import { TEAM_ID, UpdateService, compareVersions, parseLatest, type UpdateDeps } from '@main/services/UpdateService';

/** The shape the site serves (~/Developer/wesc-update-checks.md §1): version at the top, per-platform url + filename. */
const DMG_URL = (v: string) => `https://whiteleyevents.co.uk/wp-content/uploads/whe-software/Whiteley-Events-AH-iLive-Monitor/MAC/WEIM-${v}-arm64.dmg`;
const feed = (version: string, platforms: Record<string, unknown> = { 'macos-arm': { url: DMG_URL(version), filename: `WEIM-${version}-arm64.dmg` } }, extra: Record<string, unknown> = {}) => ({
  success: true,
  data: { version, page: 'https://whiteleyevents.co.uk/software/', download: DMG_URL(version), platforms, ...extra },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bytes = (data: string, length = true) =>
  new Response(data, { status: 200, headers: length ? { 'content-length': String(Buffer.byteLength(data)) } : {} });

describe('version and feed parsing', () => {
  it('compares versions numerically, ignoring pre-release tags', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.7.318', '1.7.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.4.0', '0.4.1')).toBe(-1);
    expect(compareVersions('2', '1.9')).toBe(1);
    expect(compareVersions('1.8.0-beta.1', '1.8.0-beta.2')).toBe(0);
  });

  it('reads the real feed shape: data.version, platforms without their own version', () => {
    expect(parseLatest(feed('0.5.2'))).toEqual({
      version: '0.5.2', url: DMG_URL('0.5.2'), filename: 'WEIM-0.5.2-arm64.dmg', page: 'https://whiteleyevents.co.uk/software/',
    });
    // WESC's full example, with other platforms present
    expect(parseLatest(feed('0.5.2', {
      'macos-intel': { url: 'https://whiteleyevents.co.uk/x/WEIM-0.5.2-x64.dmg', filename: 'WEIM-0.5.2-x64.dmg' },
      windows: { url: 'https://whiteleyevents.co.uk/x/WEIM.exe', filename: 'WEIM.exe' },
      'macos-arm': { url: DMG_URL('0.5.2'), filename: 'WEIM-0.5.2-arm64.dmg' },
    }))?.filename).toBe('WEIM-0.5.2-arm64.dmg');
  });

  it('reads the live site reply, whose filename is a folder path', () => {
    // Captured from welm-api.php?action=latest&product=wesc, 2026-09-24.
    const live = {
      success: true,
      data: {
        product: 'wesc', title: 'Whiteley Events Service Cue', version: '1.7.311',
        platforms: {
          windows: { version: '1.7.311', url: 'https://whiteleyevents.co.uk/wp-content/uploads/whe-software/WESC/Windows/WESC-1.7.311-win-x64.exe', filename: 'WESC/Windows/WESC-1.7.311-win-x64.exe' },
          'macos-arm': { version: '1.7.311', url: 'https://whiteleyevents.co.uk/wp-content/uploads/whe-software/WESC/MAC/WESC-1.7.311-arm64.dmg', filename: 'WESC/MAC/WESC-1.7.311-arm64.dmg' },
        },
        download: 'https://whiteleyevents.co.uk/wp-content/uploads/whe-software/WESC/Windows/WESC-1.7.311-win-x64.exe',
        page: 'https://whiteleyevents.co.uk/software/',
      },
    };
    expect(parseLatest(live)).toEqual({
      version: '1.7.311', url: 'https://whiteleyevents.co.uk/wp-content/uploads/whe-software/WESC/MAC/WESC-1.7.311-arm64.dmg',
      filename: 'WESC-1.7.311-arm64.dmg', page: 'https://whiteleyevents.co.uk/software/',
    });
    // a Windows-only feed must not fall back to data.download's .exe
    const winOnly = { ...live, data: { ...live.data, platforms: { windows: live.data.platforms.windows } } };
    expect(parseLatest(winOnly)).toMatchObject({ url: null, filename: null });
  });

  it('needs success and data.version', () => {
    expect(parseLatest({ success: false, data: { version: '1.0.0' } })).toBeNull();
    expect(parseLatest({ success: true, data: { platforms: {} } })).toBeNull();
    expect(parseLatest({ success: true, data: { version: '' } })).toBeNull();
    expect(parseLatest({ success: true })).toBeNull();
    expect(parseLatest(null)).toBeNull();
  });

  it('falls back from macos-arm to macos, then data.download, then the page only — never a wrong installer', () => {
    expect(parseLatest(feed('1.0.0', { macos: { url: DMG_URL('1.0.0') } }))?.filename).toBe('WEIM-1.0.0-arm64.dmg'); // filename from the URL
    expect(parseLatest(feed('1.0.0', { windows: { url: 'https://whiteleyevents.co.uk/a.exe' } }))).toMatchObject({ url: DMG_URL('1.0.0') });
    const none = parseLatest(feed('1.0.0', {}, { download: 'https://whiteleyevents.co.uk/a.exe', page: 'https://evil.example/' }));
    expect(none).toEqual({ version: '1.0.0', url: null, filename: null, page: 'https://whiteleyevents.co.uk/software/' });
  });

  it('only accepts https installers on whiteleyevents.co.uk with a plain .dmg name', () => {
    const only = (url: string, filename?: string) => parseLatest(feed('1.0.0', { 'macos-arm': { url, filename } }, { download: null }))?.url ?? null;
    expect(only('http://whiteleyevents.co.uk/x.dmg')).toBeNull();
    expect(only('https://evil.example/iLive.dmg')).toBeNull();
    expect(only('https://whiteleyevents.co.uk.evil.example/x.dmg')).toBeNull();
    expect(only('not a url')).toBeNull();
    expect(only(DMG_URL('1.0.0'), '../../evil.dmg')).toBe(DMG_URL('1.0.0')); // only the last part of a path is used
    expect(parseLatest(feed('1.0.0', { 'macos-arm': { url: DMG_URL('1.0.0'), filename: '../../evil.dmg' } }))?.filename).toBe('evil.dmg');
    expect(only(DMG_URL('1.0.0'), 'a b.dmg')).toBeNull();
    expect(only(DMG_URL('1.0.0'), 'iLive.pkg')).toBeNull();
    expect(only(DMG_URL('1.0.0'))).toBe(DMG_URL('1.0.0'));
  });
});

describe('UpdateService', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ilive-upd-'))));
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const make = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: Partial<UpdateDeps> = {}) =>
    new UpdateService({
      currentVersion: '0.5.1', log: new Logger('error'), downloadsDir: dir,
      fetch: ((u: string, i?: RequestInit) => fetchImpl(u, i)) as typeof fetch,
      signingTeam: async () => TEAM_ID, openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined),
      showMode: () => false, ...over,
    });

  it('manual check: always answers with a dialog — available, up to date, or why it failed', async () => {
    let res: () => Response = () => json(feed('0.5.2'));
    const urls: string[] = [];
    const svc = make(async (u) => (urls.push(u), res()));
    const states: string[] = [];
    svc.changed.on((s) => states.push(s.status));
    expect(await svc.check()).toMatchObject({ status: 'available', available: { version: '0.5.2' }, dialog: 'manual' });
    expect(urls).toEqual(['https://whiteleyevents.co.uk/welm-api.php?action=latest&product=weim']); // one casing, one request
    expect(states[0]).toBe('checking');
    expect(svc.dismiss().dialog).toBeNull();

    res = () => json(feed('0.5.1')); // equal is up to date
    expect(await svc.check()).toMatchObject({ status: 'up-to-date', available: null, dialog: 'manual' });
    res = () => json(feed('0.4.0')); // a rollback on the site never offers a downgrade
    expect((await svc.check()).status).toBe('up-to-date');

    res = () => json({}, 503);
    expect(await svc.check()).toMatchObject({ status: 'up-to-date', checkError: 'update server replied 503', error: null, dialog: 'manual' });
    res = () => json({ success: false, data: { error: 'Unknown product or no installers available.' } }, 404); // the live reply before the first upload
    expect((await svc.check()).checkError).toBe('no release of iLive Monitor is on whiteleyevents.co.uk yet');
    res = () => json({ success: false, data: { error: 'Rate limited' } }, 429); // other refusals keep the server's reason
    expect((await svc.check()).checkError).toBe('update server replied 429: Rate limited');
    res = () => new Response('<html>', { status: 200 });
    expect((await svc.check()).checkError).toBe('update server sent an unreadable reply');
    res = () => json({ success: true, data: {} });
    expect((await svc.check()).checkError).toBe('update server has no release listed for iLive Monitor');
    res = () => new Response('x'.repeat(70_000), { status: 200 });
    expect((await svc.check()).checkError).toBe('update feed too large');
    res = () => new Response('{}', { status: 200, headers: { 'content-length': '999999' } });
    expect((await svc.check()).checkError).toBe('update feed too large');
    res = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    expect((await svc.check()).checkError).toBe('fetch failed (ENOTFOUND)');
    // a failed check keeps an update found earlier on offer
    res = () => json(feed('0.5.2'));
    await svc.check();
    res = () => json({}, 500);
    expect(await svc.check()).toMatchObject({ status: 'available', available: { version: '0.5.2' }, checkError: 'update server replied 500' });
    res = () => json(feed('0.5.2'));
    expect((await svc.check()).checkError).toBeNull();
  });

  it('gives up on a slow server after 5 s', async () => {
    vi.useFakeTimers();
    const svc = make((_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const p = svc.check();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).checkError).toBe('no reply in 5 s');
  });

  it('launch check after 20 s prompts once per version; the 30-min poll only updates the pill; both fail silently', async () => {
    vi.useFakeTimers();
    let body: () => Response = () => json(feed('0.5.2'));
    const fetchSpy = vi.fn(async () => body());
    let show = false;
    const svc = make(fetchSpy, { intervalMs: 30 * 60_000, showMode: () => show });
    svc.start();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.current).toMatchObject({ status: 'available', dialog: 'launch' });
    svc.dismiss();

    await vi.advanceTimersByTimeAsync(30 * 60_000); // poll: same version, no second dialog
    expect(svc.current).toMatchObject({ status: 'available', dialog: null });
    body = () => json(feed('0.5.3'));
    await vi.advanceTimersByTimeAsync(30 * 60_000); // poll finds a newer one: pill only
    expect(svc.current).toMatchObject({ available: { version: '0.5.3' }, dialog: null });

    body = () => { throw new Error('offline'); };
    await vi.advanceTimersByTimeAsync(30 * 60_000); // silent: nothing changes, no error shown
    expect(svc.current).toMatchObject({ status: 'available', available: { version: '0.5.3' }, error: null, checkError: null, dialog: null });

    show = true;
    const n = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * 30 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(n); // never in show mode
    svc.stop();
  });

  it('downloads to ~/Downloads, checks our signature, then offers Open installer / Show in Finder', async () => {
    const open = vi.fn(async () => '');
    const reveal = vi.fn();
    const svc = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : bytes('DMGDATA')), { openPath: open, showItemInFolder: reveal });
    await svc.check();
    const progress: number[] = [];
    svc.changed.on((s) => s.progress !== null && progress.push(s.progress));
    const dest = join(dir, 'WEIM-0.5.2-arm64.dmg');
    expect(await svc.download()).toMatchObject({ status: 'downloaded', path: dest, progress: 100, dialog: 'manual' });
    expect(readFileSync(dest, 'utf8')).toBe('DMGDATA');
    expect(open).not.toHaveBeenCalled(); // no auto-open: the operator chooses
    expect(progress.at(-1)).toBe(100);
    await svc.openInstaller();
    expect(open).toHaveBeenCalledWith(dest);
    svc.revealInstaller();
    expect(reveal).toHaveBeenCalledWith(dest);
    // a later poll for the same version keeps the finished download
    expect((await svc.check()).status).toBe('downloaded');
  });

  it("an installer that won't open is shown in Finder instead", async () => {
    const reveal = vi.fn();
    const svc = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : bytes('X')), { openPath: async () => 'no app', showItemInFolder: reveal });
    await svc.check();
    await svc.download();
    await svc.openInstaller();
    expect(reveal).toHaveBeenCalled();
  });

  it("refuses a download that isn't signed by our team, cleans up and offers the page", async () => {
    const openExternal = vi.fn(async () => undefined);
    const svc = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : bytes('EVIL', false)), { signingTeam: async () => 'ABCDE12345', openExternal });
    await svc.check();
    const r = await svc.download();
    expect(r).toMatchObject({ status: 'error', dialog: 'manual', available: { version: '0.5.2' } });
    expect(r.error).toMatch(/not signed by Whiteley Events \(team ABCDE12345\)/);
    expect(readdirSync(dir)).toEqual([]); // no .part or .dmg left behind
    await svc.openPage();
    expect(openExternal).toHaveBeenCalledWith('https://whiteleyevents.co.uk/software/');
  });

  it('with no installer for this Mac, Download opens the download page', async () => {
    const openExternal = vi.fn(async () => undefined);
    const svc = make(async () => json(feed('0.5.2', {}, { download: null })), { openExternal });
    await svc.check();
    await svc.download();
    expect(openExternal).toHaveBeenCalledWith('https://whiteleyevents.co.uk/software/');
    expect(svc.current.status).toBe('available');
  });

  it('handles failed and empty downloads, a check during a download, and misuse', async () => {
    const svc = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : new Response(null, { status: 404 })));
    await expect(svc.download()).rejects.toThrow(/No update available/);
    await expect(svc.openInstaller()).rejects.toThrow(/No installer/);
    expect(() => svc.revealInstaller()).toThrow(/No installer/);
    await svc.check();
    expect((await svc.download()).error).toMatch(/download failed \(404\)/);
    const empty = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : bytes('')));
    await empty.check();
    expect((await empty.download()).error).toMatch(/empty/);

    let release!: () => void;
    const slow = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : (await new Promise<void>((r) => (release = r)), bytes('X'))));
    await slow.check();
    slow.dismiss();
    const dl = slow.download();
    await vi.waitFor(() => expect(slow.current.status).toBe('downloading'));
    expect(await slow.check()).toMatchObject({ status: 'downloading', dialog: 'manual' }); // shows progress, doesn't restart
    release();
    expect((await dl).status).toBe('downloaded');
  });
});

describe('UpdateService — races, windows and stalls', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ilive-upd2-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, over: Partial<UpdateDeps> = {}) =>
    new UpdateService({
      currentVersion: '0.5.1', log: new Logger('error'), downloadsDir: dir,
      fetch: ((u: string, i?: RequestInit) => fetchImpl(u, i)) as typeof fetch,
      signingTeam: async () => TEAM_ID, openPath: vi.fn(async () => ''), showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined),
      showMode: () => false, ...over,
    });
  const gate = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it("two overlapping manual checks share one request and can't leave the status stuck on checking", async () => {
    const g = gate();
    const fetchSpy = vi.fn(async () => { await g.p; throw new Error('offline'); });
    const svc = make(fetchSpy);
    const a = svc.check('w1');
    const b = svc.check('w2'); // menu clicked again, or menu + Settings
    g.open();
    await Promise.all([a, b]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(svc.current).toMatchObject({ status: 'idle', checkError: 'offline', dialog: 'manual', dialogWindow: 'w2' });
    // background checks still run afterwards
    expect((await svc.check()).status).not.toBe('checking');
  });

  it('answers in the window that asked; the launch prompt goes to the focused window', async () => {
    const svc = make(async (u) => (u.includes('welm-api') ? json(feed('0.5.2')) : bytes('X')), { primaryWindowId: () => 'focused' });
    expect((await svc.check('w7')).dialogWindow).toBe('w7');
    expect((await svc.check()).dialogWindow).toBe('focused');
    await (svc as unknown as { automatic(k: string): Promise<void> }).automatic('launch');
    expect(svc.current).toMatchObject({ dialog: 'launch', dialogWindow: 'focused' });
    expect((await svc.download('w3'))).toMatchObject({ status: 'downloaded', dialog: 'manual', dialogWindow: 'w3' });
  });

  it('a download that stops delivering data is abandoned, not left "downloading" for the session', async () => {
    const svc = make(async (u, init) => {
      if (u.includes('welm-api')) return json(feed('0.5.2'));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3])); // a first chunk, then silence
          init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { headers: { 'content-length': '1000' } });
    }, { stallMs: 40 });
    await svc.check();
    const r = await svc.download();
    expect(r).toMatchObject({ status: 'error', dialog: 'manual' });
    expect(r.error).toMatch(/download stalled/);
    expect(readdirSync(dir)).toEqual([]);
    expect((await svc.check()).status).toBe('available'); // checks work again
  });

  it('one download at a time, and a check landing mid-download leaves it alone', async () => {
    const g = gate();
    const feedGate = gate();
    let dmgRequests = 0;
    let slowFeed = false;
    const svc = make(async (u) => {
      if (u.includes('welm-api')) {
        if (slowFeed) await feedGate.p;
        return json(feed('0.5.2'));
      }
      dmgRequests++;
      await g.p;
      return bytes('DMG');
    });
    await svc.check();
    slowFeed = true;
    const poll = (svc as unknown as { automatic(k: string): Promise<void> }).automatic('poll'); // on the wire before Download
    const dl = svc.download();
    await vi.waitFor(() => expect(svc.current.status).toBe('downloading'));
    expect((await svc.download()).status).toBe('downloading'); // second click: ignored
    feedGate.open();
    await poll;
    expect(svc.current).toMatchObject({ status: 'downloading' }); // the late poll didn't reset it to "available"
    g.open();
    expect((await dl).status).toBe('downloaded');
    expect(dmgRequests).toBe(1);
  });
});

describe('codesign team lookup', () => {
  it('reads TeamIdentifier from codesign output; null when unsigned or failing', async () => {
    const run = (out: string, err: Error | null = null) =>
      ((_c: string, _a: string[], cb: (e: Error | null, so: string, se: string) => void) => cb(err, '', out)) as never;
    expect(await signingTeam('/x', run('Identifier=uk.co\nTeamIdentifier=T57Q5FRCB6\n'))).toBe('T57Q5FRCB6');
    expect(await signingTeam('/x', run('TeamIdentifier=not set\n'))).toBeNull();
    expect(await signingTeam('/x', run('', new Error('code object is not signed at all')))).toBeNull();
  });
});
