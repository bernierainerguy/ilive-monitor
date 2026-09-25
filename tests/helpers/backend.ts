import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultMixerState } from '@shared/domain/defaults';
import { auxBusIndex } from '@shared/monitorPolicy';
import type { EventChannel, ILiveBridge, IpcEventMap } from '@shared/ipc';
import { SIMULATOR_CAPABILITIES, SimulatedRack, SimulatorProtocol } from '@main/protocol/simulator/SimulatorProtocol';
import { Logger } from '@main/logging/Logger';
import { registerIpc, type IpcDeps } from '@main/ipc/registerIpc';
import { RackSession } from '@main/rack/RackSession';
import { StateCache } from '@main/rack/StateCache';
import { MixerService } from '@main/services/MixerService';
import { SettingsService } from '@main/services/SettingsService';
import { handlers } from './electronMock';

export type Extras = Pick<IpcDeps, 'licence' | 'legal' | 'quit' | 'updates' | 'openExternal' | 'lock'>;

/**
 * The real main-process stack (IPC handlers, services, settings on disk, the
 * simulator) running in-process, with a bridge that behaves like preload + IPC
 * (structured-clone at the boundary). UI tests drive screens against it.
 *
 * `midiLike` makes the simulator behave like iLive MIDI: it can't report send levels.
 * The calling test file must `vi.mock('electron', () => import('../helpers/electronMock'))`.
 */
export async function createBackend(extras: Extras = {}, opts: { dir?: string; midiLike?: boolean } = {}) {
  handlers.clear();
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'ilm-ui-'));
  const log = new Logger('error');
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = <K extends EventChannel>(ch: K, payload: IpcEventMap[K]) => {
    for (const cb of listeners.get(ch) ?? []) cb(structuredClone(payload));
  };

  const settings = new SettingsService(join(dir, 'settings.json'), log);
  await settings.init();
  const rack = new SimulatedRack();
  const cache = new StateCache(createDefaultMixerState(), 1);
  const bus = () => auxBusIndex(cache.state, settings.current.aux);
  const session = new RackSession(cache, log, () => {
    const p = new SimulatorProtocol(rack, { meterFps: 0 });
    if (opts.midiLike) Object.defineProperty(p, 'capabilities', { value: { ...SIMULATOR_CAPABILITIES, stateQuery: 'partial' } });
    return p;
  }, { bus });
  const mixer = new MixerService(cache, session, log, bus);

  cache.batches.on((b) => emit('mixer:changes', b));
  cache.resets.on((r) => emit('mixer:reset', r));
  session.status.on((s) => emit('rack:status', s));
  let lastAux = settings.current.aux;
  settings.changed.on((s) => {
    emit('settings:changed', s);
    if (s.aux !== lastAux) {
      lastAux = s.aux;
      session.busChanged();
    }
  });
  extras.licence?.changed.on((l) => emit('licence:changed', l));
  extras.lock?.changed.on((l) => emit('lock:changed', l));
  extras.legal?.changed.on((l) => emit('legal:changed', l));
  extras.updates?.changed.on((u) => emit('update:changed', u));

  registerIpc({ log, cache, session, mixer, settings, ...extras });

  const bridge: ILiveBridge = {
    async invoke(channel, req) {
      const h = handlers.get(channel);
      if (!h) throw new Error(`no handler for ${channel}`);
      return structuredClone(await h({ sender: { id: 1 } }, structuredClone(req))) as never;
    },
    on(channel, cb) {
      const set = listeners.get(channel) ?? new Set();
      set.add(cb as (p: unknown) => void);
      listeners.set(channel, set);
      return () => set.delete(cb as (p: unknown) => void);
    },
    platform: 'darwin',
    versions: { electron: '33.4.11', chrome: '130.0', node: '20.18.0', os: '26.0' },
  };

  return {
    dir, bridge, cache, session, settings, rack, log, emit,
    async dispose(keepDir = false) {
      session.dispose();
      await settings.flush();
      if (!keepDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Backend = Awaited<ReturnType<typeof createBackend>>;
