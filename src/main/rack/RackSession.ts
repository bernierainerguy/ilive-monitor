import { coalesceKey, type MixerChange } from '@shared/domain/changes';
import { FADER_MIN_DB } from '@shared/domain/units';
import { isMonitorBus, monitorSources } from '@shared/monitorPolicy';
import {
  MAX_MISSED_PROBES,
  NO_CAPABILITIES,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  RECONNECT_INTERVAL_MS,
  emptyHealth,
  unconfirmedSendKey,
  type ConnectionPhase,
  type RackStatus,
} from '@shared/rack';
import type { RackTarget } from '@shared/settings';
import { applyMixLayout, mixLayout, parseMixConfig, type MixLayout } from '@shared/mixLayout';
import { createDefaultMixerState } from '@shared/domain/defaults';
import type { Logger } from '../logging/Logger';
import type { MixRackProtocol } from '../protocol/MixRackProtocol';
import { Emitter } from '../transport/Transport';
import type { StateCache } from './StateCache';

/** The mixes as the app lays them out by default (and the simulator's rack has them). */
const DEFAULT_LAYOUT: MixLayout = {
  slots: createDefaultMixerState().mixes.map((m) => ({ role: m.role, stereo: m.stereo, channels: [] })),
  mixSends: new Map(),
  fxSends: new Map(),
};

export type ProtocolFactory = (target: RackTarget) => MixRackProtocol;

export interface RackSessionOptions {
  reconnectMs?: number;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  maxMissedProbes?: number;
  /** Inbound values for a control we moved within this window are treated as stale echoes. */
  echoGuardMs?: number;
  outboundFlushMs?: number;
  /** The mix bus this Mac adjusts: its sends are the ones tracked as unconfirmed. */
  bus?: () => number | null;
}

/**
 * Owns the lifetime of one rack connection: connect, identify, pull, watchdog,
 * outbound coalescing, echo suppression and automatic reconnect (2 s).
 *
 * The rack is always authoritative: every connect pulls from it, and nothing is
 * ever pushed except the send levels the operator moves. Other clients (the FOH
 * surface, iLive Touch) run their own sessions against the same MixRack; each
 * folds the rack's change notifications into its cache.
 */
