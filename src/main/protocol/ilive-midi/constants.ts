/**
 * Allen & Heath iLive MIDI-over-TCP protocol constants.
 *
 * Sources: A&H "iLive TCP/IP Protocol V1.9" and "iLive MIDI Protocol V1.91"
 * (TCP port 51325, from the iLive legacy resources page). This is the publicly
 * documented external-control protocol, not the proprietary surface <-> MixRack
 * protocol. Faders, mutes, names and colours checked on an iDR48 (fw 1.9x),
 * 2026-09-25; pan (NRPN 16) is undocumented and ignored by the rack.
 *
 * ⚠ VERIFY every value here against the protocol document for the firmware
 * installed on the target iDR48 (Firmware 1.9x) and against a real rack on the
 * bench before live use. They are isolated in this one file for that reason, and
 * the codec tests pin the byte sequences so any correction is a one-line change
 * plus an updated test vector.
 */
import type { StripColour } from '@shared/domain/model';
import type { StripKind } from '@shared/domain/ids';

export const ILIVE_TCP_PORT = 51325;

export const SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00] as const;
export const SYSEX_END = 0xf7;

export const SYSEX = {
  GET_NAME: 0x01,
  NAME_REPLY: 0x02,
  SET_NAME: 0x03,
  GET_COLOUR: 0x04,
  COLOUR_REPLY: 0x05,
  SET_COLOUR: 0x06,
  GET_PAD: 0x07,
  PAD_REPLY: 0x08,
  SET_PAD: 0x09,
  GET_PHANTOM: 0x0a,
  PHANTOM_REPLY: 0x0b,
  SET_PHANTOM: 0x0c,
} as const;

export const NRPN = {
  PARAM_MSB_CC: 0x63, // carries the channel ("CH") number
  PARAM_LSB_CC: 0x62, // carries the parameter id
  DATA_ENTRY_CC: 0x06,
  FADER: 0x17,
  MAIN_ASSIGN: 0x18,
  PREAMP_GAIN: 0x19, // by channel; the socket form is a pitch-bend message
  DCA_ASSIGN: 0x40,
  /** Aux / FX send level: parameter id is the send bus, 20..3D (see mixLayout). */
  SEND_FIRST: 0x20,
  SEND_LAST: 0x3d,
} as const;
// Pan is not in the iLive TCP/IP V1.9 or MIDI V1.91 documents, and an iDR48 ignores NRPN 16 both ways.

/** Preamp gain: 00..7F = +10..+65 dB, i.e. [(gain - 10) / 55] * 7F. */
export const GAIN_MIN_DB = 10;
export const GAIN_SPAN_DB = 55;
/** MixRack preamp sockets A1..J8 = 00..4F; an iDR48 has 48 (A1..F8). */
export const SOCKET_COUNT = 48;

export const MUTE_ON_VELOCITY = 0x7f;
export const MUTE_OFF_VELOCITY = 0x3f;

/** "CH" byte ranges: which note/NRPN number addresses which strip. */
export const CHANNEL_BASE: Record<StripKind, number> = {
  fxSend: 0x00,
  fxReturn: 0x08,
  dca: 0x10,
  input: 0x20,
  mix: 0x60,
};
export const CHANNEL_COUNT: Record<StripKind, number> = { fxSend: 8, fxReturn: 8, dca: 16, input: 64, mix: 32 };

/** Fader level mapping anchors: 0x6B = 0 dB, 0x7F = +10 dB, 0x00 = -inf, 2 steps per dB. */
export const LEVEL_ZERO_DB = 0x6b;
export const LEVEL_STEPS_PER_DB = 2;

/** The rack's colours: off plus six. The app's white has no code, so it stays in the show. */
export const COLOUR_CODES: Partial<Record<StripColour, number>> = {
  off: 0, red: 1, green: 2, yellow: 3, blue: 4, purple: 5, lightBlue: 6,
};

export const NAME_MAX_CHARS = 8;
export const MAX_SYSEX_BYTES = 256;
