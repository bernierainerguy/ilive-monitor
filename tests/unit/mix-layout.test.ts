import { describe, expect, it } from 'vitest';
import type { MixerChange } from '@shared/domain/changes';
import { createDefaultMixerState } from '@shared/domain/defaults';
import { applyMixLayout, mixConfigError, mixLayout, parseMixConfig, sendBusCount, type RackMixConfig } from '@shared/mixLayout';
import { encodeFader, encodeGetName, encodeGetPad, encodeMute, encodeSendLevel, encodeSetName } from '@main/protocol/ilive-midi/codec';
import { SYSEX_HEADER } from '@main/protocol/ilive-midi/constants';
import { IliveMidiProtocol } from '@main/protocol/ilive-midi/IliveMidiProtocol';
import { LoopbackTransport } from '@main/transport/LoopbackTransport';

/** The first real iDR48 we met: a monitor rack with IEM mixes and four FX. */
const MONITOR_RACK: RackMixConfig = {
  monoGroups: 0, stereoGroups: 0, monoAuxes: 4, stereoAuxes: 10, main: 'lr', monoMatrices: 0, stereoMatrices: 0, monoFx: 4, stereoFx: 0,
};

const sysex = (n: number, cmd: number, ...body: number[]) => [...SYSEX_HEADER, n, cmd, ...body, 0xf7];

describe('mix layout', () => {
  it('numbers mix channels in the rack order, stereo taking L and R', () => {
    const { slots } = mixLayout(MONITOR_RACK);
    expect(slots.slice(0, 4).map((s) => [s.role, s.stereo, s.channels])).toEqual([
      ['aux', false, [0x60]], ['aux', false, [0x61]], ['aux', false, [0x62]], ['aux', false, [0x63]],
    ]);
    expect(slots[4]).toEqual({ role: 'aux', stereo: true, channels: [0x64, 0x65] });
    expect(slots[13]).toEqual({ role: 'aux', stereo: true, channels: [0x76, 0x77] });
    expect(slots[14]).toEqual({ role: 'mainLR', stereo: true, channels: [0x78, 0x79] });
    expect(slots.slice(15).every((s) => s.role === 'unused' && s.channels.length === 0)).toBe(true);
    expect(slots).toHaveLength(32);
  });

  it('numbers send buses: groups, mono FX, mono auxes, stereo FX, stereo auxes', () => {
    const { mixSends, fxSends } = mixLayout(MONITOR_RACK);
    expect([...fxSends]).toEqual([[0, [0x20]], [1, [0x21]], [2, [0x22]], [3, [0x23]]]);
    expect(mixSends.get(0)).toEqual([0x24]);
    expect(mixSends.get(3)).toEqual([0x27]);
    expect(mixSends.get(4)).toEqual([0x28, 0x29]);
    expect(mixSends.get(13)).toEqual([0x3a, 0x3b]);
    expect(mixSends.has(14)).toBe(false); // main takes no sends
    expect(sendBusCount(MONITOR_RACK)).toBe(28);
  });

  it('follows the TCP/IP document example (1_FOH-LRSub)', () => {
    const cfg: RackMixConfig = { monoGroups: 4, stereoGroups: 2, monoAuxes: 8, stereoAuxes: 2, main: 'lrMono', monoMatrices: 4, stereoMatrices: 2, monoFx: 6, stereoFx: 0 };
    expect(mixConfigError(cfg)).toBeNull();
    const { slots, mixSends, fxSends } = mixLayout(cfg);
    const byName = (role: string, n: number) => slots.filter((s) => s.role === role)[n]!;
    expect(byName('group', 4).channels).toEqual([0x64, 0x65]); // StGrp1L/R
    expect(byName('aux', 0).channels).toEqual([0x68]); // Aux1
    expect(byName('aux', 8).channels).toEqual([0x70, 0x71]); // StAux1L/R
    expect(byName('mainLR', 0).channels).toEqual([0x74, 0x75]);
    expect(byName('mainMono', 0).channels).toEqual([0x76]); // Main Sub, then the spare 77
    expect(byName('matrix', 0).channels).toEqual([0x78]); // Mtx1
    expect(byName('matrix', 4).channels).toEqual([0x7c, 0x7d]); // StMtx1L/R
    expect(fxSends.get(0)).toEqual([0x28]); // FX1
    expect(mixSends.get(slots.indexOf(byName('aux', 0)))).toEqual([0x2e]); // Aux1
    expect(mixSends.get(slots.indexOf(byName('aux', 8)))).toEqual([0x36, 0x37]); // StAux1L/R
  });

  it('refuses configurations the rack cannot hold', () => {
    expect(mixConfigError({ ...MONITOR_RACK, stereoAuxes: 14 })).toMatch(/mix channels/);
    expect(mixConfigError({ ...MONITOR_RACK, stereoFx: 4, monoFx: 0 })).toMatch(/send buses/);
    expect(mixConfigError({ ...MONITOR_RACK, monoAuxes: -1 })).toMatch(/whole numbers/);
    expect(parseMixConfig({ ...MONITOR_RACK, main: 'surround' })).toBeNull();
    expect(parseMixConfig('nope')).toBeNull();
    expect(parseMixConfig({ ...MONITOR_RACK })).toEqual(MONITOR_RACK);
  });

  it('reshapes a show to the rack, keeping matching strips and dropping stale sends', () => {
    const state = createDefaultMixerState(); // 12 aux, 8 groups, 8 matrix, Main LR, Mono
    state.inputs[0]!.sends = { 0: { levelDb: -5, pan: 0, muted: false, preFader: false }, 20: { levelDb: -3, pan: 0, muted: false, preFader: false } };
    state.mixes[0]!.name = 'Wedge 1';
    const next = applyMixLayout(state, mixLayout(MONITOR_RACK))!;
    expect(next.mixes.map((m) => m.role).slice(0, 16)).toEqual([...Array(14).fill('aux'), 'mainLR', 'unused']);
    expect(next.mixes[0]!.name).toBe('Wedge 1'); // same role and width: kept
    expect(next.mixes[4]).toMatchObject({ role: 'aux', stereo: true });
    expect(Object.keys(next.inputs[0]!.sends)).toEqual(['0']); // mix 20 changed role: its send is dropped
    expect(applyMixLayout(next, mixLayout(MONITOR_RACK))).toBeNull(); // already conforms
  });
});

