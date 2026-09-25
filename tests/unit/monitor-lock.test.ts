import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MixerChange } from '@shared/domain/changes';
import { createDefaultMixerState } from '@shared/domain/defaults';
import type { MixerState } from '@shared/domain/model';
import { authorizeMonitorChange, isMonitorBus, monitorBuses, monitorSources } from '@shared/monitorPolicy';
import { Logger } from '@main/logging/Logger';
import { MixerService } from '@main/services/MixerService';
import { SettingsService, parseRack, parseSettings } from '@main/services/SettingsService';
import { StateCache } from '@main/rack/StateCache';
import type { RackSession } from '@main/rack/RackSession';

const state: MixerState = createDefaultMixerState();
const AUX = monitorBuses(state)[2]!.ref.index;
const OTHER_AUX = monitorBuses(state)[3]!.ref.index;
const GROUP = state.mixes.find((m) => m.role === 'group')!.ref.index;
const ip = (index: number) => ({ kind: 'input' as const, index });
const level = (db: number, bus = AUX, strip: MixerChange extends never ? never : { kind: 'input' | 'fxReturn' | 'mix'; index: number } = ip(0)): MixerChange =>
  ({ t: 'send', strip: strip as never, target: { kind: 'mix', index: bus }, patch: { levelDb: db } });

describe('monitor policy: send levels to the chosen aux, nothing else', () => {
  const ok = (c: MixerChange, bus: number | null = AUX) => authorizeMonitorChange(state, bus, c).ok;

  it('allows a level from any input channel to the chosen aux, including -inf and +10', () => {
    expect(ok(level(-6))).toBe(true);
    expect(ok(level(-Infinity))).toBe(true);
    expect(ok(level(10, AUX, ip(63)))).toBe(true);
  });

  it('refuses FX return sends: the app only mixes input channels', () => {
    expect(authorizeMonitorChange(state, AUX, level(0, AUX, { kind: 'fxReturn', index: 0 }))).toMatchObject({ ok: false, reason: 'Only input channel sends can be changed' });
  });

  it('refuses every other kind of change', () => {
    const refused: MixerChange[] = [
      { t: 'fader', strip: ip(0), db: 0 },
      { t: 'mute', strip: ip(0), on: true },
      { t: 'pafl', strip: ip(0), on: true },
      { t: 'pan', strip: ip(0), pan: 0.5 },
      { t: 'name', strip: ip(0), name: 'X' },
      { t: 'colour', strip: ip(0), colour: 'red' },
      { t: 'eq', strip: ip(0), patch: { enabled: false } },
      { t: 'gate', strip: ip(0), patch: { enabled: true } },
      { t: 'comp', strip: ip(0), patch: { enabled: true } },
      { t: 'delay', strip: ip(0), patch: { enabled: true } },
      { t: 'preamp', socket: 0, patch: { phantom: true } },
      { t: 'inputConfig', strip: ip(0), patch: { polarity: true } },
      { t: 'dcaAssign', strip: ip(0), dca: 0, on: true },
      { t: 'mainAssign', strip: ip(0), on: false },
      { t: 'fader', strip: { kind: 'mix', index: AUX }, db: 0 }, // not even the aux's own master
      { t: 'mute', strip: { kind: 'mix', index: AUX }, on: true },
      { t: 'fx', unit: 0, patch: { bypass: true } },
    ];
    for (const c of refused) expect(authorizeMonitorChange(state, AUX, c)).toMatchObject({ ok: false, reason: 'iLive Monitor only adjusts send levels' });
  });

  it('refuses sends to any other bus: another aux, a group, an FX send', () => {
    expect(ok(level(0, OTHER_AUX))).toBe(false);
    expect(ok(level(0, GROUP), GROUP)).toBe(false); // even if Settings somehow held a group
    expect(ok({ t: 'send', strip: ip(0), target: { kind: 'fxSend', index: 0 }, patch: { levelDb: 0 } })).toBe(false);
  });

  it('refuses send mute, pan and pre/post, alone or smuggled in with a level', () => {
    expect(ok({ t: 'send', strip: ip(0), target: { kind: 'mix', index: AUX }, patch: { muted: true } })).toBe(false);
    expect(ok({ t: 'send', strip: ip(0), target: { kind: 'mix', index: AUX }, patch: { pan: 1 } })).toBe(false);
    expect(ok({ t: 'send', strip: ip(0), target: { kind: 'mix', index: AUX }, patch: { levelDb: 0, preFader: true } })).toBe(false);
  });

  it('refuses sources that do not feed an aux, bad indexes and nonsense levels', () => {
    expect(ok(level(0, AUX, { kind: 'mix', index: 0 }))).toBe(false);
    expect(ok(level(0, AUX, ip(64)))).toBe(false);
    expect(ok(level(0, AUX, ip(-1)))).toBe(false);
    expect(ok(level(NaN))).toBe(false);
    expect(ok(level(Infinity))).toBe(false);
    expect(ok(level(10.5))).toBe(false);
    expect(ok({ t: 'send', strip: ip(0), target: { kind: 'mix', index: AUX }, patch: { levelDb: '0' as never } })).toBe(false);
  });

  it('refuses everything until a bus is chosen', () => {
    expect(authorizeMonitorChange(state, null, level(0))).toMatchObject({ ok: false, reason: /Settings/ });
  });

  it('offers auxes only, fed by the 64 input channels', () => {
    expect(monitorBuses(state).every((m) => m.role === 'aux')).toBe(true);
    expect(isMonitorBus(state, GROUP)).toBe(false);
    expect(isMonitorBus(state, null)).toBe(false);
    expect(monitorSources(state)).toHaveLength(64);
    expect(monitorSources(state).every((r) => r.kind === 'input')).toBe(true);
  });
});