export class RackSession {
  private target: RackTarget | null = null;
  private protocol: MixRackProtocol | null = null;
  private protoUnsubs: Array<() => void> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private outbound = new Map<string, MixerChange>();
  private outboundOrdered: MixerChange[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sends the rack has reported, or we set, since the last pull (keys from `unconfirmedSendKey`). */
  private readonly confirmed = new Set<string>();
  /** The protocol can't report send levels, so unreported ones are unconfirmed. */
  private tracking = false;
  private unconfirmedTimer: ReturnType<typeof setTimeout> | null = null;
  private recentOutbound = new Map<string, number>();
  /** Send levels we sent inside the echo-guard window, per control: an echo of any of them is ours. */
  private recentLevels = new Map<string, number[]>();
  private rttSamples: number[] = [];
  private everConnected = false;
  private generation = 0;

  private _status: RackStatus = {
    phase: 'offline', targetId: null, identity: null, capabilities: NO_CAPABILITIES, health: emptyHealth(),
    lastError: null, cacheUnverified: false, unconfirmed: [],
  };

  readonly status = new Emitter<RackStatus>();
  readonly meters = new Emitter<Float32Array>();
  readonly remoteSceneRecall = new Emitter<number>();

  private readonly o: Required<Omit<RackSessionOptions, 'bus'>>;
  private readonly bus: () => number | null;

  constructor(
    private readonly cache: StateCache,
    private readonly log: Logger,
    private readonly factory: ProtocolFactory,
    opts: RackSessionOptions = {},
  ) {
    this.o = {
      reconnectMs: opts.reconnectMs ?? RECONNECT_INTERVAL_MS,
      probeIntervalMs: opts.probeIntervalMs ?? PROBE_INTERVAL_MS,
      probeTimeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      maxMissedProbes: opts.maxMissedProbes ?? MAX_MISSED_PROBES,
      echoGuardMs: opts.echoGuardMs ?? 200,
      outboundFlushMs: opts.outboundFlushMs ?? 2,
    };
    this.bus = opts.bus ?? (() => null);
  }

  get current(): RackStatus {
    return this._status;
  }

  /** Whether outbound changes reach the rack. Syncing counts: a push happens in that phase. */
  get isLive(): boolean {
    const p = this._status.phase;
    return !!this.protocol && (p === 'online' || p === 'degraded' || p === 'syncing');
  }

  /**
   * Whether a change would reach the rack now. Not while syncing: the faders are locked until the pull from
   * the rack is done, so a move can't land on top of values that are still arriving.
   */
  supports(c: MixerChange): boolean {
    const p = this._status.phase;
    return !!this.protocol && (p === 'online' || p === 'degraded') && this.protocol.supports(c);
  }

  /** Begin (or switch) the connection. Returns immediately; progress arrives via `status`. */
  connect(target: RackTarget): void {
    this.teardownProtocol();
    this.clearReconnect();
    this.target = target;
    this.everConnected = false;
    this.patch({ targetId: target.id, lastError: null, health: emptyHealth() });
    void this.attempt();
  }

  disconnect(): void {
    this.target = null;
    this.clearReconnect();
    this.teardownProtocol();
    this.patch({ phase: 'offline', targetId: null, identity: null, capabilities: NO_CAPABILITIES });
    this.log.info('network', 'Disconnected by user');
  }

  /** Queue changes for the rack. Changes the protocol can't express are skipped (they stay in the show). */
  send(changes: readonly MixerChange[]): { sent: number; unsupported: number } {
    if (!this.protocol || !this.isLive) return { sent: 0, unsupported: 0 };
    let sent = 0;
    let unsupported = 0;
    for (const c of changes) {
      if (!this.protocol.supports(c)) {
        unsupported++;
        continue;
      }
      const key = coalesceKey(c);
      if (key) {
        if (!this.outbound.has(key)) this.outboundOrdered.push(c);
        else this.outboundOrdered[this.outboundOrdered.indexOf(this.outbound.get(key)!)] = c;
        this.outbound.set(key, c);
        const now = Date.now();
        if (c.t === 'send' && c.patch.levelDb !== undefined) {
          const fresh = (this.recentOutbound.get(key) ?? 0) > now - this.o.echoGuardMs;
          this.recentLevels.set(key, [...(fresh ? (this.recentLevels.get(key) ?? []).slice(-63) : []), c.patch.levelDb]);
        }
        this.recentOutbound.set(key, now);
      } else {
        this.outboundOrdered.push(c);
      }
      this.confirm(c);
      sent++;
    }
    if (sent && !this.flushTimer) this.flushTimer = setTimeout(() => this.flushOutbound(), this.o.outboundFlushMs);
    return { sent, unsupported };
  }

  /** Send anything still queued now, and give the socket a moment to write it (quitting). */
  async drain(ms = 50): Promise<void> {
    if (!this.protocol || !this.isLive) return;
    this.flushOutbound();
    await new Promise((r) => setTimeout(r, ms));
  }

  dispose(): void {
    this.disconnect();
    this.status.clear();
    this.meters.clear();
    this.remoteSceneRecall.clear();
  }

  // -------------------------------------------------------------------------

  private async attempt(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const gen = ++this.generation;
    this.patch({ phase: this.everConnected ? 'reconnecting' : 'connecting' });
    let protocol: MixRackProtocol | undefined;
    try {
      protocol = this.factory(target);
      if (!protocol) throw new Error(`Unknown rack protocol "${String(target.protocol)}"`);
      const identity = await protocol.open();
      if (gen !== this.generation || this.target !== target) {
        protocol.close();
        return;
      }
      this.protocol = protocol;
      this.conform(target);
      this.bindProtocol(protocol);
      const isReconnect = this.everConnected;
      this.everConnected = true;
      // Mark everything unconfirmed before the link is exposed, so no stale level ever looks confirmed.
      this.markUnconfirmed(protocol);
      this.patch({ identity, capabilities: protocol.capabilities, lastError: null, phase: 'syncing' });
      this.log.info('network', `Connected to ${identity.name} (${identity.ip})`, { protocol: protocol.id, isReconnect });
      this.startWatchdog();

      // The rack is authoritative, always: other clients may have mixed while we were away.
      await protocol.requestState(this.cache.state);
      if (gen !== this.generation || this.protocol !== protocol) return; // dropped again during the pull
      this.patch({ phase: 'online', cacheUnverified: protocol.capabilities.stateQuery !== 'full' });
    } catch (err) {
      protocol?.close();
      if (gen !== this.generation) return;
      const message = connectErrorMessage(err, target);
      this._status.health.errors++;
      this.patch({ lastError: message });
      this.log.warn('network', `Connect failed: ${message}`, { target: target.host });
      this.scheduleReconnect();
    }
  }

  /**
   * Reshape the mixes to the rack's configured layout, so strip N addresses the right rack mix and
   * "Aux 3" is the rack's Aux 3. Also used offline, so Settings offers the rack's auxes before connecting.
   */
  conform(target: RackTarget) {
    const cfg = target.protocol === 'ilive-midi-tcp' ? parseMixConfig(target.mixConfig) : null;
    // No configuration (the simulator, or MIDI before one is entered): the default layout, not the last rack's.
    const next = applyMixLayout(this.cache.state, cfg ? mixLayout(cfg) : DEFAULT_LAYOUT);
    if (!next) return;
    this.cache.replace(next);
    this.log.info('network', 'Arranged the mixes to match the rack mix configuration');
    this.publishUnconfirmed(true); // the chosen aux may now be a different mix
  }

  private bindProtocol(p: MixRackProtocol) {
    this.protoUnsubs.push(
      p.onChange((c) => this.inbound(c)),
      p.onMeters((f) => this.meters.emit(f)),
      p.onRemoteSceneRecall((n) => {
        this.log.info('scene', `Scene ${n} recalled on the rack or by another client`);
        this.remoteSceneRecall.emit(n);
        if (p.capabilities.stateQuery !== 'full') {
          this.patch({ cacheUnverified: true });
          this.markUnconfirmed(p);
          void p.requestState(this.cache.state);
        }
      }),
      p.onClose((err) => this.linkLost(err?.message ?? 'connection closed')),
    );
  }

  private inbound(c: MixerChange) {
    this._status.health.lastRxAt = Date.now();
    const key = coalesceKey(c);
    if (key) {
      const sentAt = this.recentOutbound.get(key);
      if (sentAt !== undefined && Date.now() - sentAt < this.o.echoGuardMs) {
        // Inside the echo guard: an echo of a level we just sent (the final one or a step of the drag) is ours.
        // Anything else is someone else moving it at the same moment: we can't tell who won, so say so.
        if (this.isOurEcho(key, c)) this.confirm(c);
        else this.unconfirm(c);
        return;
      }
    }
    this.confirm(c);
    this.cache.apply([c]);
  }

  private flushOutbound() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const p = this.protocol;
    const batch = this.outboundOrdered;
    this.outboundOrdered = [];
    this.outbound.clear();
    if (!p) return;
    for (const c of batch) {
      try {
        p.send(c);
      } catch (err) {
        this._status.health.errors++;
        this.log.error('protocol', `Send failed: ${(err as Error).message}`, { change: c.t });
      }
    }
    // bound memory of the echo guard
    if (this.recentOutbound.size > 512) {
      const cutoff = Date.now() - this.o.echoGuardMs;
      for (const [k, t] of this.recentOutbound) if (t < cutoff) {
        this.recentOutbound.delete(k);
        this.recentLevels.delete(k);
      }
    }
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.probeTimer = setInterval(() => void this.runProbe(), this.o.probeIntervalMs);
  }

