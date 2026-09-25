import type { MixerChange } from '@shared/domain/changes';
import type { SendTarget, StripRef } from '@shared/domain/ids';
import type { MixerState } from '@shared/domain/model';
import type { ProtocolCapabilities, RackIdentity } from '@shared/rack';
import { mixLayout, type MixLayout, type RackMixConfig } from '@shared/mixLayout';
import type { MixRackProtocol } from '../MixRackProtocol';
import { Emitter, type Transport } from '../../transport/Transport';
import { CHANNEL_BASE, COLOUR_CODES, NRPN, SOCKET_COUNT, SYSEX } from './constants';
import {
  MidiStreamParser,
  channelToStrip,
  colourFromCode,
  encodeDcaAssign,
  encodeFader,
  encodeGetColour,
  encodeGetName,
  encodeGetPad,
  encodeGetPhantom,
  encodeMainAssign,
  encodeMute,
  encodeSceneRecall,
  encodeSendLevel,
  encodeSetColour,
  encodeSetName,
  encodeSetPad,
  encodeSetPhantom,
  encodeSocketGain,
  dbToLevel,
  levelToDb,
  parseIliveSysex,
  stripToChannel,
  valueToGain,
  type MidiMessage,
} from './codec';

/**
 * Only what the public protocol documents cover (iLive TCP/IP V1.9, MIDI V1.91).
 * Processing, pan, send mutes, routing, FX and metering are NOT available; the
 * UI marks them as show-only and edits to them stay in the show. Sends need the
 * rack's mix configuration, because the rack numbers its send buses by it.
 */
export function iliveMidiCapabilities(hasMixConfig: boolean): ProtocolCapabilities {
  return {
    faders: true,
    mutes: true,
    pan: false,
    names: true,
    colours: true,
    sends: hasMixConfig,
    sendDetail: false,
    assign: true,
    preamp: true,
    processing: false,
    routing: false,
    fx: false,
    metering: false,
    sceneRecall: true,
    stateQuery: 'partial',
  };
}
export const ILIVE_MIDI_CAPABILITIES = iliveMidiCapabilities(false);

export interface IliveMidiOptions {
  midiChannel: number;
  rackName: string;
  /** The rack's mix configuration. Without it, mix N is CH 60+N and sends are off. */
  mixConfig?: RackMixConfig;
  /** Messages sent per pacing tick during state queries, to avoid flooding the rack. */
  queryBurst?: number;
  queryTickMs?: number;
  queryTimeoutMs?: number;
}

const PROBE_CH = 0x20; // Input 1: name request is cheap and always answered
const MIX_CH = CHANNEL_BASE.mix;

export class IliveMidiProtocol implements MixRackProtocol {
  readonly id = 'ilive-midi-tcp';
  readonly capabilities: ProtocolCapabilities;

