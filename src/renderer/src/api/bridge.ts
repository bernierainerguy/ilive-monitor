import type { EventChannel, ILiveBridge, InvokeChannel, IpcEventMap, IpcInvokeMap } from '@shared/ipc';

/**
 * The renderer's only door to the main process. Screens and components never
 * call this directly — they go through stores and services.
 */
let override: ILiveBridge | null = null;

/** Tests inject a fake bridge. */
export function setBridge(b: ILiveBridge | null) {
  override = b;
}

function bridge(): ILiveBridge {
  const b = override ?? (typeof window !== 'undefined' ? window.ilive : undefined);
  if (!b) throw new Error('iLive bridge unavailable (not running inside Electron?)');
  return b;
}

export const invoke = <K extends InvokeChannel>(channel: K, req: IpcInvokeMap[K]['req']): Promise<IpcInvokeMap[K]['res']> =>
  bridge().invoke(channel, req);

export const subscribe = <K extends EventChannel>(channel: K, cb: (p: IpcEventMap[K]) => void): (() => void) =>
  bridge().on(channel, cb);

export const windowId = (): string => new URLSearchParams(window.location.search).get('windowId') ?? 'main';

export const runtimeVersions = (): ILiveBridge['versions'] => (override ?? (typeof window !== 'undefined' ? window.ilive : undefined))?.versions;
