import { describe, expect, it, vi } from 'vitest';
import type { MixerChange } from '@shared/domain/changes';
import { createDefaultMixerState } from '@shared/domain/defaults';
import {
  MidiStreamParser, channelToStrip, dbToLevel, encodeDcaAssign, encodeFader, encodeGetName, encodeGetPad, encodeGetPhantom, encodeMainAssign,
  encodeMute, encodeSceneRecall, encodeSendLevel, encodeSetColour, encodeSetName, encodeSetPad, encodeSetPhantom, encodeSocketGain,
  gainToValue, levelToDb, parseIliveSysex, stripToChannel, valueToGain, type MidiMessage,
} from '@main/protocol/ilive-midi/codec';
import { SYSEX_HEADER } from '@main/protocol/ilive-midi/constants';
import { IliveMidiProtocol } from '@main/protocol/ilive-midi/IliveMidiProtocol';
import { LoopbackTransport } from '@main/transport/LoopbackTransport';

const nameReply = (n: number, ch: number, name: string) => [...SYSEX_HEADER, n, 0x02, ch, ...[...name].map((c) => c.charCodeAt(0)), 0xf7];

describe('value mapping', () => {
  it('fader level anchors', () => {
    expect(dbToLevel(0)).toBe(0x6b);
    expect(dbToLevel(10)).toBe(0x7f);
    expect(dbToLevel(20)).toBe(0x7f);
    expect(dbToLevel(-Infinity)).toBe(0);
    expect(dbToLevel(-200)).toBe(1); // lowest audible step, not "off"
    expect(levelToDb(0)).toBe(-Infinity);
    expect(levelToDb(0x6b)).toBe(0);
    for (let v = 1; v <= 0x7f; v++) expect(dbToLevel(levelToDb(v))).toBe(v);
  });
  it('preamp gain: 00..7F = +10..+65 dB (TCP/IP V1.9 table)', () => {
    expect(gainToValue(10)).toBe(0x00);
    expect(gainToValue(65)).toBe(0x7f);
    // the document's table, which rounds down
    expect(gainToValue(55)).toBe(0x67);
    expect(gainToValue(50)).toBe(0x5c);
    expect(gainToValue(45)).toBe(0x50);
    expect(gainToValue(25)).toBe(0x22);
    expect(gainToValue(0)).toBe(0);
    expect(valueToGain(0x7f)).toBe(65);
    expect(valueToGain(0x00)).toBe(10);
  });
  it('strip <-> channel number', () => {
    expect(stripToChannel({ kind: 'input', index: 0 })).toBe(0x20);
    expect(stripToChannel({ kind: 'mix', index: 31 })).toBe(0x7f);
    expect(stripToChannel({ kind: 'dca', index: 0 })).toBe(0x10);
    expect(channelToStrip(0x08)).toEqual({ kind: 'fxReturn', index: 0 });
    expect(() => stripToChannel({ kind: 'input', index: 64 })).toThrow(RangeError);
    for (let ch = 0; ch < 0x80; ch++) {
      const s = channelToStrip(ch);
      expect(s && stripToChannel(s)).toBe(ch);
    }
  });
});