  private async runProbe() {
    const p = this.protocol;
    if (!p || this.probing) return;
    this.probing = true;
    try {
      const rtt = await p.probe(this.o.probeTimeoutMs);
      if (p !== this.protocol) return;
      this.rttSamples.push(rtt);
      if (this.rttSamples.length > 20) this.rttSamples.shift();
      const avg = this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length;
      this.patch({
        health: { ...this._status.health, rttMs: rtt, rttAvgMs: avg, missedProbes: 0 },
        ...(this._status.phase === 'degraded' ? { phase: 'online' as ConnectionPhase } : {}),
      });
    } catch {
      if (p !== this.protocol) return;
      const missed = this._status.health.missedProbes + 1;
      this.patch({ health: { ...this._status.health, missedProbes: missed }, phase: 'degraded' });
      this.log.warn('network', `Watchdog: missed probe ${missed}/${this.o.maxMissedProbes}`);
      if (missed >= this.o.maxMissedProbes) this.linkLost('watchdog: rack not responding');
    } finally {
      this.probing = false;
    }
  }

  private linkLost(reason: string) {
    if (!this.protocol) return;
    this.log.error('network', `Link lost: ${reason}`);
    this.teardownProtocol();
    this._status.health.reconnects++;
    this.patch({ lastError: reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (!this.target) return;
    this.clearReconnect();
    this.patch({ phase: 'reconnecting' });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attempt();
    }, this.o.reconnectMs);
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private stopWatchdog() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.probing = false;
  }

