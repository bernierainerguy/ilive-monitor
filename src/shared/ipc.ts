import type { MixerChange } from './domain/changes';
import type { MixerState } from './domain/model';
import type { LogEntry } from './log';
import type { UpdateState } from './update';
import type { LegalView, LicenceRegistration, LicenceView } from './licence';
import type { LockStatus } from './lock';
import type { RackStatus } from './rack';
import type { MonitorSettings, RackTarget } from './settings';

/**
 * The complete, typed contract between the window and the main process.
 * Preload exposes *only* these channels; anything else is rejected. There is
 * deliberately nothing here for shows, scenes, processing, routing or FX.
 */

export type DispatchResult = { accepted: number; rejected: Array<{ index: number; reason: string }> };

/** What the Settings page may change. Racks go through the rack channels. */
export type SettingsPatch = Partial<Pick<MonitorSettings, 'aux' | 'themeId'>>;

export interface IpcInvokeMap {
  'mixer:snapshot': { req: void; res: { seq: number; state: MixerState } };
  'mixer:dispatch': { req: MixerChange[]; res: DispatchResult };

  'rack:connect': { req: { targetId: string }; res: void };
  'rack:disconnect': { req: void; res: void };
  'rack:status': { req: void; res: RackStatus };
  'rack:saveTarget': { req: RackTarget; res: void };
  'rack:deleteTarget': { req: { id: string }; res: void };
  /** macOS: open System Settings at Privacy & Security › Local Network. */
  'rack:openLocalNetworkSettings': { req: void; res: void };

  'settings:get': { req: void; res: MonitorSettings };
  'settings:update': { req: SettingsPatch; res: MonitorSettings };

  /** The Settings password. Every change Settings can make needs it unlocked. */
  'lock:status': { req: void; res: LockStatus };
  'lock:unlock': { req: { password: string }; res: LockStatus };
  'lock:lock': { req: void; res: LockStatus };
  /** Set or change (a string) or remove (null) the password. Needs Settings unlocked. */
  'lock:setPassword': { req: { password: string | null }; res: LockStatus };

  'update:status': { req: void; res: UpdateState };
  'update:check': { req: void; res: UpdateState };
  'update:download': { req: void; res: UpdateState };
  'update:openInstaller': { req: void; res: UpdateState };
  'update:reveal': { req: void; res: UpdateState };
  'update:openPage': { req: void; res: UpdateState };
  'update:dismiss': { req: void; res: UpdateState };
  'licence:status': { req: void; res: LicenceView };
  'licence:register': { req: LicenceRegistration; res: LicenceView };
  'licence:checkin': { req: void; res: LicenceView };
  'legal:status': { req: void; res: LegalView };
  'legal:accept': { req: void; res: LegalView };
  /** Declining the EULA quits the app. */
  'legal:decline': { req: void; res: void };

  'log:write': { req: Omit<LogEntry, 'ts'>; res: void };
}

export interface IpcEventMap {
  'mixer:changes': { seq: number; changes: MixerChange[] };
  'mixer:reset': { seq: number; state: MixerState };
  'rack:status': RackStatus;
  'settings:changed': MonitorSettings;
  'lock:changed': LockStatus;
  'nav:goto': { path: string };
  'update:changed': UpdateState;
  'licence:changed': LicenceView;
  'legal:changed': LegalView;
}

export type InvokeChannel = keyof IpcInvokeMap;
export type EventChannel = keyof IpcEventMap;

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  'mixer:snapshot', 'mixer:dispatch',
  'rack:connect', 'rack:disconnect', 'rack:status', 'rack:saveTarget', 'rack:deleteTarget', 'rack:openLocalNetworkSettings',
  'settings:get', 'settings:update', 'lock:status', 'lock:unlock', 'lock:lock', 'lock:setPassword',
  'update:status', 'update:check', 'update:download', 'update:openInstaller', 'update:reveal', 'update:openPage', 'update:dismiss',
  'licence:status', 'licence:register', 'licence:checkin', 'legal:status', 'legal:accept', 'legal:decline',
  'log:write',
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  'mixer:changes', 'mixer:reset', 'rack:status', 'settings:changed', 'lock:changed', 'nav:goto', 'update:changed', 'licence:changed', 'legal:changed',
];

/** Shape of `window.ilive` exposed by preload. */
export interface ILiveBridge {
  invoke<K extends InvokeChannel>(channel: K, req: IpcInvokeMap[K]['req']): Promise<IpcInvokeMap[K]['res']>;
  on<K extends EventChannel>(channel: K, cb: (payload: IpcEventMap[K]) => void): () => void;
  platform: string;
  /** Runtime versions for Settings → About (absent in tests / non-Electron hosts). */
  versions?: { electron: string; chrome: string; node: string; os: string };
}
