import { act, cleanup, render } from '@testing-library/react';
import { App } from '@renderer/App';
import { setBridge } from '@renderer/api/bridge';
import { flush } from '@renderer/services/mixer';
import { startSync } from '@renderer/services/sync';
import { useAppStore, initialRackStatus } from '@renderer/state/appStore';
import { useMixerStore } from '@renderer/state/mixerStore';
import { createBackend, type Backend, type Extras } from './backend';

/** Boot the window against a fresh in-process backend, at a given route. */
export async function bootApp(path = '/mix', extras: Extras = {}, opts: Parameters<typeof createBackend>[1] = {}): Promise<{ be: Backend; stop(keepDir?: boolean): Promise<void> }> {
  const be = await createBackend(extras, opts);
  setBridge(be.bridge);
  useAppStore.setState({ rack: initialRackStatus, settings: null, lock: null, toast: null, licence: null, legal: null, licenceNoticeDismissed: null, update: null, updateDialogOpen: false });
  useMixerStore.setState({ state: null, seq: -1 });
  const unsync = await startSync();
  window.history.replaceState(null, '', `/?windowId=main#${path}`);
  render(<App />);
  return {
    be,
    async stop(keepDir = false) {
      cleanup();
      await act(async () => {
        await flush();
        await new Promise((r) => setTimeout(r, 10));
      });
      unsync();
      await be.dispose(keepDir);
    },
  };
}

/** Wait until pending renderer dispatches have reached the backend cache. */
export async function settle() {
  await act(async () => {
    await flush();
    await new Promise((r) => setTimeout(r, 15));
  });
}
