import { IDR48, type MixRole } from './ids';
import type {
  CompressorState,
  DcaStrip,
  DelayState,
  EqState,
  FxReturnStrip,
  FxSendStrip,
  FxUnit,
  GateState,
  InputStrip,
  MixStrip,
  MixerState,
  PreampState,
  SendState,
} from './model';

export const defaultGate = (): GateState => ({
  enabled: false,
  thresholdDb: -40,
  depthDb: 40,
  attackMs: 0.5,
  holdMs: 100,
  releaseMs: 200,
});

export const defaultEq = (): EqState => ({
  enabled: true,
  hpf: { enabled: false, freqHz: 80 },
  lpf: { enabled: false, freqHz: 18000 },
  bands: [
    { type: 'lowShelf', freqHz: 100, gainDb: 0, q: 0.7 },
    { type: 'bell', freqHz: 400, gainDb: 0, q: 1.4 },
    { type: 'bell', freqHz: 2500, gainDb: 0, q: 1.4 },
    { type: 'highShelf', freqHz: 8000, gainDb: 0, q: 0.7 },
  ],
});

export const defaultComp = (): CompressorState => ({
  enabled: false,
  thresholdDb: -10,
  ratio: 3,
  attackMs: 10,
  releaseMs: 200,
  kneeDb: 6,
  makeupDb: 0,
});

export const defaultDelay = (): DelayState => ({ bypass: true, timeMs: 0 });

export const defaultSend = (): SendState => ({ levelDb: -Infinity, pan: 0, muted: false, preFader: false });

/**
 * A typical iLive mix configuration for an iDR48: 12 aux, 8 groups, 8 matrix, Main LR and Main Mono. Shows override this.
 */
export function defaultMixRoles(): MixRole[] {
  const roles: MixRole[] = [];
  for (let i = 0; i < 12; i++) roles.push('aux');
  for (let i = 0; i < 8; i++) roles.push('group');
  for (let i = 0; i < 8; i++) roles.push('matrix');
  roles.push('mainLR', 'mainMono');
  while (roles.length < IDR48.mixBuses) roles.push('unused');
  return roles;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function createDefaultMixerState(roles: MixRole[] = defaultMixRoles()): MixerState {
  const sockets: PreampState[] = range(IDR48.micSockets).map((socket) => ({
    socket,
    gainDb: 20,
    pad: false,
    phantom: false,
  }));

  const inputs: InputStrip[] = range(IDR48.inputChannels).map((index) => ({
    ref: { kind: 'input', index },
    name: `Ip${index + 1}`,
    colour: 'off',
    faderDb: -Infinity,
    muted: false,
    pafl: false,
    dcaAssign: [],
    source: index < IDR48.micSockets ? { kind: 'socket', socket: index } : { kind: 'none' },
    trimDb: 0,
    polarity: false,
    pan: 0,
    gate: defaultGate(),
    eq: defaultEq(),
    comp: defaultComp(),
    delay: defaultDelay(),
    insert: { enabled: false, send: null, return: null },
    mainAssign: true,
    sends: {},
    fxSends: {},
    groupAssign: [],
    directOut: null,
  }));

  const mixes: MixStrip[] = range(IDR48.mixBuses).map((index) => createMixStrip(index, roles, roles[index] === 'mainLR'));

  const fxSends: FxSendStrip[] = range(IDR48.fxUnits).map((index) => ({
    ref: { kind: 'fxSend', index },
    name: `FX${index + 1}`,
    colour: 'purple',
    faderDb: 0,
    muted: false,
    pafl: false,
    dcaAssign: [],
  }));

  const fxReturns: FxReturnStrip[] = range(IDR48.fxUnits).map((index) => ({
    ref: { kind: 'fxReturn', index },
    name: `FXR${index + 1}`,
    colour: 'purple',
    faderDb: -Infinity,
    muted: false,
    pafl: false,
    dcaAssign: [],
    pan: 0,
    mainAssign: true,
    sends: {},
  }));

  const dcas: DcaStrip[] = range(IDR48.dcas).map((index) => ({
    ref: { kind: 'dca', index },
    name: `DCA${index + 1}`,
    colour: 'off',
    faderDb: 0,
    muted: false,
    pafl: false,
    dcaAssign: [],
  }));

  const fx: FxUnit[] = range(IDR48.fxUnits).map((index): FxUnit => ({
    index,
    name: `FX${index + 1}`,
    type: index < 4 ? 'reverb' : 'delay',
    bypass: false,
    params: index < 4 ? { decayS: 2.0, preDelayMs: 20, hfDamp: 0.5, size: 0.6 } : { timeMs: 350, feedback: 0.3, hfCut: 0.4 },
  }));

  return { schema: 1, sockets, inputs, mixes, fxSends, fxReturns, dcas, fx };
}

/** A fresh mix strip for slot `index` of a mix configuration (`roles`, one per mix index). */
export function createMixStrip(index: number, roles: MixRole[], stereo: boolean): MixStrip {
  const role = roles[index] ?? 'unused';
  return {
    ref: { kind: 'mix', index },
    name: mixDefaultName(role, index, roles),
    colour: role === 'mainLR' || role === 'mainMono' ? 'white' : 'off',
    faderDb: role === 'mainLR' ? 0 : -Infinity,
    muted: false,
    pafl: false,
    dcaAssign: [],
    role,
    stereo,
    pan: 0,
    eq: defaultEq(),
    comp: defaultComp(),
    delay: defaultDelay(),
    insert: { enabled: false, send: null, return: null },
    sends: {},
    mainAssign: role === 'group',
    outputs: [],
  };
}

function mixDefaultName(role: MixRole, index: number, roles: MixRole[]): string {
  const ordinal = roles.slice(0, index + 1).filter((r) => r === role).length;
  switch (role) {
    case 'aux':
      return `Aux${ordinal}`;
    case 'group':
      return `Grp${ordinal}`;
    case 'matrix':
      return `Mtx${ordinal}`;
    case 'mainLR':
      return 'Main LR';
    case 'mainMono':
      return 'Mono';
    case 'unused':
      return `Mix${index + 1}`;
  }
}