describe('IliveMidiProtocol with a mix configuration', () => {
  async function setup(opts: { names?: Record<number, string> } = {}) {
    const t = new LoopbackTransport();
    t.peer.onReceive((b) => {
      const bytes = [...b];
      const cmd = bytes[SYSEX_HEADER.length + 1];
      const ch = bytes[SYSEX_HEADER.length + 2]!;
      if (bytes[0] !== 0xf0) return;
      if (cmd === 0x01 && (ch < 0x60 || opts.names?.[ch] !== undefined)) t.peer.send(sysex(0, 0x02, ch, ...[...(opts.names?.[ch] ?? 'Ip\0\0\0\0\0\0')].map((c) => c.charCodeAt(0))));
      if (cmd === 0x07) t.peer.send(sysex(0, 0x08, ch, ch === 2 ? 0x7f : 0x00));
      if (cmd === 0x0a) t.peer.send(sysex(0, 0x0b, ch, ch === 0 ? 0x7f : 0x00));
    });
    const p = new IliveMidiProtocol(t, { midiChannel: 0, rackName: 'Mon', mixConfig: MONITOR_RACK, queryTickMs: 0, queryTimeoutMs: 300 });
    await p.open();
    t.written.length = 0;
    return { t, p };
  }
  const wrote = (t: LoopbackTransport) => t.written.flatMap((b) => [...b]);

  it('can send levels', async () => {
    const { p } = await setup();
    expect(p.capabilities).toMatchObject({ sends: true, sendDetail: false, pan: false });
  });

  it('drives both halves of a stereo mix', async () => {
    const { t, p } = await setup();
    p.send({ t: 'fader', strip: { kind: 'mix', index: 4 }, db: -10 });
    expect(wrote(t)).toEqual([...encodeFader(0, 0x64, -10), ...encodeFader(0, 0x65, -10)]);
    t.written.length = 0;
    p.send({ t: 'name', strip: { kind: 'mix', index: 14 }, name: 'FOH' });
    expect(wrote(t)).toEqual([...encodeSetName(0, 0x78, 'FOH'), ...encodeSetName(0, 0x79, 'FOH')]);
  });

  it('addresses sends by the rack send-bus number', async () => {
    const { t, p } = await setup();
    p.send({ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 0 }, patch: { levelDb: 0 } });
    p.send({ t: 'send', strip: { kind: 'input', index: 1 }, target: { kind: 'fxSend', index: 3 }, patch: { levelDb: -5 } });
    p.send({ t: 'send', strip: { kind: 'input', index: 2 }, target: { kind: 'mix', index: 4 }, patch: { levelDb: -10 } });
    expect(wrote(t)).toEqual([
      ...encodeSendLevel(0, 0x20, 0x24, 0),
      ...encodeSendLevel(0, 0x21, 0x23, -5),
      ...encodeSendLevel(0, 0x22, 0x28, -10), ...encodeSendLevel(0, 0x22, 0x29, -10),
    ]);
    // mute, pan and pre/post aren't in the protocol; nor is a mix the rack doesn't have
    expect(p.supports({ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 0 }, patch: { muted: true } })).toBe(false);
    expect(p.supports({ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 20 }, patch: { levelDb: 0 } })).toBe(false);
    expect(p.supports({ t: 'fader', strip: { kind: 'mix', index: 20 }, db: 0 })).toBe(false);
  });

  it('maps inbound messages back through the layout', async () => {
    const { t, p } = await setup();
    const got: MixerChange[] = [];
    p.onChange((c) => got.push(c));
    t.peer.send([...encodeMute(0, 0x65, true), ...encodeFader(0, 0x79, 0), ...encodeSendLevel(0, 0x20, 0x29, -6)]);
    t.peer.send([0xe0, 0x04, 0x7f]); // socket A5 gain
    expect(got).toEqual([
      { t: 'mute', strip: { kind: 'mix', index: 4 }, on: true },
      { t: 'fader', strip: { kind: 'mix', index: 14 }, db: 0 },
      { t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 4 }, patch: { levelDb: -6 } },
      { t: 'preamp', socket: 4, patch: { gainDb: 65 } },
    ]);
  });

  it('pulls names without the NUL padding, skips unused mixes, and reads pad and 48V', async () => {
    const { t, p } = await setup({ names: { 0x64: 'El G1\0\0\0', 0x65: 'El G1\0\0\0' } });
    const got: MixerChange[] = [];
    p.onChange((c) => got.push(c));
    await p.requestState(createDefaultMixerState());
    const sent = t.written.map((b) => [...b].join());
    expect(sent).toContain(encodeGetName(0, 0x64).join());
    expect(sent).not.toContain(encodeGetName(0, 0x65).join()); // R half: the L name stands for both
    expect(sent).not.toContain(encodeGetName(0, 0x7a).join()); // not a mix on this rack
    expect(sent).toContain(encodeGetPad(0, 47).join());
    expect(got).toContainEqual({ t: 'name', strip: { kind: 'mix', index: 4 }, name: 'El G1' });
    expect(got).toContainEqual({ t: 'name', strip: { kind: 'input', index: 0 }, name: 'Ip' });
    expect(got).toContainEqual({ t: 'preamp', socket: 2, patch: { pad: true } });
    expect(got).toContainEqual({ t: 'preamp', socket: 0, patch: { phantom: true } });
  });
});
