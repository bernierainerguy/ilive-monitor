import type { MixRole, StripKey, StripRef } from './ids';

/** iLive's fixed strip colour palette. */
export type StripColour = 'off' | 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'lightBlue' | 'white';
export const STRIP_COLOURS: readonly StripColour[] = ['off', 'red', 'green', 'yellow', 'blue', 'purple', 'lightBlue', 'white'];

/** Levels are always stored in dB. `-Infinity` is fully off. */
export type Db = number;

export interface PreampState {
  readonly socket: number;
  gainDb: Db; // +5 .. +60
  pad: boolean;
  phantom: boolean;
}

export interface GateState {
  enabled: boolean;
  thresholdDb: Db; // -72 .. +18
  depthDb: Db; // 0 .. 60
  attackMs: number; // 0.05 .. 300
  holdMs: number; // 10 .. 5000
  releaseMs: number; // 10 .. 1000
}

export type EqBandType = 'bell' | 'lowShelf' | 'highShelf';

export interface EqBand {
  type: EqBandType;
  freqHz: number; // 20 .. 20000
  gainDb: Db; // -15 .. +15
  q: number; // 0.1 .. 20 (width)
}

export interface FilterState {
  enabled: boolean;
  freqHz: number;
}

/** Four parametric bands: LF, LMF, HMF, HF, plus HPF / LPF. */
export interface EqState {
  enabled: boolean;
  hpf: FilterState;
  lpf: FilterState;
  bands: [EqBand, EqBand, EqBand, EqBand];
}

export interface CompressorState {
  enabled: boolean;
  thresholdDb: Db; // -46 .. +18
  ratio: number; // 1 .. 50 (50 = limit)
  attackMs: number; // 0.3 .. 300
  releaseMs: number; // 100 .. 2000
  kneeDb: Db; // 0 hard .. 12 soft
  makeupDb: Db; // 0 .. 18
}

export interface DelayState {
  bypass: boolean;
  timeMs: number; // 0 .. 340 (iLive input delay)
}

export interface SendState {
  levelDb: Db;
  pan: number; // -1 .. +1 (stereo targets only)
  muted: boolean;
  preFader: boolean;
}

export type InputSource =
  | { kind: 'socket'; socket: number }
  | { kind: 'port'; port: 'A' | 'B' | 'dsnake'; channel: number }
  | { kind: 'none' };

export interface InsertState {
  enabled: boolean;
  send: string | null; // output port id
  return: string | null; // input port id
}

export interface OutputPatch {
  /** Physical output id, e.g. `rack:out:1` or `portA:12`. */
  output: string;
  tap: 'post' | 'pre' | 'direct';
}

export interface StripCommon {
  readonly ref: StripRef;
  name: string;
  colour: StripColour;
  faderDb: Db;
  muted: boolean;
  pafl: boolean;
  dcaAssign: number[];
}

export interface InputStrip extends StripCommon {
  readonly ref: StripRef & { kind: 'input' };
  source: InputSource;
  trimDb: Db; // -24 .. +24
  polarity: boolean;
  pan: number;
  gate: GateState;
  eq: EqState;
  comp: CompressorState;
  delay: DelayState;
  insert: InsertState;
  mainAssign: boolean;
  /** Sends keyed by mix index (aux / matrix targets). */
  sends: Record<number, SendState>;
  fxSends: Record<number, SendState>;
  groupAssign: number[];
  directOut: OutputPatch | null;
}

export interface MixStrip extends StripCommon {
  readonly ref: StripRef & { kind: 'mix' };
  role: MixRole;
  stereo: boolean;
  pan: number;
  eq: EqState;
  comp: CompressorState;
  delay: DelayState;
  insert: InsertState;
  /** Group -> Main, Group/Aux/Main -> Matrix sends keyed by mix index. */
  sends: Record<number, SendState>;
  mainAssign: boolean;
  outputs: OutputPatch[];
}

