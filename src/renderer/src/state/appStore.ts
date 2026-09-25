import { create } from 'zustand';
import { NO_CAPABILITIES, emptyHealth, type RackStatus } from '@shared/rack';
import type { MonitorSettings } from '@shared/settings';
import type { UpdateState } from '@shared/update';
import type { LegalView, LicenceReason, LicenceView } from '@shared/licence';

/** Low-frequency application state mirrored from main: connection, settings, updates, licence. */
interface AppStore {
  rack: RackStatus;
  settings: MonitorSettings | null;
  update: UpdateState | null;
  /** The operator opened the update dialog from the top-bar pill. */
  updateDialogOpen: boolean;
  licence: LicenceView | null;
  legal: LegalView | null;
  /** Licence notice the operator closed this session. */
  licenceNoticeDismissed: LicenceReason | null;
  toast: { message: string; severity: 'info' | 'success' | 'warning' | 'error' } | null;
  set(p: Partial<Omit<AppStore, 'set' | 'notify'>>): void;
  notify(message: string, severity?: 'info' | 'success' | 'warning' | 'error'): void;
}

export const initialRackStatus: RackStatus = {
  phase: 'offline', targetId: null, identity: null, capabilities: NO_CAPABILITIES, health: emptyHealth(),
  lastError: null, cacheUnverified: false, unconfirmed: [],
};

export const useAppStore = create<AppStore>((set) => ({
  rack: initialRackStatus,
  settings: null,
  update: null,
  updateDialogOpen: false,
  licence: null,
  legal: null,
  licenceNoticeDismissed: null,
  toast: null,
  set: (p) => set(p),
  notify: (message, severity = 'info') => set({ toast: { message, severity } }),
}));
