import { join } from 'node:path';
import { hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BrowserWindow, Menu, app, crashReporter, net, powerSaveBlocker, shell, type BaseWindow } from 'electron';
import { createDefaultMixerState } from '@shared/domain/defaults';
import { auxBusIndex } from '@shared/monitorPolicy';
import { Logger, consoleSink, createFileSink } from './logging/Logger';
import { StateCache } from './rack/StateCache';
import { RackSession } from './rack/RackSession';
import { createProtocol } from './protocol/factory';
import { MixerService } from './services/MixerService';
import { SettingsService } from './services/SettingsService';
import { LockService } from './services/LockService';
import { UpdateService } from './services/UpdateService';
import { signingTeam } from './services/codesign';
import { LicenceService } from './services/LicenceService';
import { LegalService } from './services/LegalService';
import { MainWindow, WINDOW_ID, preloadPathFor } from './windows/MainWindow';
import { registerIpc } from './ipc/registerIpc';

/**
 * Composition root. The only file that knows about every layer; everything else
 * receives its collaborators through constructors.
 */

const started = performance.now();

// Isolated data dir for e2e tests, or a second monitor position on the same Mac.
if (process.env['ILIVE_MONITOR_USER_DATA']) app.setPath('userData', process.env['ILIVE_MONITOR_USER_DATA']);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

async function bootstrap() {
  crashReporter.start({ uploadToServer: false, compress: true });

  const userData = app.getPath('userData');
  const log = new Logger(app.isPackaged ? 'info' : 'debug');
  log.addSink(createFileSink(app.getPath('logs')));
  if (!app.isPackaged) log.addSink(consoleSink);

  process.on('uncaughtException', (err) => log.error('crash', `Uncaught: ${err.message}`, { stack: err.stack }));
  process.on('unhandledRejection', (r) => log.error('crash', `Unhandled rejection: ${String(r)}`));
  app.on('child-process-gone', (_e, d) => log.error('crash', `Child process gone: ${d.type} ${d.reason}`));

  await app.whenReady();

  // macOS App Nap would throttle our timers and sockets when the window is covered.
  powerSaveBlocker.start('prevent-app-suspension');

  // Packaged builds get the icon from the bundle; in dev, show it in the Dock too.
  const devIcon = join(__dirname, '../../build/icon.png');
  if (!app.isPackaged && existsSync(devIcon)) app.dock?.setIcon(devIcon);

  const settings = new SettingsService(join(userData, 'settings.json'), log);
  await settings.init();
  // Its own file, so deleting it removes a forgotten password and nothing else.
  const lock = new LockService(join(userData, 'settings-lock.json'), log);
  await lock.init();
  const cache = new StateCache(createDefaultMixerState());
  // The chosen aux, as a mix index under the rack's current mix configuration.
  const bus = () => auxBusIndex(cache.state, settings.current.aux);
  const rack = new RackSession(cache, log, createProtocol, { bus });
  const mixer = new MixerService(cache, rack, log, bus);
  // Lay the mixes out as the last rack has them, so Settings offers its auxes before connecting.
  const lastRack = settings.current.racks.find((r) => r.id === settings.current.lastTargetId);
  if (lastRack) rack.conform(lastRack);

  const window = new MainWindow(log, preloadPathFor(__dirname), process.env['ELECTRON_RENDERER_URL'], join(__dirname, '../renderer/index.html'));

  cache.batches.on((b) => window.send('mixer:changes', b));
  cache.resets.on((r) => window.send('mixer:reset', r));
  rack.status.on((s) => window.send('rack:status', s));
  lock.changed.on((l) => window.send('lock:changed', l));
  let lastAux = settings.current.aux;
  settings.changed.on((s) => {
    window.send('settings:changed', s);
    if (s.aux !== lastAux) {
      lastAux = s.aux;
      rack.busChanged();
      log.info('user', `Mix set to ${s.aux === null ? 'none' : `Aux ${s.aux}`}`);
    }
  });
  // Disconnecting clears it, so a rack the operator disconnected from isn't reconnected at the next launch.
  const offLastTarget = rack.status.on((s) => settings.setLastTarget(s.targetId));

  // --- updates: checked against whiteleyevents.co.uk --------------------------------------
  const updates = new UpdateService({
    currentVersion: app.getVersion(),
    log,
    downloadsDir: app.getPath('downloads'),
    fetch: (input, init) => net.fetch(input as string, init),
    signingTeam: (p) => signingTeam(p),
    openPath: (p) => shell.openPath(p),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (url) => shell.openExternal(url),
    showMode: () => false,
    primaryWindowId: () => WINDOW_ID,
  });
  updates.changed.on((u) => window.send('update:changed', u));
  if (app.isPackaged) updates.start();
  Menu.setApplicationMenu(appMenu((win) => {
    if (!(win instanceof BrowserWindow)) window.open();
    void updates.check(WINDOW_ID);
  }));

  // --- EULA and licence check-in (enforced only at launch; see LicenceService) --------------
  const legal = new LegalService(join(userData, 'eula-acceptance.json'), log);
  await legal.init();
  const licence = new LicenceService({
    statePath: join(userData, 'licence-checkin.json'),
    version: app.getVersion(),
    hostname: computerName(),
    log,
    fetch: (input, init) => net.fetch(input as string, init),
    showMode: () => false,
    server: process.env['ILIVE_LICENCE_SERVER'],
  });
  await licence.init();
  legal.changed.on((l) => window.send('legal:changed', l));
  licence.changed.on((l) => window.send('licence:changed', l));
  void licence.checkin();
  licence.start();

  registerIpc({ log, cache, session: rack, mixer, settings, lock, updates, licence, legal, quit: () => app.quit(), openExternal: (url) => shell.openExternal(url) });

  window.open();

  // --- reconnect to the last rack on launch ------------------------------------------------
  // Waits until the operator may use the app (EULA accepted, launch gate open).
  const target = settings.current.racks.find((c) => c.id === settings.current.lastTargetId && c.autoConnect);
  if (target) {
    const ready = () => legal.accepted && licence.view.launch.allowed;
    if (ready()) rack.connect(target);
    else {
      const offs: Array<() => void> = [];
      const tryConnect = () => {
        if (!ready()) return;
        offs.forEach((off) => off());
        rack.connect(target);
      };
      offs.push(legal.changed.on(tryConnect), licence.changed.on(tryConnect));
    }
  }

  app.on('second-instance', () => window.open());
  app.on('activate', () => window.open());
  app.on('window-all-closed', () => app.quit());

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void (async () => {
      try {
        offLastTarget(); // quitting disconnects, but the rack should still reconnect at the next launch
        await settings.flush();
        await lock.flush();
        await rack.drain(); // the last move before quitting still reaches the rack
        rack.dispose();
        licence.stop();
        updates.stop();
        lock.dispose();
      } finally {
        app.exit(0);
      }
    })();
  });

  log.info('system', `Startup complete in ${Math.round(performance.now() - started)} ms`, { version: app.getVersion() });
}

/** The Mac's friendly name ("Bernie's Mac mini"), for the licence form; the bare host name elsewhere. */
function computerName(): string {
  if (process.platform === 'darwin') {
    try {
      const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (n) return n;
    } catch {
      /* fall through */
    }
  }
  return hostname().split('.')[0] ?? hostname();
}

/** The standard macOS menus, with "Check for Updates…" in the app menu (as in WESC). */
function appMenu(checkForUpdates: (win: BaseWindow | undefined) => void): Menu {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: (_item, win) => checkForUpdates(win) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}
