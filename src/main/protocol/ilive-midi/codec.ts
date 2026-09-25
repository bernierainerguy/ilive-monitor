import type { StripRef } from '@shared/domain/ids';
import type { StripColour } from '@shared/domain/model';
import {
  CHANNEL_BASE,
  CHANNEL_COUNT,
  COLOUR_CODES,
  GAIN_MIN_DB,
  GAIN_SPAN_DB,
  LEVEL_STEPS_PER_DB,
  LEVEL_ZERO_DB,
  MAX_SYSEX_BYTES,
  MUTE_OFF_VELOCITY,
  MUTE_ON_VELOCITY,
  NAME_MAX_CHARS,
  NRPN,
  SYSEX,
  SYSEX_END,
  SYSEX_HEADER,
} from './constants';

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

export function dbToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const v = Math.round(LEVEL_ZERO_DB + db * LEVEL_STEPS_PER_DB);
  return Math.max(1, Math.min(0x7f, v));
}

export const levelToDb = (v: number): number => (v <= 0 ? -Infinity : (v - LEVEL_ZERO_DB) / LEVEL_STEPS_PER_DB);

export function gainToValue(db: number): number {
  // The document's table truncates ([(Gain - 10) / 55] * 7F, rounded down), so we do too.
  return Math.max(0, Math.min(0x7f, Math.floor(((db - GAIN_MIN_DB) / GAIN_SPAN_DB) * 0x7f + 1e-9)));
}
export const valueToGain = (v: number): number => Math.round((GAIN_MIN_DB + (v / 0x7f) * GAIN_SPAN_DB) * 2) / 2;

export function stripToChannel(ref: StripRef): number {
  if (ref.index < 0 || ref.index >= CHANNEL_COUNT[ref.kind]) throw new RangeError(`strip out of range: ${ref.kind}:${ref.index}`);
  return CHANNEL_BASE[ref.kind] + ref.index;
}

export function channelToStrip(ch: number): StripRef | null {
  for (const kind of Object.keys(CHANNEL_BASE) as Array<StripRef['kind']>) {
    const base = CHANNEL_BASE[kind];
    if (ch >= base && ch < base + CHANNEL_COUNT[kind]) return { kind, index: ch - base };
  }
  return null;
}

const COLOUR_BY_CODE = Object.fromEntries(Object.entries(COLOUR_CODES).map(([k, v]) => [v, k])) as Record<number, StripColour>;
export const colourFromCode = (code: number): StripColour => COLOUR_BY_CODE[code] ?? 'off';

// ---------------------------------------------------------------------------
// Encoders. `n` is the MixRack's MIDI channel (0..15).
// ---------------------------------------------------------------------------

export const encodeMute = (n: number, ch: number, on: boolean): number[] => [
  0x90 | n, ch, on ? MUTE_ON_VELOCITY : MUTE_OFF_VELOCITY,
  0x90 | n, ch, 0x00,
];

const nrpn = (n: number, ch: number, param: number, value: number): number[] => [
  0xb0 | n, NRPN.PARAM_MSB_CC, ch,
  0xb0 | n, NRPN.PARAM_LSB_CC, param,
  0xb0 | n, NRPN.DATA_ENTRY_CC, value & 0x7f,
];

export const encodeFader = (n: number, ch: number, db: number) => nrpn(n, ch, NRPN.FADER, dbToLevel(db));
export const encodeSendLevel = (n: number, ch: number, snd: number, db: number) => nrpn(n, ch, snd, dbToLevel(db));
export const encodeMainAssign = (n: number, ch: number, on: boolean) => nrpn(n, ch, NRPN.MAIN_ASSIGN, on ? 0x7f : 0x3f);
/** `dca` is 0-based (DCA 1 = 0). */
export const encodeDcaAssign = (n: number, ch: number, dca: number, on: boolean) => nrpn(n, ch, NRPN.DCA_ASSIGN, (on ? 0x40 : 0x00) | (dca & 0x0f));
/** Socket preamp gain is a pitch-bend message: EN, socket, value. */
export const encodeSocketGain = (n: number, socket: number, db: number): number[] => [0xe0 | n, socket & 0x7f, gainToValue(db)];

export function encodeSceneRecall(n: number, scene: number): number[] {
  if (scene < 1 || scene > 250) throw new RangeError(`scene ${scene} out of range`);
  const zero = scene - 1;
  return [0xb0 | n, 0x00, zero >> 7, 0xc0 | n, zero & 0x7f];
}

const sysex = (n: number, body: number[]) => [...SYSEX_HEADER, n & 0x0f, ...body, SYSEX_END];

