import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '../logging/Logger';
import { Emitter } from '../transport/Transport';
import type { UpdateInfo, UpdateState } from '@shared/update';

/**
 * Update checks against the Whiteley Events site, modelled on WESC
 * (~/Developer/wesc-update-checks.md):
 *
 * - `welm-api.php?action=latest&product=weim` names the current release.
 * - Launch check 20 s after start (after the licence check-in's cold-DNS window):
 *   a newer version gets a Download / Later dialog. Then a quiet poll every
 *   30 min that only lights the top-bar pill. Both fail silently; only
 *   "Check for Updates…" reports why a check failed.
 * - Strictly newer only: a rollback on the site never offers a downgrade.
 * - No auto-install: the DMG goes to ~/Downloads, then Open installer / Show in
 *   Finder / Later. A failed download offers the download page instead.
 * - Never in show mode.
 *
 * Stricter than WESC: installers must be https on whiteleyevents.co.uk, and a
 * download must be signed by our team before we offer to open it.
 */
export const SITE = 'https://whiteleyevents.co.uk';
export const DOWNLOAD_PAGE = `${SITE}/software/`;
/** Product key in wp-admin → Software → Products (title "Whiteley Events A&H iLive Monitor"). One casing, so one request. */
export const PRODUCT_KEY = 'weim';
/** Feed keys for this build, in order of preference (Apple Silicon only). */
export const PLATFORM_KEYS = ['macos-arm', 'macos'] as const;
export const TEAM_ID = 'T57Q5FRCB6';
export const FEED_TIMEOUT_MS = 5000;
export const FEED_MAX_BYTES = 64 * 1024;
/** A download that delivers nothing for this long is abandoned (venue Wi-Fi dropped mid-transfer). */
export const DOWNLOAD_STALL_MS = 60_000;

export type { UpdateInfo, UpdateState };

/** Compare x.y.z versions; non-numeric parts count as 0 (semver-ish: pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

const onSite = (raw: unknown): URL | null => {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'whiteleyevents.co.uk' ? u : null;
  } catch {
    return null;
  }
};

/**
 * An installer we'd download: https on our site, a plain .dmg name. The live feed's
 * `filename` is a folder path ("WESC/MAC/WESC-1.7.311-arm64.dmg"); only its last part
 * is used, so nothing can steer the save outside Downloads.
 */
function installer(url: unknown, filename: unknown): { url: string; filename: string } | null {
  const u = onSite(url);
  if (!u) return null;
  const raw = typeof filename === 'string' && filename ? filename : decodeURIComponent(u.pathname);
  const name = raw.split(/[\\/]/).pop() ?? '';
  return /^[\w.-]+\.dmg$/i.test(name) ? { url: u.toString(), filename: name } : null;
}

/**
 * Parse the feed. Needs `success` and `data.version`. The installer is the first
 * platform key with a usable URL, else `data.download`; with neither, only the
 * download page is offered — never a wrong installer.
 */
export function parseLatest(body: unknown): UpdateInfo | null {
  const b = body as { success?: unknown; data?: Record<string, unknown> } | null;
  const data = b?.data;
  if (!b?.success || !data || typeof data.version !== 'string' || !data.version) return null;
  const platforms = (data.platforms ?? {}) as Record<string, { url?: unknown; filename?: unknown } | undefined>;
  let pick: { url: string; filename: string } | null = null;
  for (const key of PLATFORM_KEYS) {
    pick = installer(platforms[key]?.url, platforms[key]?.filename);
    if (pick) break;
  }
  pick ??= installer(data.download, null);
  const page = onSite(data.page)?.toString() ?? DOWNLOAD_PAGE;
  return { version: data.version, url: pick?.url ?? null, filename: pick?.filename ?? null, page };
}

/** Read a response body, aborting past `max` bytes (a feed is a few hundred bytes). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > max) throw new Error('update feed too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new Error('update feed too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface UpdateDeps {
  currentVersion: string;
  log: Logger;
  downloadsDir: string;
  /** Electron's net.fetch in the app (Chromium's network stack: proxies and corporate roots work). */
  fetch: typeof fetch;
  /** Returns the Team ID the file is signed with, or null. */
  signingTeam(path: string): Promise<string | null>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  openExternal(url: string): Promise<void>;
  showMode(): boolean;
  /** Where an unrequested dialog goes (the launch prompt): the focused window, else the first. */
  primaryWindowId?(): string | null;
  launchCheckMs?: number;
  intervalMs?: number;
  stallMs?: number;
}

type CheckKind = 'launch' | 'poll' | 'manual';

export class UpdateService {
  readonly changed = new Emitter<UpdateState>();
  private state: UpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** The launch dialog appears once per version per session. */
  private prompted: string | null = null;
  /** One check at a time: overlapping checks used to restore each other's "checking" status. */
  private inflight: Promise<UpdateState> | null = null;
  private inflightKind: CheckKind | null = null;

