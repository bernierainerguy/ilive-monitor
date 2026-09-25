import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { mixConfigError, parseMixConfig, type RackMixConfig } from '@shared/mixLayout';
import type { InvokeChannel, IpcInvokeMap } from '@shared/ipc';
import type { UpdateState } from '@shared/update';
import type { LegalView, LicenceView } from '@shared/licence';
import type { Logger } from '../logging/Logger';
import type { RackSession } from '../rack/RackSession';
import type { StateCache } from '../rack/StateCache';
import type { MixerService } from '../services/MixerService';
import type { SettingsService } from '../services/SettingsService';
import type { UpdateService } from '../services/UpdateService';
import type { LicenceService } from '../services/LicenceService';
import type { LegalService } from '../services/LegalService';
import type { LockService } from '../services/LockService';
import { WINDOW_ID } from '../windows/MainWindow';

export interface IpcDeps {
  log: Logger;
  cache: StateCache;
  session: RackSession;
  mixer: MixerService;
  settings: SettingsService;
  /** The Settings password. Absent in tests that don't need it: then Settings is always open. */
  lock?: LockService;
  updates?: UpdateService;
  licence?: LicenceService;
  legal?: LegalService;
  /** Quit the app (EULA declined). */
  quit?: () => void;
  /** Open a fixed system URL (System Settings panes). */
  openExternal?: (url: string) => Promise<void>;
}

const LOCAL_NETWORK_SETTINGS = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork';

type Handler<K extends InvokeChannel> = (req: IpcInvokeMap[K]['req'], e: IpcMainInvokeEvent) => IpcInvokeMap[K]['res'] | Promise<IpcInvokeMap[K]['res']>;

/** Every channel the window can call. There is nothing here for shows, scenes, processing, routing or FX. */
export function registerIpc(d: IpcDeps) {
  function handle<K extends InvokeChannel>(channel: K, fn: Handler<K>) {
    ipcMain.handle(channel, async (e, req) => {
      try {
        return await fn(req as IpcInvokeMap[K]['req'], e);
      } catch (err) {
        d.log.warn('system', `IPC ${channel} failed: ${(err as Error).message}`);
        throw err;
      }
    });
  }

  /** Everything Settings can change needs it unlocked. Checked here, not just in the window. */
  const unlocked = () => d.lock?.require();

  // --- mixer: send levels to the chosen bus only (MixerService enforces it) ---
  handle('mixer:snapshot', () => d.cache.snapshot());
  handle('mixer:dispatch', (changes) => d.mixer.dispatch(Array.isArray(changes) ? changes : []));

  // --- rack -----------------------------------------------------------------
  handle('rack:status', () => d.session.current);
  handle('rack:connect', ({ targetId }) => {
    unlocked();
    const t = d.settings.current.racks.find((c) => c.id === targetId);
    if (!t) throw new Error('Unknown rack');
    d.session.connect(t);
  });
  handle('rack:disconnect', () => {
    unlocked();
    d.session.disconnect();
  });
  handle('rack:saveTarget', (t) => {
    unlocked();
    if (t.mixConfig !== undefined && !parseMixConfig(t.mixConfig)) throw new Error(mixConfigError(t.mixConfig as RackMixConfig) ?? 'Invalid rack mix configuration');
    const before = d.settings.current.racks.find((c) => c.id === t.id);
    const after = d.settings.upsertRack(t).racks.find((c) => c.id === t.id)!;
    // Where the rack is (address, protocol, MIDI channel) and its mix configuration decide what every send
    // reaches: if any of them changed on the rack in use, reconnect so it takes effect now, even mid-retry.
    const wire = (r: typeof after | undefined) => JSON.stringify(r ? [r.host, r.port, r.protocol, r.midiChannel, r.mixConfig ?? null] : null);
    const inUse = d.session.current.targetId === t.id && d.session.current.phase !== 'offline';
    const changed = wire(before) !== wire(after);
    if (inUse && changed) d.session.connect(after);
    // Offline, lay the mixes out now, so Settings offers this rack's auxes before connecting.
    else if (changed && d.session.current.phase === 'offline') d.session.conform(after);
  });
  handle('rack:deleteTarget', ({ id }) => {
    unlocked();
    if (d.session.current.targetId === id) d.session.disconnect();
    d.settings.deleteRack(id);
  });
  handle('rack:openLocalNetworkSettings', async () => {
    await d.openExternal?.(LOCAL_NETWORK_SETTINGS);
  });

  // --- settings -------------------------------------------------------------
  handle('settings:get', () => d.settings.current);
  handle('settings:update', (patch) => {
    unlocked();
    return d.settings.update({ aux: patch?.aux, themeId: patch?.themeId });
  });

  // --- the Settings password --------------------------------------------------
  const open = () => ({ hasPassword: false, unlocked: true, retryAt: null });
  handle('lock:status', () => d.lock?.status ?? open());
  handle('lock:unlock', ({ password }) => d.lock?.unlock(password) ?? open());
  handle('lock:lock', () => d.lock?.lock() ?? open());
  handle('lock:setPassword', ({ password }) => d.lock?.setPassword(password) ?? open());

  // --- updates --------------------------------------------------------------
  const noUpdates = (checkError: string | null = 'Updates are unavailable in this build'): UpdateState =>
    ({ status: 'idle', current: '', available: null, progress: null, path: null, error: null, checkError, checkedAt: null, dialog: null, dialogWindow: null });
  handle('update:status', () => d.updates?.current ?? noUpdates(null));
  handle('update:check', () => d.updates?.check(WINDOW_ID) ?? noUpdates());
  handle('update:download', () => d.updates?.download(WINDOW_ID) ?? noUpdates());
  handle('update:openInstaller', () => d.updates?.openInstaller() ?? noUpdates());
  handle('update:reveal', () => d.updates?.revealInstaller() ?? noUpdates());
  handle('update:openPage', () => d.updates?.openPage() ?? noUpdates());
  handle('update:dismiss', () => d.updates?.dismiss() ?? noUpdates());

  // --- licence and EULA: absent in tests and non-Electron hosts, where everything is allowed ---
  const unlicensed = (): LicenceView => ({
    identity: null, installId: null, status: 'unknown', deniedReason: null, lastCheckinAt: null, graceUntil: null, lastError: null,
    reason: 'granted', allowed: true, graceDaysLeft: null, launch: { allowed: true, reason: 'granted', showMode: false }, checking: false, machineName: '',
  });
  const noLegal = (): LegalView => ({ eulaVersion: '', accepted: true, acceptedAt: null });
  handle('licence:status', () => d.licence?.view ?? unlicensed());
  handle('licence:register', ({ name, email }) => {
    // First registration happens at the launch screen, before anyone can reach Settings; changing it is a Settings change.
    if (d.licence?.view.identity) unlocked();
    return d.licence?.register({ name, email }) ?? unlicensed();
  });
  handle('licence:checkin', async () => {
    if (!d.licence) return unlicensed();
    await d.licence.checkin();
    return d.licence.view;
  });
  handle('legal:status', () => d.legal?.view ?? noLegal());
  handle('legal:accept', () => d.legal?.accept() ?? noLegal());
  handle('legal:decline', () => {
    d.log.info('system', 'EULA declined; quitting');
    d.quit?.();
  });

  // --- logs -----------------------------------------------------------------
  handle('log:write', (entry) => d.log.log(entry.level, entry.category, `[renderer] ${entry.message}`, entry.data));
}
