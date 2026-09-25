import { sameStrip, stripKey, type SendTarget, type StripKey, type StripRef } from './ids';
import type {
  AnyStrip,
  CompressorState,
  DelayState,
  EqBand,
  FilterState,
  FxUnit,
  GateState,
  InputSource,
  InputStrip,
  MixStrip,
  MixerState,
  OutputPatch,
  PreampState,
  SceneBlock,
  SceneScope,
  SendState,
  StripColour,
} from './model';
import { defaultSend } from './defaults';

/**
 * A MixerChange is the single currency of the whole application: UI intents,
 * protocol notifications, scene recalls and show edits are all expressed as
 * changes and folded by the same pure reducer (`applyChange`). This is what keeps
 * every window and every client consistent.
 */
export interface EqPatch {
  enabled?: boolean;
  hpf?: Partial<FilterState>;
  lpf?: Partial<FilterState>;
  band?: { index: 0 | 1 | 2 | 3; patch: Partial<EqBand> };
}

export type MixerChange =
  | { t: 'fader'; strip: StripRef; db: number }
  | { t: 'mute'; strip: StripRef; on: boolean }
  | { t: 'pafl'; strip: StripRef; on: boolean }
  | { t: 'pan'; strip: StripRef; pan: number }
  | { t: 'name'; strip: StripRef; name: string }
  | { t: 'colour'; strip: StripRef; colour: StripColour }
  | { t: 'send'; strip: StripRef; target: SendTarget; patch: Partial<SendState> }
  | { t: 'preamp'; socket: number; patch: Partial<Omit<PreampState, 'socket'>> }
  | { t: 'inputConfig'; strip: StripRef; patch: Partial<Pick<InputStrip, 'trimDb' | 'polarity' | 'source'>> }
  | { t: 'gate'; strip: StripRef; patch: Partial<GateState> }
  | { t: 'eq'; strip: StripRef; patch: EqPatch }
  | { t: 'comp'; strip: StripRef; patch: Partial<CompressorState> }
  | { t: 'delay'; strip: StripRef; patch: Partial<DelayState> }
  | { t: 'dcaAssign'; strip: StripRef; dca: number; on: boolean }
  | { t: 'mainAssign'; strip: StripRef; on: boolean }
  | { t: 'insert'; strip: StripRef; patch: Partial<InputStrip['insert']> }
  | { t: 'outputs'; strip: StripRef; outputs: OutputPatch[] }
  | { t: 'source'; strip: StripRef; source: InputSource }
  | { t: 'fx'; unit: number; patch: Partial<Omit<FxUnit, 'index' | 'params'>> & { params?: Record<string, number> } };

export type ChangeType = MixerChange['t'];

/** Changes that represent continuous controls and may be coalesced (latest wins). */
export function coalesceKey(c: MixerChange): string | null {
  switch (c.t) {
    case 'fader':
    case 'pan':
      return `${c.t}|${stripKey(c.strip)}`;
    case 'send':
      if (c.patch.levelDb !== undefined && Object.keys(c.patch).length === 1)
        return `send|${stripKey(c.strip)}|${c.target.kind}:${c.target.index}`;
      return null;
    default:
      return null;
  }
}

/** The strip a change targets, if any. Used by permissions and change routing. */
export function changeStrip(c: MixerChange): StripRef | null {
  return 'strip' in c ? c.strip : null;
}

// ---------------------------------------------------------------------------
// Reducer. Pure and structurally sharing: only objects on the changed path are
// replaced, so selector-based subscribers re-render only affected strips.
// ---------------------------------------------------------------------------

type StripArrayKey = 'inputs' | 'mixes' | 'fxSends' | 'fxReturns' | 'dcas';
const STRIP_ARRAYS: Record<StripRef['kind'], StripArrayKey> = {
  input: 'inputs',
  mix: 'mixes',
  fxSend: 'fxSends',
  fxReturn: 'fxReturns',
  dca: 'dcas',
};
const arrayFor = (ref: StripRef): StripArrayKey => STRIP_ARRAYS[ref.kind];

export function getStrip(state: MixerState, ref: StripRef): AnyStrip | undefined {
  return (state[arrayFor(ref)] as AnyStrip[])[ref.index];
}

function updateStrip(state: MixerState, ref: StripRef, fn: (s: AnyStrip) => AnyStrip | null): MixerState {
  const key = arrayFor(ref);
  const arr = state[key] as AnyStrip[];
  const current = arr[ref.index];
  if (!current) return state;
  const next = fn(current);
  if (!next || next === current) return state;
  const copy = arr.slice();
  copy[ref.index] = next;
  return { ...state, [key]: copy };
}

