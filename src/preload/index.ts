import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type ILiveBridge } from '@shared/ipc';

/**
 * The only surface the renderer can reach. Channels are allow-listed; the
 * renderer never gets ipcRenderer, Node, or arbitrary channels.
 */
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge: ILiveBridge = {
  invoke(channel, req) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel ${channel}`));
    return ipcRenderer.invoke(channel, req);
  },
  on(channel, cb) {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event ${channel}`);
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload as never);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    os: process.getSystemVersion?.() ?? '',
  },
};

contextBridge.exposeInMainWorld('ilive', bridge);