describe('encoders (pinned byte vectors)', () => {
  it('mute = note on + note off', () => {
    expect(encodeMute(0, 0x20, true)).toEqual([0x90, 0x20, 0x7f, 0x90, 0x20, 0x00]);
    expect(encodeMute(2, 0x21, false)).toEqual([0x92, 0x21, 0x3f, 0x92, 0x21, 0x00]);
  });
  it('fader as NRPN 17', () => {
    expect(encodeFader(0, 0x20, 0)).toEqual([0xb0, 0x63, 0x20, 0xb0, 0x62, 0x17, 0xb0, 0x06, 0x6b]);
  });
  it('send level, main and DCA assignment as NRPN', () => {
    expect(encodeSendLevel(0, 0x20, 0x2e, 0)).toEqual([0xb0, 0x63, 0x20, 0xb0, 0x62, 0x2e, 0xb0, 0x06, 0x6b]);
    expect(encodeMainAssign(0, 0x21, true)).toEqual([0xb0, 0x63, 0x21, 0xb0, 0x62, 0x18, 0xb0, 0x06, 0x7f]);
    expect(encodeMainAssign(0, 0x21, false)).toEqual([0xb0, 0x63, 0x21, 0xb0, 0x62, 0x18, 0xb0, 0x06, 0x3f]);
    expect(encodeDcaAssign(0, 0x20, 0, true)).toEqual([0xb0, 0x63, 0x20, 0xb0, 0x62, 0x40, 0xb0, 0x06, 0x40]);
    expect(encodeDcaAssign(0, 0x20, 15, false)).toEqual([0xb0, 0x63, 0x20, 0xb0, 0x62, 0x40, 0xb0, 0x06, 0x0f]);
  });
  it('socket gain as pitch bend; pad and 48V as SysEx', () => {
    expect(encodeSocketGain(2, 0x05, 65)).toEqual([0xe2, 0x05, 0x7f]);
    expect(encodeGetPad(0, 0x03)).toEqual([...SYSEX_HEADER, 0, 0x07, 0x03, 0xf7]);
    expect(encodeSetPad(0, 0x03, true)).toEqual([...SYSEX_HEADER, 0, 0x09, 0x03, 0x7f, 0xf7]);
    expect(encodeGetPhantom(0, 0x03)).toEqual([...SYSEX_HEADER, 0, 0x0a, 0x03, 0xf7]);
    expect(encodeSetPhantom(0, 0x03, false)).toEqual([...SYSEX_HEADER, 0, 0x0c, 0x03, 0x00, 0xf7]);
  });
  it('colours are the seven rack codes', () => {
    expect(encodeSetColour(0, 0x20, 'lightBlue')).toEqual([...SYSEX_HEADER, 0, 0x06, 0x20, 0x06, 0xf7]);
  });
  it('scene recall uses bank select above 128', () => {
    expect(encodeSceneRecall(0, 1)).toEqual([0xb0, 0x00, 0x00, 0xc0, 0x00]);
    expect(encodeSceneRecall(0, 129)).toEqual([0xb0, 0x00, 0x01, 0xc0, 0x00]);
    expect(() => encodeSceneRecall(0, 251)).toThrow();
  });
  it('names are 8 printable ASCII chars', () => {
    const bytes = encodeSetName(0, 0x20, 'Vox—Lead!!');
    const body = parseIliveSysex(bytes)!;
    expect(body.cmd).toBe(0x03);
    expect(String.fromCharCode(...body.payload.slice(1))).toBe('Vox?Lead');
  });
});

describe('MidiStreamParser', () => {
  const parse = (bytes: number[], chunk = bytes.length) => {
    const p = new MidiStreamParser();
    const out: MidiMessage[] = [];
    for (let i = 0; i < bytes.length; i += chunk) p.push(bytes.slice(i, i + chunk), (m) => out.push(m));
    return { out, p };
  };

  it('handles running status', () => {
    const { out } = parse([0xb0, 0x63, 0x20, 0x62, 0x17, 0x06, 0x50]);
    expect(out).toEqual([
      { type: 'cc', channel: 0, controller: 0x63, value: 0x20 },
      { type: 'cc', channel: 0, controller: 0x62, value: 0x17 },
      { type: 'cc', channel: 0, controller: 0x06, value: 0x50 },
    ]);
  });

  it('reassembles messages split across TCP reads, byte by byte', () => {
    const bytes = [...encodeMute(0, 0x20, true), ...nameReply(0, 0x20, 'Kick')];
    expect(parse(bytes, 1).out).toEqual(parse(bytes).out);
    expect(parse(bytes, 1).out).toHaveLength(3);
  });

  it('ignores realtime bytes in the middle of messages', () => {
    const { out } = parse([0x90, 0xf8, 0x20, 0xfe, 0x7f]);
    expect(out).toEqual([{ type: 'noteOn', channel: 0, note: 0x20, velocity: 0x7f }]);
  });

  it('drops stray data and oversize/unterminated sysex, then resyncs', () => {
    const junk = [0x12, 0x34, 0xf0, ...Array(300).fill(0x01), 0x90, 0x20, 0x7f];
    const { out, p } = parse(junk);
    expect(out).toEqual([{ type: 'noteOn', channel: 0, note: 0x20, velocity: 0x7f }]);
    expect(p.malformed).toBeGreaterThan(0);
  });
});