const hasProcessing = (s: AnyStrip): s is InputStrip | MixStrip => s.ref.kind === 'input' || s.ref.kind === 'mix';
const hasPan = (s: AnyStrip): s is InputStrip | MixStrip | (AnyStrip & { pan: number }) => 'pan' in s;
const hasSends = (s: AnyStrip): s is AnyStrip & { sends: Record<number, SendState> } => 'sends' in s;

function toggleIn(list: number[], value: number, on: boolean): number[] {
  const has = list.includes(value);
  if (on === has) return list;
  return on ? [...list, value].sort((a, b) => a - b) : list.filter((v) => v !== value);
}

export function applyChange(state: MixerState, c: MixerChange): MixerState {
  switch (c.t) {
    case 'fader':
      return updateStrip(state, c.strip, (s) => (s.faderDb === c.db ? null : { ...s, faderDb: c.db }));
    case 'mute':
      return updateStrip(state, c.strip, (s) => (s.muted === c.on ? null : { ...s, muted: c.on }));
    case 'pafl':
      return updateStrip(state, c.strip, (s) => (s.pafl === c.on ? null : { ...s, pafl: c.on }));
    case 'pan':
      return updateStrip(state, c.strip, (s) => (hasPan(s) && s.pan !== c.pan ? ({ ...s, pan: c.pan } as AnyStrip) : null));
    case 'name':
      return updateStrip(state, c.strip, (s) => (s.name === c.name ? null : { ...s, name: c.name.slice(0, 8) }));
    case 'colour':
      return updateStrip(state, c.strip, (s) => (s.colour === c.colour ? null : { ...s, colour: c.colour }));
    case 'dcaAssign':
      return updateStrip(state, c.strip, (s) => {
        const next = toggleIn(s.dcaAssign, c.dca, c.on);
        return next === s.dcaAssign ? null : { ...s, dcaAssign: next };
      });
    case 'mainAssign':
      return updateStrip(state, c.strip, (s) => ('mainAssign' in s ? ({ ...s, mainAssign: c.on } as AnyStrip) : null));
    case 'send':
      return updateStrip(state, c.strip, (s) => {
        if (c.target.kind === 'fxSend') {
          if (s.ref.kind !== 'input') return null;
          const inp = s as InputStrip;
          const prev = inp.fxSends[c.target.index] ?? defaultSend();
          return { ...inp, fxSends: { ...inp.fxSends, [c.target.index]: { ...prev, ...c.patch } } };
        }
        if (!hasSends(s)) return null;
        const prev = s.sends[c.target.index] ?? defaultSend();
        return { ...s, sends: { ...s.sends, [c.target.index]: { ...prev, ...c.patch } } } as AnyStrip;
      });
    case 'preamp': {
      const cur = state.sockets[c.socket];
      if (!cur) return state;
      const sockets = state.sockets.slice();
      sockets[c.socket] = { ...cur, ...c.patch };
      return { ...state, sockets };
    }
    case 'inputConfig':
      return updateStrip(state, c.strip, (s) => (s.ref.kind === 'input' ? ({ ...s, ...c.patch } as InputStrip) : null));
    case 'source':
      return updateStrip(state, c.strip, (s) => (s.ref.kind === 'input' ? ({ ...s, source: c.source } as InputStrip) : null));
    case 'gate':
      return updateStrip(state, c.strip, (s) =>
        s.ref.kind === 'input' ? ({ ...s, gate: { ...(s as InputStrip).gate, ...c.patch } } as InputStrip) : null,
      );
    case 'comp':
      return updateStrip(state, c.strip, (s) => (hasProcessing(s) ? { ...s, comp: { ...s.comp, ...c.patch } } : null));
    case 'delay':
      return updateStrip(state, c.strip, (s) => (hasProcessing(s) ? { ...s, delay: { ...s.delay, ...c.patch } } : null));
    case 'insert':
      return updateStrip(state, c.strip, (s) => (hasProcessing(s) ? { ...s, insert: { ...s.insert, ...c.patch } } : null));
    case 'outputs':
      return updateStrip(state, c.strip, (s) => (s.ref.kind === 'mix' ? ({ ...s, outputs: c.outputs } as MixStrip) : null));
    case 'eq':
      return updateStrip(state, c.strip, (s) => {
        if (!hasProcessing(s)) return null;
        const eq = { ...s.eq };
        if (c.patch.enabled !== undefined) eq.enabled = c.patch.enabled;
        if (c.patch.hpf) eq.hpf = { ...eq.hpf, ...c.patch.hpf };
        if (c.patch.lpf) eq.lpf = { ...eq.lpf, ...c.patch.lpf };
        if (c.patch.band) {
          const bands = eq.bands.slice() as typeof eq.bands;
          bands[c.patch.band.index] = { ...bands[c.patch.band.index], ...c.patch.band.patch };
          eq.bands = bands;
        }
        return { ...s, eq };
      });
    case 'fx': {
      const cur = state.fx[c.unit];
      if (!cur) return state;
      const fx = state.fx.slice();
      const { params, ...rest } = c.patch;
      fx[c.unit] = { ...cur, ...rest, params: params ? { ...cur.params, ...params } : cur.params };
      return { ...state, fx };
    }
  }
}