  constructor(private readonly d: UpdateDeps) {
    this.state = { status: 'idle', current: d.currentVersion, available: null, progress: null, path: null, error: null, checkError: null, checkedAt: null, dialog: null, dialogWindow: null };
  }

  get current(): UpdateState {
    return this.state;
  }

  /** Launch check after 20 s, then a quiet poll every 30 min. Nothing at all in show mode. */
  start() {
    this.stop();
    this.timer = setTimeout(() => void this.automatic('launch'), this.d.launchCheckMs ?? 20_000);
    this.interval = setInterval(() => void this.automatic('poll'), this.d.intervalMs ?? 30 * 60_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  private async automatic(kind: 'launch' | 'poll') {
    if (this.d.showMode()) return;
    if (this.state.status === 'downloading' || this.state.status === 'checking') return;
    await this.run(kind);
  }

  /** "Check for Updates…": always answers with a dialog, in `windowId` (the window that asked). */
  check(windowId: string | null = null): Promise<UpdateState> {
    return this.run('manual', windowId);
  }

  private at(windowId: string | null): string | null {
    return windowId ?? this.d.primaryWindowId?.() ?? null;
  }

  private run(kind: CheckKind, windowId: string | null = null): Promise<UpdateState> {
    if (this.inflight) {
      if (kind !== 'manual') return this.inflight;
      // A second "Check for Updates…" answers when a manual check under way finishes. A background
      // check fails silently, so after one of those, run a real manual check to give a real answer.
      if (this.inflightKind === 'manual') {
        return this.inflight.then(() => {
          this.patch({ dialog: 'manual', dialogWindow: this.at(windowId) });
          return this.state;
        });
      }
      return this.inflight.then(() => this.run('manual', windowId));
    }
    this.inflightKind = kind;
    this.inflight = this.doRun(kind, windowId).finally(() => {
      this.inflight = null;
      this.inflightKind = null;
    });
    return this.inflight;
  }

  private async doRun(kind: CheckKind, windowId: string | null): Promise<UpdateState> {
    const before = this.state;
    const manual = kind === 'manual' ? { dialog: 'manual' as const, dialogWindow: this.at(windowId) } : {};
    if (before.status === 'downloading') {
      // A download is already under way: the dialog shows its progress instead.
      if (kind === 'manual') this.patch(manual);
      return this.state;
    }
    if (kind === 'manual') this.patch({ status: 'checking', checkError: null, dialog: null });
    try {
      const latest = await this.fetchLatest();
      const checkedAt = new Date().toISOString();
      if (this.state.status !== (kind === 'manual' ? 'checking' : before.status)) {
        // A download started, finished or failed while this check was on the wire: leave its state alone.
        this.patch({ checkedAt, ...manual });
        return this.state;
      }
      if (latest && compareVersions(latest.version, this.d.currentVersion) > 0) {
        if (before.available?.version !== latest.version) this.d.log.info('system', `Update ${latest.version} available`);
        // Keep a finished download of this same version.
        const keep = before.available?.version === latest.version && before.status === 'downloaded';
        const launchPrompt = kind === 'launch' && this.prompted !== latest.version;
        if (launchPrompt) this.prompted = latest.version;
        const dialog = kind === 'manual' ? manual : launchPrompt ? { dialog: 'launch' as const, dialogWindow: this.at(null) } : {};
        this.patch({ ...(keep ? { status: 'downloaded' } : { status: 'available', path: null, progress: null, error: null }), available: latest, checkedAt, checkError: null, ...dialog });
      } else {
        this.patch({ status: 'up-to-date', available: null, path: null, progress: null, checkedAt, error: null, checkError: null, ...manual });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (kind === 'manual') {
        this.d.log.warn('system', `Update check failed: ${msg}`);
        // Back to where we were (an update already found stays offered), plus the reason, unless a
        // download changed the status meanwhile.
        this.patch({ ...(this.state.status === 'checking' ? { status: before.status } : {}), checkError: msg, ...manual });
      } else {
        // Automatic checks fail silently: a venue without internet sees nothing.
        this.d.log.info('system', `Background update check failed: ${msg}`);
      }
    }
    return this.state;
  }

  private async fetchLatest(): Promise<UpdateInfo | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`no reply in ${FEED_TIMEOUT_MS / 1000} s`)), FEED_TIMEOUT_MS);
    try {
      const res = await this.d.fetch(`${SITE}/welm-api.php?action=latest&product=${PRODUCT_KEY}`, {
        headers: { Accept: 'application/json' }, signal: abort.signal,
      });
      let body: unknown;
      try {
        body = JSON.parse(await readCapped(res, FEED_MAX_BYTES));
      } catch (err) {
        if ((err as Error).message === 'update feed too large') throw err;
        throw new Error(res.ok ? 'update server sent an unreadable reply' : `update server replied ${res.status}`);
      }
      if (!res.ok) {
        // e.g. 404 {"success":false,"data":{"error":"Unknown product or no installers available."}} before the first upload
        const why = (body as { data?: { error?: unknown } } | null)?.data?.error;
        // The site's answer until the product exists and has an installer: nothing is wrong on this Mac. Other 404s
        // (a moved API, a wrong product key) keep the server's own words.
        if (res.status === 404 && typeof why === 'string' && /unknown product|no installers/i.test(why)) {
          throw new Error('no release of iLive Monitor is on whiteleyevents.co.uk yet');
        }
        throw new Error(`update server replied ${res.status}${typeof why === 'string' && why ? `: ${why}` : ''}`);
      }
      const latest = parseLatest(body);
      if (!latest) throw new Error('update server has no release listed for iLive Monitor');
      return latest;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw cause ? new Error(`${(err as Error).message} (${cause})`) : err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Windows opened or closed: a dialog meant for a window that's gone moves to the focused one. */
  windowsChanged(open: readonly string[]): void {
    const w = this.state.dialogWindow;
    if (this.state.dialog && w && !open.includes(w)) this.patch({ dialogWindow: this.at(null) });
  }

  dismiss(): UpdateState {
    if (this.state.dialog) this.patch({ dialog: null });
    return this.state;
  }

  /**
   * Download the available DMG to ~/Downloads and check it is signed by our team.
   * With no installer for this Mac in the feed, open the download page instead.
   */
  async download(windowId: string | null = null): Promise<UpdateState> {
    const info = this.state.available;
    if (!info) throw new Error('No update available');
    if (this.state.status === 'downloading') return this.state; // one download at a time: two would share the .part file
    const answer = { dialog: 'manual' as const, dialogWindow: this.at(windowId) };
    this.patch({ dialog: null, checkError: null }); // from here on, what matters is how the download goes
    if (!info.url || !info.filename) {
      await this.openPage();
      return this.state;
    }
    const dest = join(this.d.downloadsDir, info.filename);
    const tmp = `${dest}.part`;
    this.patch({ status: 'downloading', progress: 0, error: null, path: null });
    const abort = new AbortController();
    const stallMs = this.d.stallMs ?? DOWNLOAD_STALL_MS;
    let stall: ReturnType<typeof setTimeout> | null = null;
    const watch = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => abort.abort(new Error(`download stalled (no data for ${Math.round(stallMs / 1000)} s)`)), stallMs);
    };
    watch();
    try {
      const res = await this.d.fetch(info.url, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let lastPct = -1;
      const body = Readable.fromWeb(res.body as unknown as WebReadableStream);
      body.on('data', (chunk: Buffer) => {
        watch();
        got += chunk.length;
        const pct = total ? Math.floor((got / total) * 100) : null;
        if (pct !== null && pct !== lastPct) {
          lastPct = pct;
          this.patch({ progress: pct });
        }
      });
      await pipeline(body, createWriteStream(tmp));
      if (got === 0) throw new Error('downloaded file is empty');
      const team = await this.d.signingTeam(tmp);
      if (team !== TEAM_ID) throw new Error(`downloaded installer is not signed by Whiteley Events (team ${team ?? 'none'})`);
      await fs.rename(tmp, dest);
      this.d.log.info('system', `Downloaded update ${info.version} to ${dest}`);
      this.patch({ status: 'downloaded', progress: 100, path: dest, ...answer }); // Open installer / Show in Finder / Later
    } catch (err) {
      await fs.rm(tmp, { force: true });
      const msg = abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason.message : (err as Error).message;
      this.d.log.error('system', `Update download failed: ${msg}`);
      this.patch({ status: 'error', progress: null, error: msg, ...answer }); // offers the download page
    } finally {
      if (stall) clearTimeout(stall);
    }
    return this.state;
  }

  async openInstaller(): Promise<UpdateState> {
    const p = this.state.path;
    if (!p) throw new Error('No installer downloaded');
    const err = await this.d.openPath(p);
    if (err) {
      this.d.log.warn('system', `Could not open ${p}: ${err}`);
      this.d.showItemInFolder(p);
    }
    return this.state;
  }

  revealInstaller(): UpdateState {
    if (!this.state.path) throw new Error('No installer downloaded');
    this.d.showItemInFolder(this.state.path);
    return this.state;
  }

  /** The product's download page (only ever on whiteleyevents.co.uk; see parseLatest). */
  async openPage(): Promise<UpdateState> {
    await this.d.openExternal(this.state.available?.page ?? DOWNLOAD_PAGE);
    return this.state;
  }

  private patch(p: Partial<UpdateState>) {
    this.state = { ...this.state, ...p };
    this.changed.emit(this.state);
  }
}
