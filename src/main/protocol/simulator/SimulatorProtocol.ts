import { applyChange, diffMixerState, type MixerChange } from '@shared/domain/changes';
import { createDefaultMixerState } from '@shared/domain/defaults';
import type { MixerState } from '@shared/domain/model';
import { METER_FLOOR_DB, METER_LAYOUT, createMeterFrame } from '@shared/meters';
import type { ProtocolCapabilities, RackIdentity } from '@shared/rack';
import type { MixRackProtocol } from '../MixRackProtocol';
import { Emitter } from '../../transport/Transport';

export const SIMULATOR_CAPABILITIES: ProtocolCapabilities = {
  faders: true, mutes: true, pan: true, names: true, colours: true, sends: true, sendDetail: true, assign: true, preamp: true,
  processing: true, routing: true, fx: true, metering: true, sceneRecall: true, stateQuery: 'full',
};

/**
 * A virtual iDR48: holds the "hardware" state and relays every change to every
 * *other* connected client, exactly like a real MixRack serving FOH, monitors and
 * broadcast at once. Used for training, offline demos, UI work and tests.
 */
export class SimulatedRack {
  state: MixerState;
  readonly clients = new Set<SimulatorProtocol>();
  readonly scenes = new Map<number, MixerState>();

  constructor(initial: MixerState = createDefaultMixerState()) {
    this.state = initial;
  }

  apply(c: MixerChange, from?: SimulatorProtocol) {
    this.state = applyChange(this.state, c);
    for (const client of this.clients) if (client !== from) client.notify(c);
  }

  recallScene(n: number) {
    const snap = this.scenes.get(n);
    if (!snap) return;
    for (const c of diffMixerState(this.state, snap)) this.apply(c);
    for (const client of this.clients) client.notifySceneRecall(n);
  }
}

export class SimulatorProtocol implements MixRackProtocol {
  readonly id = 'simulator';
  readonly capabilities = SIMULATOR_CAPABILITIES;

  private readonly changes = new Emitter<MixerChange>();
  private readonly meters = new Emitter<Float32Array>();
  private readonly sceneRecalls = new Emitter<number>();
  private readonly closed = new Emitter<Error | undefined>();
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private phase = 0;
  private isOpen = false;
  /** Test hook: when true the rack stops answering probes (a hung rack, not a dropped link). */
  hung = false;

  constructor(
    readonly rack: SimulatedRack = new SimulatedRack(),
    private readonly opts: { meterFps?: number; latencyMs?: number } = {},
  ) {}

  async open(): Promise<RackIdentity> {
    await this.delay();
    this.isOpen = true;
    this.rack.clients.add(this);
    const fps = this.opts.meterFps ?? 30;
    if (fps > 0) this.meterTimer = setInterval(() => this.emitMeters(), 1000 / fps);
    return { name: 'iDR48 Simulator', model: 'iDR48', firmware: 'SIM-1.90', ip: '127.0.0.1' };
  }

  close(): void {
    this.stop();
  }

  /** Test hook: simulate a network failure on this client's link. */
  simulateDrop(err = new Error('simulated link loss')): void {
    if (!this.isOpen) return;
    this.stop();
    this.closed.emit(err);
  }

  /** Called by the rack when another client (or the rack itself) changed something. */
  notify(c: MixerChange) {
    if (this.isOpen) this.changes.emit(c);
  }

  notifySceneRecall(n: number) {
    if (this.isOpen) this.sceneRecalls.emit(n);
  }

  supports(): boolean {
    return true;
  }

  send(c: MixerChange): void {
    if (!this.isOpen) throw new Error('simulator not open');
    this.rack.apply(c, this);
  }

  recallScene(n: number): void {
    this.rack.recallScene(n);
  }

  async probe(timeoutMs: number): Promise<number> {
    if (!this.isOpen) throw new Error('simulator not open');
    if (this.hung) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      throw new Error('probe timeout');
    }
    const t = performance.now();
    await this.delay();
    return performance.now() - t;
  }

  async requestState(current: MixerState): Promise<void> {
    await this.delay();
    for (const c of diffMixerState(current, this.rack.state)) this.changes.emit(c);
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

  private stop() {
    this.isOpen = false;
    this.rack.clients.delete(this);
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
  }

  private delay() {
    const ms = this.opts.latencyMs ?? 0;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private emitMeters() {
    this.phase += 0.07;
    const f = createMeterFrame();
    const signal = (i: number) => -24 + 14 * Math.sin(this.phase * (1 + (i % 7) * 0.13) + i) + 6 * Math.random();
    const rack = this.rack.state;
    rack.inputs.forEach((s, i) => {
      const src = s.source.kind === 'none' ? METER_FLOOR_DB : signal(i);
      f[METER_LAYOUT.inputs.start + i] = src;
      const gateClosed = s.gate.enabled && src < s.gate.thresholdDb;
      f[METER_LAYOUT.gateOpen.start + i] = gateClosed ? 0 : 1;
      f[METER_LAYOUT.gateGr.start + i] = gateClosed ? s.gate.depthDb : 0;
      const over = src - s.comp.thresholdDb;
      f[METER_LAYOUT.compGrInputs.start + i] = s.comp.enabled && over > 0 ? over - over / s.comp.ratio : 0;
    });
    rack.mixes.forEach((s, i) => {
      const lvl = s.role === 'unused' || s.muted ? METER_FLOOR_DB : Math.min(0, signal(i + 3) + Math.max(-40, s.faderDb));
      f[METER_LAYOUT.mixesL.start + i] = lvl;
      f[METER_LAYOUT.mixesR.start + i] = s.stereo ? lvl - Math.random() * 2 : lvl;
    });
    rack.fxReturns.forEach((s, i) => {
      f[METER_LAYOUT.fxReturns.start + i] = s.muted ? METER_FLOOR_DB : signal(i + 11) - 10;
    });
    this.meters.emit(f);
  }
}