export interface FxSendStrip extends StripCommon {
  readonly ref: StripRef & { kind: 'fxSend' };
}

export interface FxReturnStrip extends StripCommon {
  readonly ref: StripRef & { kind: 'fxReturn' };
  pan: number;
  mainAssign: boolean;
  sends: Record<number, SendState>;
}

export interface DcaStrip extends StripCommon {
  readonly ref: StripRef & { kind: 'dca' };
}

export type AnyStrip = InputStrip | MixStrip | FxSendStrip | FxReturnStrip | DcaStrip;

export type FxType = 'reverb' | 'delay' | 'chorus' | 'flanger' | 'phaser' | 'pitch' | 'gatedVerb' | 'none';

export interface FxUnit {
  readonly index: number;
  name: string;
  type: FxType;
  bypass: boolean;
  params: Record<string, number>;
}

/** Complete, serialisable MixRack state. This is the "local cache" model. */
export interface MixerState {
  readonly schema: 1;
  sockets: PreampState[];
  inputs: InputStrip[];
  mixes: MixStrip[];
  fxSends: FxSendStrip[];
  fxReturns: FxReturnStrip[];
  dcas: DcaStrip[];
  fx: FxUnit[];
}

export type SceneBlock =
  | 'preamp'
  | 'name'
  | 'fader'
  | 'mute'
  | 'pan'
  | 'gate'
  | 'eq'
  | 'comp'
  | 'delay'
  | 'sends'
  | 'routing'
  | 'fx';

export const ALL_SCENE_BLOCKS: readonly SceneBlock[] = [
  'preamp', 'name', 'fader', 'mute', 'pan', 'gate', 'eq', 'comp', 'delay', 'sends', 'routing', 'fx',
];

export interface SceneScope {
  strips: StripKey[] | 'all';
  blocks: SceneBlock[];
}

export interface Scene {
  readonly id: string;
  number: number; // 1..250
  name: string;
  notes: string;
  scope: SceneScope;
  /**
   * Optionally fire this scene number in the MixRack's own scene memory before
   * applying the stored snapshot. With protocols that can't reach processing
   * (e.g. iLive MIDI), this is how processing gets recalled.
   */
  rackSceneNumber: number | null;
  createdAt: string;
  updatedAt: string;
  snapshot: MixerState;
}

export type LibraryKind = 'input' | 'fx' | 'processing';

export type LibraryPayload =
  | { kind: 'input'; strip: Pick<InputStrip, 'gate' | 'eq' | 'comp' | 'delay' | 'trimDb' | 'polarity' | 'name' | 'colour'> }
  | { kind: 'fx'; unit: Pick<FxUnit, 'type' | 'params'> }
  | { kind: 'processing'; block: 'gate'; data: GateState }
  | { kind: 'processing'; block: 'eq'; data: EqState }
  | { kind: 'processing'; block: 'comp'; data: CompressorState };

/** Shape check for library payloads arriving over IPC or from a show file (a bad one used to crash the view). */
export function isLibraryPayload(p: unknown): p is LibraryPayload {
  const v = p as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return false;
  const obj = (x: unknown) => !!x && typeof x === 'object';
  switch (v.kind) {
    case 'input': return obj(v.strip);
    case 'fx': return obj(v.unit) && typeof (v.unit as { type?: unknown }).type === 'string';
    case 'processing': return (v.block === 'gate' || v.block === 'eq' || v.block === 'comp') && obj(v.data);
    default: return false;
  }
}

export interface LibraryEntry {
  readonly id: string;
  name: string;
  createdAt: string;
  payload: LibraryPayload;
}

export interface CustomLayer {
  readonly id: string;
  name: string;
  strips: StripKey[];
}

export interface Show {
  readonly schema: 1;
  readonly id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rack: { model: 'iDR48'; firmware: string | null };
  mixer: MixerState;
  scenes: Scene[];
  libraries: LibraryEntry[];
}