export const encodeGetName = (n: number, ch: number) => sysex(n, [SYSEX.GET_NAME, ch]);
export const encodeGetColour = (n: number, ch: number) => sysex(n, [SYSEX.GET_COLOUR, ch]);
export const encodeSetColour = (n: number, ch: number, colour: StripColour) => sysex(n, [SYSEX.SET_COLOUR, ch, COLOUR_CODES[colour] ?? 0]);
export const encodeGetPad = (n: number, socket: number) => sysex(n, [SYSEX.GET_PAD, socket]);
export const encodeSetPad = (n: number, socket: number, on: boolean) => sysex(n, [SYSEX.SET_PAD, socket, on ? 0x7f : 0x00]);
export const encodeGetPhantom = (n: number, socket: number) => sysex(n, [SYSEX.GET_PHANTOM, socket]);
export const encodeSetPhantom = (n: number, socket: number, on: boolean) => sysex(n, [SYSEX.SET_PHANTOM, socket, on ? 0x7f : 0x00]);

export function encodeSetName(n: number, ch: number, name: string): number[] {
  const ascii = [...name.slice(0, NAME_MAX_CHARS)].map((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x20 && code < 0x7f ? code : 0x3f; // '?' for non-ASCII
  });
  return sysex(n, [SYSEX.SET_NAME, ch, ...ascii]);
}

// ---------------------------------------------------------------------------
// Streaming parser: bytes -> MIDI messages. Handles running status, SysEx
// accumulation, interleaved realtime bytes, and resynchronises on garbage.
// ---------------------------------------------------------------------------

export type MidiMessage =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'program'; channel: number; program: number }
  | { type: 'pitchBend'; channel: number; lsb: number; msb: number }
  | { type: 'sysex'; bytes: number[] };

const dataLength = (status: number): number => {
  const hi = status & 0xf0;
  if (hi === 0xc0 || hi === 0xd0) return 1;
  return 2;
};

export class MidiStreamParser {
  private running = 0;
  private data: number[] = [];
  private sysexBuf: number[] | null = null;
  malformed = 0;

  push(bytes: Uint8Array | number[], emit: (m: MidiMessage) => void): void {
    for (const b of bytes) this.byte(b, emit);
  }

  private byte(b: number, emit: (m: MidiMessage) => void) {
    if (b >= 0xf8) return; // realtime: ignore, does not affect running status

    if (this.sysexBuf) {
      if (b === SYSEX_END) {
        this.sysexBuf.push(b);
        emit({ type: 'sysex', bytes: this.sysexBuf });
        this.sysexBuf = null;
        return;
      }
      if (b & 0x80) {
        this.malformed++; // unterminated sysex; fall through and treat as new status
        this.sysexBuf = null;
      } else {
        if (this.sysexBuf.length >= MAX_SYSEX_BYTES) {
          this.malformed++;
          this.sysexBuf = null;
          return;
        }
        this.sysexBuf.push(b);
        return;
      }
    }

    if (b === 0xf0) {
      this.sysexBuf = [b];
      this.running = 0;
      return;
    }
    if (b & 0x80) {
      if (b >= 0xf0) {
        this.running = 0; // system common: cancels running status, not used by iLive
        return;
      }
      this.running = b;
      this.data = [];
      return;
    }
    if (!this.running) {
      this.malformed++;
      return;
    }
    this.data.push(b);
    if (this.data.length < dataLength(this.running)) return;

    const channel = this.running & 0x0f;
    const hi = this.running & 0xf0;
    const [d0 = 0, d1 = 0] = this.data;
    this.data = [];
    if (hi === 0x90) emit({ type: 'noteOn', channel, note: d0, velocity: d1 });
    else if (hi === 0xb0) emit({ type: 'cc', channel, controller: d0, value: d1 });
    else if (hi === 0xc0) emit({ type: 'program', channel, program: d0 });
    else if (hi === 0xe0) emit({ type: 'pitchBend', channel, lsb: d0, msb: d1 });
  }
}

/** Parses an iLive SysEx body after the header. Returns null for foreign SysEx. */
export function parseIliveSysex(bytes: number[]): { n: number; cmd: number; payload: number[] } | null {
  if (bytes.length < SYSEX_HEADER.length + 3) return null;
  for (let i = 0; i < SYSEX_HEADER.length; i++) if (bytes[i] !== SYSEX_HEADER[i]) return null;
  const n = bytes[SYSEX_HEADER.length]!;
  const cmd = bytes[SYSEX_HEADER.length + 1]!;
  const payload = bytes.slice(SYSEX_HEADER.length + 2, -1);
  return { n, cmd, payload };
}
