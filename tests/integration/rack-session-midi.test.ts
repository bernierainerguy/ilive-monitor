import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultMixerState } from '@shared/domain/defaults';
import type { RackTarget } from '@shared/settings';
import type { RackMixConfig } from '@shared/mixLayout';
import { Logger } from '@main/logging/Logger';
import { RackSession, connectErrorMessage } from '@main/rack/RackSession';
import { StateCache } from '@main/rack/StateCache';
import { SIMULATOR_CAPABILITIES, SimulatedRack, SimulatorProtocol } from '@main/protocol/simulator/SimulatorProtocol';

const MONITOR_RACK: RackMixConfig = {
  monoGroups: 0, stereoGroups: 0, monoAuxes: 4, stereoAuxes: 10, main: 'lr', monoMatrices: 0, stereoMatrices: 0, monoFx: 4, stereoFx: 0,
};
// A MIDI target; the "wire" is the simulator made to behave like MIDI (it can't report state).
const target: RackTarget = { id: 'm', name: 'iDR48', host: '10.0.0.10', port: 51325, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: true, mixConfig: MONITOR_RACK };
const ip = (index: number) => ({ kind: 'input' as const, index });

function client(bus: number | null = 5) {
  const rack = new SimulatedRack();
  const cache = new StateCache(createDefaultMixerState(), 1);
  const protocols: SimulatorProtocol[] = [];
  const session = new RackSession(cache, new Logger('error'), () => {
    const p = new SimulatorProtocol(rack, { meterFps: 0 });
    Object.defineProperty(p, 'capabilities', { value: { ...SIMULATOR_CAPABILITIES, stateQuery: 'partial' } });
    protocols.push(p);
    return p;
  }, { echoGuardMs: 50, bus: () => c.bus });
  const c = { rack, cache, session, bus, last: () => protocols[protocols.length - 1]! };
  return c;
}

async function online(c: ReturnType<typeof client>) {
  c.session.connect(target);
  await vi.waitFor(() => expect(c.session.current.phase).toBe('online'));
}
const send = (strip: { kind: 'input' | 'fxReturn'; index: number }, bus: number, levelDb: number) => ({ t: 'send' as const, strip, target: { kind: 'mix' as const, index: bus }, patch: { levelDb } });

describe('RackSession over a protocol that cannot report state', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('reshapes the mixes to the rack mix configuration on connect', async () => {
    const c = client();
    expect(c.cache.state.mixes[12]!.role).toBe('group');
    await online(c);
    expect(c.cache.state.mixes.slice(0, 15).map((m) => m.role)).toEqual([...Array(14).fill('aux'), 'mainLR']);
    expect(c.cache.state.mixes[4]!.stereo).toBe(true);
  });

  it('marks every send to the chosen bus unconfirmed after a pull, until the rack reports it or it is moved', async () => {
    const c = client(5);
    await online(c);
    const u = () => c.session.current.unconfirmed;
    expect(u()).toHaveLength(64); // every input channel
    expect(u()).toContain('send:input:0>mix:5');
    expect(u()).toContain('send:input:63>mix:5');
    expect(u().some((k) => k.includes('fxReturn'))).toBe(false);
    c.last().rack.apply(send(ip(0), 5, -3)); // moved on the console / by another client
    await vi.advanceTimersByTimeAsync(100);
    expect(u()).not.toContain('send:input:0>mix:5');
    c.session.send([send(ip(1), 5, -10)]); // moved here
    await vi.advanceTimersByTimeAsync(100);
    expect(u()).not.toContain('send:input:1>mix:5');
    expect(u()).toHaveLength(62);
  });

  it('follows the bus in Settings, remembering what other buses already confirmed', async () => {
    const c = client(5);
    await online(c);
    c.last().rack.apply(send(ip(2), 6, -12)); // bus 6 heard while bus 5 is chosen
    await vi.advanceTimersByTimeAsync(100);
    expect(c.session.current.unconfirmed).toHaveLength(64);
    c.bus = 6;
    c.session.busChanged();
    expect(c.session.current.unconfirmed).toHaveLength(63);
    expect(c.session.current.unconfirmed).not.toContain('send:input:2>mix:6');
    c.bus = 14; // the main on this rack, not an aux
    c.session.busChanged();
    expect(c.session.current.unconfirmed).toEqual([]);
  });

  it('a reconnect or a scene recalled on the rack makes every send unknown again; disconnecting clears the list', async () => {
    const c = client(5);
    await online(c);
    c.cache.apply([send(ip(0), 5, -3)]); // as MixerService does
    c.session.send([send(ip(0), 5, -3)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.session.current.unconfirmed).toHaveLength(63);
    c.rack.scenes.set(1, c.rack.state); // a scene the rack recalls without telling us what moved
    c.rack.recallScene(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(c.session.current.unconfirmed).toHaveLength(64);
    c.session.disconnect();
    expect(c.session.current.unconfirmed).toEqual([]);
  });

  it('a protocol that reports its full state has nothing unconfirmed', async () => {
    const rack = new SimulatedRack();
    const cache = new StateCache(createDefaultMixerState(), 1);
    const session = new RackSession(cache, new Logger('error'), () => new SimulatorProtocol(rack, { meterFps: 0 }), { bus: () => 0 });
    session.connect({ ...target, protocol: 'simulator' });
    await vi.waitFor(() => expect(session.current.phase).toBe('online'));
    expect(session.current.unconfirmed).toEqual([]);
    session.dispose();
  });
});

describe('connect errors', () => {
  const where = { host: '10.0.0.10', port: 51325 };
  const err = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.10:51325 - Local (10.0.0.69:61716)`), { code });
  it('names the macOS Local Network setting for EHOSTUNREACH', () => {
    expect(connectErrorMessage(err('EHOSTUNREACH'), where)).toMatch(/Local Network/);
    expect(connectErrorMessage(err('EHOSTUNREACH'), where)).not.toMatch(/Local \(/);
  });
  it('explains the other common failures and keeps anything else as it was', () => {
    expect(connectErrorMessage(err('ENETUNREACH'), where)).toMatch(/on the rack's network/);
    expect(connectErrorMessage(err('ECONNREFUSED'), where)).toMatch(/refused/);
    expect(connectErrorMessage(new Error('connect timeout to 10.0.0.10:51325'), where)).toBe('connect timeout to 10.0.0.10:51325');
  });
});