  private readonly parser = new MidiStreamParser();
  private readonly changes = new Emitter<MixerChange>();
  private readonly meters = new Emitter<Float32Array>();
  private readonly sceneRecalls = new Emitter<number>();
  private readonly closed = new Emitter<Error | undefined>();
  private readonly nrpnState = { msb: -1, lsb: -1 };
  private readonly layout: MixLayout | null;
  /** CH -> app mix index, and whether it's the first (L) channel of its strip. */
  private readonly mixByChannel = new Map<number, { index: number; primary: boolean }>();
  private readonly sendBySnd = new Map<number, SendTarget>();
  /** Input index -> preamp socket, from the last state we saw (for gain reported by channel). */
  private inputSockets = new Map<number, number>();
  private bank = 0;
  private probeWaiters: Array<() => void> = [];
  private pendingQueries = new Set<string>();
  private queryDone: (() => void) | null = null;
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly transport: Transport,
    private readonly opts: IliveMidiOptions,
  ) {
    this.layout = opts.mixConfig ? mixLayout(opts.mixConfig) : null;
    this.capabilities = iliveMidiCapabilities(!!this.layout);
    if (this.layout) {
      this.layout.slots.forEach((s, index) => s.channels.forEach((ch, i) => this.mixByChannel.set(ch, { index, primary: i === 0 })));
      for (const [index, snds] of this.layout.mixSends) for (const snd of snds) this.sendBySnd.set(snd, { kind: 'mix', index });
      for (const [index, snds] of this.layout.fxSends) for (const snd of snds) this.sendBySnd.set(snd, { kind: 'fxSend', index });
    }
  }

  private get n() {
    return this.opts.midiChannel & 0x0f;
  }

  async open(): Promise<RackIdentity> {
    await this.transport.open();
    this.unsubs.push(
      this.transport.onData((b) => this.parser.push(b, (m) => this.handle(m))),
      this.transport.onClose((err) => {
        this.cleanup();
        this.closed.emit(err);
      }),
    );
    try {
      // The MIDI protocol has no identity query; a name round-trip proves a live iLive is listening.
      await this.probe(1500);
    } catch (err) {
      this.close();
      throw new Error(`No iLive MIDI response from ${this.transport.remoteAddress}. Check MIDI channel and that TCP MIDI is enabled on the MixRack.`, { cause: err });
    }
    return { name: this.opts.rackName, model: 'iDR48', firmware: null, ip: this.transport.remoteAddress };
  }

  close(): void {
    this.cleanup();
    this.transport.close();
  }

  // --- addressing ------------------------------------------------------------

  /** The CH numbers behind a strip: two for a stereo mix, none for a mix the rack doesn't have. */
  private channelsOf(ref: StripRef): number[] {
    if (ref.kind === 'mix' && this.layout) return this.layout.slots[ref.index]?.channels ?? [];
    try {
      return [stripToChannel(ref)];
    } catch {
      return [];
    }
  }

  private stripOf(ch: number): { ref: StripRef; primary: boolean } | null {
    if (ch >= MIX_CH && this.layout) {
      const m = this.mixByChannel.get(ch);
      return m ? { ref: { kind: 'mix', index: m.index }, primary: m.primary } : null;
    }
    const ref = channelToStrip(ch);
    return ref ? { ref, primary: true } : null;
  }

  private sendBuses(t: SendTarget): number[] {
    if (!this.layout) return [];
    return (t.kind === 'mix' ? this.layout.mixSends.get(t.index) : this.layout.fxSends.get(t.index)) ?? [];
  }

  // --- outbound ------------------------------------------------------------

  normaliseLevel(db: number): number {
    return levelToDb(dbToLevel(db));
  }

  supports(c: MixerChange): boolean {
    switch (c.t) {
      case 'fader':
      case 'mute':
      case 'name':
      case 'mainAssign':
        return this.channelsOf(c.strip).length > 0;
      case 'colour':
        return COLOUR_CODES[c.colour] !== undefined && this.channelsOf(c.strip).length > 0;
      case 'dcaAssign':
        return c.dca >= 0 && c.dca < 16 && this.channelsOf(c.strip).length > 0;
      case 'send':
        // Only the level travels over MIDI; mute, pan and pre/post stay in the show.
        return Object.keys(c.patch).every((k) => k === 'levelDb') && c.patch.levelDb !== undefined
          && this.sendBuses(c.target).length > 0 && this.channelsOf(c.strip).length > 0;
      case 'preamp':
        return c.socket >= 0 && c.socket < SOCKET_COUNT && Object.keys(c.patch).every((k) => k === 'gainDb' || k === 'pad' || k === 'phantom');
      default:
        return false;
    }
  }

  send(c: MixerChange): void {
    const out: number[] = [];
    const each = (fn: (ch: number) => number[]) => {
      if (c.t === 'preamp' || c.t === 'fx') return;
      for (const ch of this.channelsOf(c.strip)) out.push(...fn(ch));
    };
    switch (c.t) {
      case 'fader':
        each((ch) => encodeFader(this.n, ch, c.db));
        break;
      case 'mute':
        each((ch) => encodeMute(this.n, ch, c.on));
        break;
      case 'name':
        each((ch) => encodeSetName(this.n, ch, c.name));
        break;
      case 'colour':
        each((ch) => encodeSetColour(this.n, ch, c.colour));
        break;
      case 'mainAssign':
        each((ch) => encodeMainAssign(this.n, ch, c.on));
        break;
      case 'dcaAssign':
        each((ch) => encodeDcaAssign(this.n, ch, c.dca, c.on));
        break;
      case 'send': {
        const snds = this.sendBuses(c.target);
        const db = c.patch.levelDb!;
        each((ch) => snds.flatMap((snd) => encodeSendLevel(this.n, ch, snd, db)));
        break;
      }
      case 'preamp':
        if (c.patch.gainDb !== undefined) out.push(...encodeSocketGain(this.n, c.socket, c.patch.gainDb));
        if (c.patch.pad !== undefined) out.push(...encodeSetPad(this.n, c.socket, c.patch.pad));
        if (c.patch.phantom !== undefined) out.push(...encodeSetPhantom(this.n, c.socket, c.patch.phantom));
        break;
      default:
        throw new Error(`iLive MIDI cannot encode change type '${c.t}'`);
    }
    if (out.length) this.transport.write(Uint8Array.from(out));
  }

  recallScene(sceneNumber: number): void {
    this.transport.write(Uint8Array.from(encodeSceneRecall(this.n, sceneNumber)));
  }

  probe(timeoutMs: number): Promise<number> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probeWaiters = this.probeWaiters.filter((w) => w !== done);
        reject(new Error('probe timeout'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(performance.now() - started);
      };
      this.probeWaiters.push(done);
      try {
        this.transport.write(Uint8Array.from(encodeGetName(this.n, PROBE_CH)));
      } catch (err) {
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /** Names and colours of every strip, and pad and 48V of every socket: all MIDI can ask for. */
  async requestState(current: MixerState): Promise<void> {
    this.inputSockets = new Map(current.inputs.flatMap((s) => (s.source.kind === 'socket' ? [[s.ref.index, s.source.socket] as const] : [])));
    const all = [...current.inputs, ...current.mixes, ...current.fxSends, ...current.fxReturns, ...current.dcas];
    const queue: Array<{ key: string; bytes: number[] }> = [];
    for (const s of all) {
      const ch = this.channelsOf(s.ref)[0];
      if (ch === undefined) continue;
      queue.push({ key: `n:${ch}`, bytes: encodeGetName(this.n, ch) }, { key: `c:${ch}`, bytes: encodeGetColour(this.n, ch) });
    }
    for (let socket = 0; socket < Math.min(SOCKET_COUNT, current.sockets.length); socket++) {
      queue.push({ key: `p:${socket}`, bytes: encodeGetPad(this.n, socket) }, { key: `v:${socket}`, bytes: encodeGetPhantom(this.n, socket) });
    }
    queue.forEach((q) => this.pendingQueries.add(q.key));

    const burst = this.opts.queryBurst ?? 8;
    const tick = this.opts.queryTickMs ?? 10;
    const finished = new Promise<void>((resolve) => (this.queryDone = resolve));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.opts.queryTimeoutMs ?? 4000));

    (async () => {
      for (let i = 0; i < queue.length; i += burst) {
        if (this.transport.state !== 'open') return;
        for (const q of queue.slice(i, i + burst)) this.transport.write(Uint8Array.from(q.bytes));
        await new Promise((r) => setTimeout(r, tick));
      }
    })().catch(() => undefined);

    await Promise.race([finished, timeout]);
    this.pendingQueries.clear();
    this.queryDone = null;
  }

  onChange(cb: (c: MixerChange) => void) {
    return this.changes.on(cb);
  }
  onMeters(cb: (f: Float32Array) => void) {
    return this.meters.on(cb);
  }
  onRemoteSceneRecall(cb: (n: number) => void) {
    return this.sceneRecalls.on(cb);
  }
  onClose(cb: (err?: Error) => void) {
    return this.closed.on(cb);
  }

  // --- inbound ---------------------------------------------------------------

  private handle(m: MidiMessage) {
    if (m.type !== 'sysex' && m.channel !== this.n) return;
    switch (m.type) {
      case 'noteOn': {
        if (m.velocity === 0) return; // the trailing note-off of a mute message
        const s = this.stripOf(m.note);
        if (s) this.changes.emit({ t: 'mute', strip: s.ref, on: m.velocity >= 0x40 });
        return;
      }
      case 'cc':
        if (m.controller === 0x00) this.bank = m.value;
        else if (m.controller === NRPN.PARAM_MSB_CC) this.nrpnState.msb = m.value;
        else if (m.controller === NRPN.PARAM_LSB_CC) this.nrpnState.lsb = m.value;
        else if (m.controller === NRPN.DATA_ENTRY_CC) this.handleNrpn(m.value);
        return;
      case 'program':
        this.sceneRecalls.emit(this.bank * 128 + m.program + 1);
        return;
      case 'pitchBend':
        // Socket preamp gain: EN, socket, value.
        if (m.lsb < SOCKET_COUNT) this.changes.emit({ t: 'preamp', socket: m.lsb, patch: { gainDb: valueToGain(m.msb) } });
        return;
      case 'sysex':
        this.handleSysex(m.bytes);
        return;
    }
  }

  private handleNrpn(value: number) {
    const ch = this.nrpnState.msb;
    const param = this.nrpnState.lsb;
    const s = this.stripOf(ch);
    if (!s) return;
    const strip = s.ref;
    if (param === NRPN.FADER) this.changes.emit({ t: 'fader', strip, db: levelToDb(value) });
    else if (param === NRPN.MAIN_ASSIGN) this.changes.emit({ t: 'mainAssign', strip, on: value >= 0x40 });
    else if (param === NRPN.DCA_ASSIGN) this.changes.emit({ t: 'dcaAssign', strip, dca: value & 0x0f, on: value >= 0x40 });
    else if (param === NRPN.PREAMP_GAIN) {
      const socket = strip.kind === 'input' ? this.inputSockets.get(strip.index) : undefined;
      if (socket !== undefined) this.changes.emit({ t: 'preamp', socket, patch: { gainDb: valueToGain(value) } });
    } else if (param >= NRPN.SEND_FIRST && param <= NRPN.SEND_LAST) {
      const target = this.sendBySnd.get(param);
      if (target) this.changes.emit({ t: 'send', strip, target, patch: { levelDb: levelToDb(value) } });
    }
  }

  private handleSysex(bytes: number[]) {
    const msg = parseIliveSysex(bytes);
    if (!msg || msg.n !== this.n) return;
    const [ch, ...rest] = msg.payload;
    if (ch === undefined) return;
    switch (msg.cmd) {
      case SYSEX.NAME_REPLY: {
        if (ch === PROBE_CH && this.probeWaiters.length) {
          const waiters = this.probeWaiters;
          this.probeWaiters = [];
          waiters.forEach((w) => w());
        }
        // The rack pads names to 8 characters with NULs.
        const s = this.stripOf(ch);
        if (s?.primary) this.changes.emit({ t: 'name', strip: s.ref, name: String.fromCharCode(...rest).replace(/\0/g, '').trimEnd() });
        this.settleQuery(`n:${ch}`);
        return;
      }
      case SYSEX.COLOUR_REPLY: {
        const s = this.stripOf(ch);
        if (s?.primary && rest[0] !== undefined) this.changes.emit({ t: 'colour', strip: s.ref, colour: colourFromCode(rest[0]) });
        this.settleQuery(`c:${ch}`);
        return;
      }
      case SYSEX.PAD_REPLY:
        if (ch < SOCKET_COUNT && rest[0] !== undefined) this.changes.emit({ t: 'preamp', socket: ch, patch: { pad: rest[0] >= 0x40 } });
        this.settleQuery(`p:${ch}`);
        return;
      case SYSEX.PHANTOM_REPLY:
        if (ch < SOCKET_COUNT && rest[0] !== undefined) this.changes.emit({ t: 'preamp', socket: ch, patch: { phantom: rest[0] >= 0x40 } });
        this.settleQuery(`v:${ch}`);
        return;
    }
  }

  private settleQuery(key: string) {
    if (this.pendingQueries.delete(key) && this.pendingQueries.size === 0) this.queryDone?.();
  }

  private cleanup() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.probeWaiters = [];
  }
}
