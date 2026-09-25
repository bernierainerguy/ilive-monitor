import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import type { EventChannel, IpcEventMap } from '@shared/ipc';
import type { Logger } from '../logging/Logger';

export const WINDOW_ID = 'main';
export const preloadPathFor = (dir: string) => join(dir, '../preload/index.js');

/**
 * iLive Monitor has one window. It hosts the send faders and Settings, talks to
 * main only through the typed preload bridge, and can't navigate or open others.
 */
export class MainWindow {
  private win: BrowserWindow | null = null;

  constructor(
    private readonly log: Logger,
    private readonly preloadPath: string,
    private readonly rendererUrl: string | undefined,
    private readonly rendererFile: string,
  ) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1440,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      show: false,
      backgroundColor: '#131517',
      title: 'iLive Monitor',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win = win;
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log.error('crash', `Renderer gone (${details.reason}); reloading`, { exitCode: details.exitCode });
      if (details.reason !== 'clean-exit') setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 500);
    });
    win.on('unresponsive', () => this.log.warn('window', 'Window unresponsive'));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });

    const query = { windowId: WINDOW_ID };
    if (this.rendererUrl) void win.loadURL(`${this.rendererUrl}?${new URLSearchParams(query)}#/mix`);
    else void win.loadFile(this.rendererFile, { hash: '/mix', query });
  }

  send<K extends EventChannel>(channel: K, payload: IpcEventMap[K]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}