describe('IliveMidiProtocol over loopback', () => {
  function setup(midiChannel = 0) {
    const t = new LoopbackTransport();
    // Minimal rack emulator: answers name requests.
    t.peer.onReceive((b) => {
      const s = parseIliveSysex([...b]);
      if (s && s.cmd === 0x01) t.peer.send(nameReply(s.n, s.payload[0]!, 'Ip1'));
    });
    const p = new IliveMidiProtocol(t, { midiChannel, rackName: 'FOH Rack', queryTickMs: 0, queryTimeoutMs: 200 });
    return { t, p };
  }

  it('reports the level the rack will really hold: 0.5 dB steps, nothing quieter than its lowest step but off', () => {
    const { p } = setup();
    expect(p.normaliseLevel(-7.83)).toBe(-8);
    expect(p.normaliseLevel(0)).toBe(0);
    expect(p.normaliseLevel(10)).toBe(10);
    expect(p.normaliseLevel(-70)).toBe(p.normaliseLevel(-53.5)); // below the lowest step: the lowest step, not off
    expect(p.normaliseLevel(-Infinity)).toBe(-Infinity);
  });

  it('opens by proving the rack answers', async () => {
    const { p } = setup();
    await expect(p.open()).resolves.toMatchObject({ name: 'FOH Rack', model: 'iDR48', ip: 'loopback' });
  });

  it('fails to open when nothing answers', async () => {
    vi.useFakeTimers();
    const t = new LoopbackTransport();
    const p = new IliveMidiProtocol(t, { midiChannel: 0, rackName: 'x' });
    const opening = p.open();
    const assertion = expect(opening).rejects.toThrow(/No iLive MIDI response/);
    await vi.advanceTimersByTimeAsync(1600);
    await assertion;
    vi.useRealTimers();
  });

  it('decodes inbound mute, fader and scene recall on its channel only, and ignores pan', async () => {
    const { t, p } = setup(1);
    await p.open();
    const got: MixerChange[] = [];
    const scenes: number[] = [];
    p.onChange((c) => got.push(c));
    p.onRemoteSceneRecall((n) => scenes.push(n));
    const pan = [0xb1, 0x63, 0x21, 0xb1, 0x62, 0x16, 0xb1, 0x06, 0x7f]; // NRPN 16: not in the documents, not honoured by the rack
    t.peer.send([...encodeMute(1, 0x25, true), ...encodeFader(1, 0x60, -10), ...pan, ...encodeSceneRecall(1, 130)]);
    t.peer.send(encodeMute(0, 0x25, true)); // other MIDI channel: ignored
    expect(got).toEqual([
      { t: 'mute', strip: { kind: 'input', index: 5 }, on: true },
      { t: 'fader', strip: { kind: 'mix', index: 0 }, db: -10 },
    ]);
    expect(scenes).toEqual([130]);
  });

  it('encodes supported changes and refuses the rest', async () => {
    const { t, p } = setup();
    await p.open();
    t.written.length = 0;
    p.send({ t: 'fader', strip: { kind: 'input', index: 0 }, db: 0 });
    expect([...t.written[0]!]).toEqual(encodeFader(0, 0x20, 0));
    expect(p.supports({ t: 'gate', strip: { kind: 'input', index: 0 }, patch: {} })).toBe(false);
    expect(p.supports({ t: 'pan', strip: { kind: 'input', index: 0 }, pan: 0 })).toBe(false);
    expect(p.supports({ t: 'colour', strip: { kind: 'input', index: 0 }, colour: 'white' })).toBe(false);
    // no mix configuration: sends can't be addressed
    expect(p.supports({ t: 'send', strip: { kind: 'input', index: 0 }, target: { kind: 'mix', index: 0 }, patch: { levelDb: 0 } })).toBe(false);
    expect(p.capabilities).toMatchObject({ pan: false, sends: false, assign: true, preamp: true });
    expect(() => p.send({ t: 'gate', strip: { kind: 'input', index: 0 }, patch: {} })).toThrow();
  });

  it('requestState queries names and folds replies in', async () => {
    const { t, p } = setup();
    await p.open();
    const names: string[] = [];
    p.onChange((c) => c.t === 'name' && names.push(c.name));
    await p.requestState(createDefaultMixerState());
    expect(t.written.some((b) => [...b].join() === encodeGetName(0, 0x7f).join())).toBe(true);
    expect(names.length).toBeGreaterThan(100);
  });

  it('reports link loss once', async () => {
    const { t, p } = setup();
    await p.open();
    const closed = vi.fn();
    p.onClose(closed);
    t.peer.drop(new Error('ECONNRESET'));
    t.peer.drop();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