describe('MixerService: the lock in the main process', () => {
  function service(opts: { live?: boolean; bus?: number | null } = {}) {
    const cache = new StateCache(createDefaultMixerState(), 1);
    const sent: MixerChange[] = [];
    const session = { supports: () => opts.live ?? true, send: (c: MixerChange[]) => (sent.push(...c), { sent: c.length, unsupported: 0 }) } as unknown as RackSession;
    const svc = new MixerService(cache, session, new Logger('error'), () => (opts.bus === undefined ? AUX : opts.bus));
    return { cache, sent, svc };
  }

  it('applies and sends an allowed level, and rejects the rest of a batch with reasons', () => {
    const { cache, sent, svc } = service();
    const r = svc.dispatch([level(-12), { t: 'mute', strip: ip(1), on: true }, level(0, OTHER_AUX)]);
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2]);
    expect(sent).toEqual([level(-12)]);
    expect(cache.state.inputs[0]!.sends[AUX]!.levelDb).toBe(-12);
    expect(cache.state.inputs[1]!.muted).toBe(false);
  });

  it('changes nothing while the rack cannot take it (offline, or no mix configuration)', () => {
    const { cache, sent, svc } = service({ live: false });
    expect(svc.dispatch([level(-12)])).toMatchObject({ accepted: 0, rejected: [{ index: 0, reason: 'Not connected to the rack' }] });
    expect(sent).toEqual([]);
    expect(cache.state.inputs[0]!.sends[AUX]?.levelDb ?? -Infinity).toBe(-Infinity);
  });

  it('follows the bus in Settings at the moment of each move', () => {
    let bus: number | null = AUX;
    const cache = new StateCache(createDefaultMixerState(), 1);
    const session = { supports: () => true, send: () => ({ sent: 1, unsupported: 0 }) } as unknown as RackSession;
    const svc = new MixerService(cache, session, new Logger('error'), () => bus);
    expect(svc.dispatch([level(0)]).accepted).toBe(1);
    bus = OTHER_AUX;
    expect(svc.dispatch([level(0)]).accepted).toBe(0);
    expect(svc.dispatch([level(0, OTHER_AUX)]).accepted).toBe(1);
  });
});

describe('SettingsService: the bus is kept between launches', () => {
  let dir = '';
  afterEach(async () => dir && rm(dir, { recursive: true, force: true }));

  it('saves the bus, theme and racks, and a new instance reads them back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ilm-'));
    const path = join(dir, 'settings.json');
    const a = new SettingsService(path, new Logger('error'));
    await a.init();
    const seen = vi.fn();
    a.changed.on(seen);
    a.update({ bus: 3, themeId: 'red' });
    a.upsertRack({ id: 'r', name: 'iDR48', host: ' 10.0.0.10 ', port: 51325, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: true });
    a.setLastTarget('r');
    await a.flush();
    expect(seen).toHaveBeenCalled();

    const b = new SettingsService(path, new Logger('error'));
    expect(await b.init()).toMatchObject({ bus: 3, themeId: 'red', lastTargetId: 'r', racks: [{ id: 'simulator' }, { id: 'r', host: '10.0.0.10' }] });
    b.deleteRack('r');
    expect(b.current).toMatchObject({ racks: [{ id: 'simulator' }], lastTargetId: null, bus: 3 });
  });

  it('starts fresh from a missing or corrupt file, and never trusts what it reads', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ilm-'));
    const path = join(dir, 'settings.json');
    const s = new SettingsService(path, new Logger('error'));
    expect((await s.init()).bus).toBeNull();
    await writeFile(path, '{nope');
    expect((await new SettingsService(path, new Logger('error')).init()).racks.map((r) => r.id)).toEqual(['simulator']);
    expect(parseSettings({ bus: 99, themeId: 'hot-pink', racks: [{ id: 'x' }, null], lastTargetId: 'x' })).toMatchObject({ bus: null, themeId: 'dark', racks: [], lastTargetId: null });
    expect(parseSettings({ bus: 1.5 }).bus).toBeNull();
    expect(parseSettings(null).schema).toBe(1);
    s.update({ bus: -1 });
    expect(s.current.bus).toBeNull();
    await s.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).bus).toBeNull();
  });

  it('validates racks, including the mix configuration', () => {
    const base = { id: 'r', name: 'R', host: 'h', port: 51325, protocol: 'ilive-midi-tcp', midiChannel: 0, autoConnect: false };
    expect(parseRack(base)).toMatchObject({ id: 'r' });
    expect(parseRack({ ...base, protocol: 'osc' })).toBeNull();
    expect(parseRack({ ...base, port: 70000 })).toBeNull();
    expect(parseRack({ ...base, midiChannel: 16 })).toBeNull();
    expect(parseRack({ ...base, id: '' })).toBeNull();
    expect(parseRack({ ...base, mixConfig: { monoAuxes: 99 } })).toBeNull();
    expect(() => new SettingsService('/nonexistent/x.json', new Logger('error')).upsertRack({ ...base, port: -1 } as never)).toThrow('Invalid rack');
  });
});
