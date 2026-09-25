import { invoke, subscribe } from '../api/bridge';
import { useAppStore } from '../state/appStore';
import { useMixerStore } from '../state/mixerStore';
import { resnapshot } from './mixer';

/**
 * Wires the window to main: initial snapshot, then sequenced change batches and
 * status events. Returns a disposer.
 */
export async function startSync(): Promise<() => void> {
  const app = useAppStore.getState();
  // Status that arrived by event while the first replies were in flight is newer: don't let those replies undo it.
  const fresh = new Set<string>();
  const live = <K extends 'rack' | 'settings' | 'licence' | 'legal' | 'update'>(key: K) =>
    (value: Parameters<typeof app.set>[0][K]) => {
      fresh.add(key);
      app.set({ [key]: value });
    };

  const unsubs = [
    subscribe('mixer:changes', ({ seq, changes }) => {
      if (!useMixerStore.getState().applyBatch(seq, changes)) void resnapshot();
    }),
    subscribe('mixer:reset', ({ seq, state }) => useMixerStore.getState().reset(seq, state)),
    subscribe('rack:status', live('rack')),
    subscribe('settings:changed', live('settings')),
    subscribe('update:changed', live('update')),
    subscribe('licence:changed', live('licence')),
    subscribe('legal:changed', live('legal')),
  ];

  const [rack, settings, legal, licence] = await Promise.all([
    invoke('rack:status', undefined),
    invoke('settings:get', undefined),
    invoke('legal:status', undefined),
    invoke('licence:status', undefined),
    resnapshot(),
  ]);
  const initial = { rack, settings, legal, licence };
  app.set(Object.fromEntries(Object.entries(initial).filter(([k]) => !fresh.has(k))));
  invoke('update:status', undefined).then((update) => !fresh.has('update') && app.set({ update }), () => undefined);

  return () => unsubs.forEach((u) => u());
}