export const applyChanges = (state: MixerState, changes: readonly MixerChange[]): MixerState =>
  changes.reduce(applyChange, state);

/**
 * Every settable parameter of a state as changes (used for "push show to rack").
 * Order matters on a real console: names/routing first, levels last, so a
 * half-completed push never leaves a hot fader on an unrouted channel.
 */
export function stateToChanges(state: MixerState): MixerChange[] {
  const out: MixerChange[] = [];
  const levels: MixerChange[] = [];
  state.sockets.forEach((s, socket) => out.push({ t: 'preamp', socket, patch: { gainDb: s.gainDb, pad: s.pad, phantom: s.phantom } }));
  const strips: AnyStrip[] = [...state.inputs, ...state.mixes, ...state.fxSends, ...state.fxReturns, ...state.dcas];
  for (const s of strips) {
    const strip = s.ref;
    out.push({ t: 'name', strip, name: s.name }, { t: 'colour', strip, colour: s.colour });
    for (const dca of s.dcaAssign) out.push({ t: 'dcaAssign', strip, dca, on: true });
    if ('mainAssign' in s) out.push({ t: 'mainAssign', strip, on: s.mainAssign });
    if (s.ref.kind === 'input') {
      const inp = s as InputStrip;
      out.push({ t: 'source', strip, source: inp.source }, { t: 'inputConfig', strip, patch: { trimDb: inp.trimDb, polarity: inp.polarity } });
      out.push({ t: 'gate', strip, patch: { ...inp.gate } });
      for (const [k, v] of Object.entries(inp.fxSends)) out.push({ t: 'send', strip, target: { kind: 'fxSend', index: Number(k) }, patch: { ...v } });
    }
    if (hasProcessing(s)) {
      out.push(
        { t: 'insert', strip, patch: { ...s.insert } },
        { t: 'eq', strip, patch: { enabled: s.eq.enabled, hpf: { ...s.eq.hpf }, lpf: { ...s.eq.lpf } } },
        ...s.eq.bands.map((b, i): MixerChange => ({ t: 'eq', strip, patch: { band: { index: i as 0 | 1 | 2 | 3, patch: { ...b } } } })),
        { t: 'comp', strip, patch: { ...s.comp } },
        { t: 'delay', strip, patch: { ...s.delay } },
      );
    }
    if (hasSends(s)) for (const [k, v] of Object.entries(s.sends)) out.push({ t: 'send', strip, target: { kind: 'mix', index: Number(k) }, patch: { ...v } });
    if (s.ref.kind === 'mix') out.push({ t: 'outputs', strip, outputs: (s as MixStrip).outputs.map((o) => ({ ...o })) });
    if ('pan' in s) levels.push({ t: 'pan', strip, pan: (s as InputStrip).pan });
    levels.push({ t: 'mute', strip, on: s.muted }, { t: 'fader', strip, db: s.faderDb });
  }
  state.fx.forEach((u) => out.push({ t: 'fx', unit: u.index, patch: { name: u.name, type: u.type, bypass: u.bypass, params: { ...u.params } } }));
  return [...out, ...levels];
}

// ---------------------------------------------------------------------------
// Diff: produce the minimal change list turning `from` into `to`, restricted to a
// scene scope. Used for local scene recall, show push and backup comparison.
// ---------------------------------------------------------------------------

const eqJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffMixerState(from: MixerState, to: MixerState, scope: SceneScope = { strips: 'all', blocks: ['fader', 'mute', 'pan', 'name', 'gate', 'eq', 'comp', 'delay', 'sends', 'preamp', 'routing', 'fx'] }): MixerChange[] {
  const out: MixerChange[] = [];
  const blocks = new Set<SceneBlock>(scope.blocks);
  const inScope = (k: StripKey) => scope.strips === 'all' || scope.strips.includes(k);

  const groups: Array<[AnyStrip[], AnyStrip[]]> = [
    [from.inputs, to.inputs],
    [from.mixes, to.mixes],
    [from.fxSends, to.fxSends],
    [from.fxReturns, to.fxReturns],
    [from.dcas, to.dcas],
  ];

  for (const [aList, bList] of groups) {
    for (let i = 0; i < bList.length; i++) {
      const a = aList[i];
      const b = bList[i];
      if (!a || !b || !sameStrip(a.ref, b.ref) || !inScope(stripKey(b.ref))) continue;
      const strip = b.ref;
      if (blocks.has('name')) {
        if (a.name !== b.name) out.push({ t: 'name', strip, name: b.name });
        if (a.colour !== b.colour) out.push({ t: 'colour', strip, colour: b.colour });
      }
      if (blocks.has('fader') && a.faderDb !== b.faderDb) out.push({ t: 'fader', strip, db: b.faderDb });
      if (blocks.has('mute') && a.muted !== b.muted) out.push({ t: 'mute', strip, on: b.muted });
      if (blocks.has('pan') && 'pan' in a && 'pan' in b && a.pan !== b.pan) out.push({ t: 'pan', strip, pan: b.pan });
      if (blocks.has('routing')) {
        for (let d = 0; d < 16; d++) {
          const was = a.dcaAssign.includes(d);
          const now = b.dcaAssign.includes(d);
          if (was !== now) out.push({ t: 'dcaAssign', strip, dca: d, on: now });
        }
        if ('mainAssign' in a && 'mainAssign' in b && a.mainAssign !== b.mainAssign)
          out.push({ t: 'mainAssign', strip, on: b.mainAssign });
        if (a.ref.kind === 'input' && !eqJson((a as InputStrip).source, (b as InputStrip).source))
          out.push({ t: 'source', strip, source: (b as InputStrip).source });
        if (hasProcessing(a) && hasProcessing(b) && !eqJson(a.insert, b.insert)) out.push({ t: 'insert', strip, patch: { ...b.insert } });
        if (a.ref.kind === 'mix' && !eqJson((a as MixStrip).outputs, (b as MixStrip).outputs))
          out.push({ t: 'outputs', strip, outputs: (b as MixStrip).outputs.map((o) => ({ ...o })) });
      }
      if (blocks.has('preamp') && a.ref.kind === 'input') {
        const ia = a as InputStrip;
        const ib = b as InputStrip;
        if (ia.trimDb !== ib.trimDb || ia.polarity !== ib.polarity) out.push({ t: 'inputConfig', strip, patch: { trimDb: ib.trimDb, polarity: ib.polarity } });
      }
      if (hasProcessing(a) && hasProcessing(b)) {
        if (a.ref.kind === 'input' && blocks.has('gate') && !eqJson((a as InputStrip).gate, (b as InputStrip).gate))
          out.push({ t: 'gate', strip, patch: { ...(b as InputStrip).gate } });
        if (blocks.has('comp') && !eqJson(a.comp, b.comp)) out.push({ t: 'comp', strip, patch: { ...b.comp } });
        if (blocks.has('delay') && !eqJson(a.delay, b.delay)) out.push({ t: 'delay', strip, patch: { ...b.delay } });
        if (blocks.has('eq')) {
          if (a.eq.enabled !== b.eq.enabled) out.push({ t: 'eq', strip, patch: { enabled: b.eq.enabled } });
          if (!eqJson(a.eq.hpf, b.eq.hpf)) out.push({ t: 'eq', strip, patch: { hpf: { ...b.eq.hpf } } });
          if (!eqJson(a.eq.lpf, b.eq.lpf)) out.push({ t: 'eq', strip, patch: { lpf: { ...b.eq.lpf } } });
          b.eq.bands.forEach((band, idx) => {
            if (!eqJson(a.eq.bands[idx], band))
              out.push({ t: 'eq', strip, patch: { band: { index: idx as 0 | 1 | 2 | 3, patch: { ...band } } } });
          });
        }
      }
      if (blocks.has('sends') && hasSends(a) && hasSends(b)) {
        const keys = new Set([...Object.keys(a.sends), ...Object.keys(b.sends)].map(Number));
        for (const k of keys) {
          const sa = a.sends[k] ?? defaultSend();
          const sb = b.sends[k] ?? defaultSend();
          if (!eqJson(sa, sb)) out.push({ t: 'send', strip, target: { kind: 'mix', index: k }, patch: { ...sb } });
        }
      }
      if (blocks.has('sends') && a.ref.kind === 'input') {
        const fa = (a as InputStrip).fxSends;
        const fb = (b as InputStrip).fxSends;
        for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)].map(Number))) {
          const sa = fa[k] ?? defaultSend();
          const sb = fb[k] ?? defaultSend();
          if (!eqJson(sa, sb)) out.push({ t: 'send', strip, target: { kind: 'fxSend', index: k }, patch: { ...sb } });
        }
      }
    }
  }

  if (blocks.has('preamp')) {
    to.sockets.forEach((s, i) => {
      const a = from.sockets[i];
      if (a && !eqJson(a, s)) out.push({ t: 'preamp', socket: i, patch: { gainDb: s.gainDb, pad: s.pad, phantom: s.phantom } });
    });
  }
  if (blocks.has('fx')) {
    to.fx.forEach((u, i) => {
      const a = from.fx[i];
      if (a && !eqJson(a, u)) out.push({ t: 'fx', unit: i, patch: { name: u.name, type: u.type, bypass: u.bypass, params: { ...u.params } } });
    });
  }
  return out;
}
