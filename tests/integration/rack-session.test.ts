import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMixerState } from '@shared/domain/defaults';
import type { RackStatus } from '@shared/rack';
import type { RackTarget } from '@shared/settings';
import { Logger } from '@main/logging/Logger';
import { RackSession } from '@main/rack/RackSession';
import { StateCache } from '@main/rack/StateCache';
import { SimulatedRack, SimulatorProtocol } from '@main/protocol/simulator/SimulatorProtocol';

const target: RackTarget = { id: 't', name: 'Sim', host: '', port: 0, protocol: 'simulator', midiChannel: 0, autoConnect: true };
const ip = (index: number) => ({ kind: 'input' as const, index });

/** A client "position" (FOH, monitors...) = its own cache + session against the shared rack. */
function client(rack: SimulatedRack, opts: { refuse?: () => boolean } = {}) {
  const cache = new StateCache(createDefaultMixerState(), 1);
  const protocols: SimulatorProtocol[] = [];
  const session = new RackSession(cache, new Logger('error'), () => {
    const p = new SimulatorProtocol(rack, { meterFps: 0 });
    if (opts.refuse?.()) p.open = () => Promise.reject(new Error('EHOSTUNREACH'));
    protocols.push(p);
    return p;
  }, { echoGuardMs: 50 });
  const phases: string[] = [];
  session.status.on((s: RackStatus) => phases[phases.length - 1] !== s.phase && phases.push(s.phase));
  return { cache, session, protocols, phases, last: () => protocols[protocols.length - 1]! };
}

async function online(c: ReturnType<typeof client>) {
  c.session.connect(target);
  await vi.waitFor(() => expect(c.session.current.phase).toBe('online'));
}

describe('RackSession', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('every connect pulls from the rack and never pushes what the app had', async () => {
    const rack = new SimulatedRack();
    rack.state = { ...rack.state, inputs: rack.state.inputs.map((s, i) => (i === 0 ? { ...s, name: 'Kick', faderDb: -4 } : s)) };
    const c = client(rack);
    c.cache.apply([{ t: 'name', strip: ip(3), name: 'Stale' }, { t: 'fader', strip: ip(0), db: 0 }]);
    await online(c);
    expect(c.cache.state.inputs[0]).toMatchObject({ name: 'Kick', faderDb: -4 });
    expect(c.cache.state.inputs[3]!.name).not.toBe('Stale');
    expect(rack.state.inputs[3]!.name).not.toBe('Stale');
    expect(c.session.current).toMatchObject({ phase: 'online', cacheUnverified: false, identity: { model: 'iDR48' }, unconfirmed: [] });
  });

  it('nothing is sent before the link is up', async () => {
    const c = client(new SimulatedRack());
    const send = { t: 'send' as const, strip: ip(1), target: { kind: 'mix' as const, index: 0 }, patch: { levelDb: 0 } };
    expect(c.session.supports(send)).toBe(false);
    expect(c.session.send([send]).sent).toBe(0);
    await online(c);
    expect(c.session.supports(send)).toBe(true);
  });

  it('coalesces a fader drag into the latest value', async () => {
    const rack = new SimulatedRack();
    const c = client(rack);
    await online(c);
    const spy = vi.spyOn(c.last(), 'send');
    for (let db = -30; db <= -10; db++) c.session.send([{ t: 'fader', strip: ip(0), db }]);
    c.session.send([{ t: 'mute', strip: ip(0), on: true }]);
    await vi.advanceTimersByTimeAsync(5);
    expect(spy.mock.calls.map(([ch]) => ch)).toEqual([{ t: 'fader', strip: ip(0), db: -10 }, { t: 'mute', strip: ip(0), on: true }]);
  });

  it('suppresses stale echoes of a control we are moving', async () => {
    const rack = new SimulatedRack();
    const c = client(rack);
    await online(c);
    c.cache.apply([{ t: 'fader', strip: ip(0), db: -5 }]);
    c.session.send([{ t: 'fader', strip: ip(0), db: -5 }]);
    c.last().notify({ t: 'fader', strip: ip(0), db: -20 }); // late echo of an older value
    expect(c.cache.state.inputs[0]!.faderDb).toBe(-5);
    await vi.advanceTimersByTimeAsync(60);
    c.last().notify({ t: 'fader', strip: ip(0), db: -20 }); // genuinely new, after the guard window
    expect(c.cache.state.inputs[0]!.faderDb).toBe(-20);
  });

  it('reconnects every 2 s after a drop, then re-syncs from the rack without asking', async () => {
    const rack = new SimulatedRack();
    let down = false;
    const c = client(rack, { refuse: () => down });
    await online(c);

    down = true;
    c.last().simulateDrop();
    expect(c.session.current.phase).toBe('reconnecting');
    rack.apply({ t: 'mute', strip: ip(7), on: true }); // someone else mixes while we're away

    await vi.advanceTimersByTimeAsync(2000);
    expect(c.session.current.phase).toBe('reconnecting'); // attempt failed
    down = false;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(c.session.current.phase).toBe('online'));
    expect(c.cache.state.inputs[7]!.muted).toBe(true);
    expect(c.session.current.health.reconnects).toBe(1);
  });

  it('watchdog declares a hung rack lost after 3 missed probes', async () => {
    const rack = new SimulatedRack();
    const c = client(rack);
    await online(c);
    c.last().hung = true;
    await vi.advanceTimersByTimeAsync(1000 + 750);
    expect(c.session.current.phase).toBe('degraded');
    await vi.advanceTimersByTimeAsync(2 * 1750);
    expect(c.session.current.phase).toBe('reconnecting');
    expect(c.session.current.lastError).toMatch(/watchdog/);
  });

  it('disconnect stops reconnecting', async () => {
    const rack = new SimulatedRack();
    const c = client(rack, { refuse: () => true });
    c.session.connect(target);
    await vi.advanceTimersByTimeAsync(10);
    c.session.disconnect();
    const n = c.protocols.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.protocols.length).toBe(n);
    expect(c.session.current.phase).toBe('offline');
  });
});