  private teardownProtocol() {
    this.generation++;
    this.clearUnconfirmed();
    this.stopWatchdog();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.outbound.clear();
    this.outboundOrdered = [];
    this.protoUnsubs.forEach((u) => u());
    this.protoUnsubs = [];
    const p = this.protocol;
    this.protocol = null;
    p?.close();
  }

  // --- sends the rack hasn't confirmed ----------------------------------------

  /** After a pull the protocol couldn't complete, every send is unconfirmed until reported or moved. */
  private markUnconfirmed(p: MixRackProtocol) {
    this.confirmed.clear();
    this.tracking = p.capabilities.stateQuery !== 'full';
    this.publishUnconfirmed(true);
  }

  private clearUnconfirmed() {
    const had = this.tracking;
    this.tracking = false;
    this.confirmed.clear();
    if (had) this.publishUnconfirmed(true);
  }

  private confirm(c: MixerChange) {
    if (!this.tracking || c.t !== 'send' || c.target.kind !== 'mix' || c.patch.levelDb === undefined) return;
    const key = unconfirmedSendKey(c.strip, c.target.index);
    if (this.confirmed.has(key)) return;
    this.confirmed.add(key);
    if (c.target.index === this.bus()) this.publishUnconfirmed(false);
  }

  private unconfirm(c: MixerChange) {
    if (!this.tracking || c.t !== 'send' || c.target.kind !== 'mix') return;
    if (this.confirmed.delete(unconfirmedSendKey(c.strip, c.target.index)) && c.target.index === this.bus()) this.publishUnconfirmed(false);
  }

  private isOurEcho(key: string, c: MixerChange): boolean {
    if (c.t !== 'send' || c.patch.levelDb === undefined) return true;
    const heard = c.patch.levelDb;
    return (this.recentLevels.get(key) ?? []).some((sent) => sameLevel(sent, heard));
  }

  /** The bus in Settings changed: report what's unconfirmed on the new one. */
  busChanged() {
    this.publishUnconfirmed(true);
  }

  private unconfirmedList(): string[] {
    const bus = this.bus();
    if (!this.tracking || bus === null || !isMonitorBus(this.cache.state, bus)) return [];
    return monitorSources(this.cache.state).map((ref) => unconfirmedSendKey(ref, bus)).filter((k) => !this.confirmed.has(k));
  }

  /** Coalesced: a burst of rack notifications can confirm dozens of sends at once. */
  private publishUnconfirmed(now: boolean) {
    if (this.unconfirmedTimer) clearTimeout(this.unconfirmedTimer);
    this.unconfirmedTimer = null;
    const flush = () => {
      this.unconfirmedTimer = null;
      this.patch({ unconfirmed: this.unconfirmedList() });
    };
    if (now) flush();
    else this.unconfirmedTimer = setTimeout(flush, 50);
  }

  private patch(p: Partial<RackStatus>) {
    this._status = { ...this._status, ...p };
    this.status.emit(this._status);
  }
}

/**
 * Turn socket errors into something an engineer can act on. macOS answers an app
 * that hasn't been given Local Network access with EHOSTUNREACH, even when the
 * rack answers ping and other apps, so that case names the setting.
 */
/**
 * Two send levels the rack can't tell apart. iLive MIDI carries levels in 0.5 dB steps, so an echo of -7.83 comes
 * back as -8. Anything at or below the fader's floor is off.
 */
export function sameLevel(a: number, b: number): boolean {
  const off = (v: number) => v <= FADER_MIN_DB;
  if (off(a) || off(b)) return off(a) && off(b);
  return Math.abs(a - b) <= 0.5;
}

export function connectErrorMessage(err: unknown, target: Pick<RackTarget, 'host' | 'port'>): string {
  const code = (err as { code?: string } | null)?.code;
  const where = `${target.host}:${target.port}`;
  switch (code) {
    case 'EHOSTUNREACH':
      return `Can't reach ${where}. If the rack answers other apps, macOS is blocking iLive Monitor's local network access: turn it on in System Settings › Privacy & Security › Local Network.`;
    case 'ENETUNREACH':
      return `No network route to ${target.host}. Check this Mac is on the rack's network.`;
    case 'ECONNREFUSED':
      return `${where} refused the connection. Check the port (51325 for iLive) and the IP address.`;
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