describe('multi-client operation', () => {
  it('FOH, monitors and broadcast stay consistent through the rack', async () => {
    const rack = new SimulatedRack();
    const foh = client(rack);
    const mon = client(rack);
    const bcast = client(rack);
    await Promise.all([online(foh), online(mon), online(bcast)]);

    foh.session.send([{ t: 'fader', strip: ip(0), db: -3 }]);
    mon.session.send([{ t: 'send', strip: ip(0), target: { kind: 'mix', index: 0 }, patch: { levelDb: -8 } }]);
    bcast.session.send([{ t: 'mute', strip: ip(1), on: true }]);
    // local caches are updated by the MixerService in the app; mirror that here
    foh.cache.apply([{ t: 'fader', strip: ip(0), db: -3 }]);
    mon.cache.apply([{ t: 'send', strip: ip(0), target: { kind: 'mix', index: 0 }, patch: { levelDb: -8 } }]);
    bcast.cache.apply([{ t: 'mute', strip: ip(1), on: true }]);

    await vi.waitFor(() => {
      for (const c of [foh, mon, bcast]) {
        expect(c.cache.state.inputs[0]!.faderDb).toBe(-3);
        expect(c.cache.state.inputs[0]!.sends[0]!.levelDb).toBe(-8);
        expect(c.cache.state.inputs[1]!.muted).toBe(true);
      }
    });
    expect(JSON.stringify(foh.cache.state)).toBe(JSON.stringify(rack.state));
    expect(JSON.stringify(mon.cache.state)).toBe(JSON.stringify(bcast.cache.state));
    for (const c of [foh, mon, bcast]) c.session.dispose();
  });

  it('an unknown protocol in a saved target is a connect error, not a crash', async () => {
    const cache = new StateCache(createDefaultMixerState(), 1);
    const session = new RackSession(cache, new Logger('error'), () => undefined as never);
    session.connect({ ...target, protocol: 'nonsense' as never });
    await vi.waitFor(() => expect(session.current.lastError).toMatch(/Unknown rack protocol/));
    session.dispose();
  });
});
