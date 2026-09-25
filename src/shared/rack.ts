import { stripKey, type StripRef } from './domain/ids';
export type ConnectionPhase = 'offline' | 'connecting' | 'syncing' | 'online' | 'degraded' | 'reconnecting';

/** What the active protocol can actually do. UI disables controls the rack can't honour. */
export interface ProtocolCapabilities {
  faders: boolean;
  mutes: boolean;
  pan: boolean;
  names: boolean;
  colours: boolean;
  sends: boolean;
  /** Send mutes, pans and pre/post (MIDI carries send levels only). */
  sendDetail: boolean;
  /** DCA and main-mix assignment. */
  assign: boolean;
  preamp: boolean;
  processing: boolean;
  routing: boolean;
  fx: boolean;
  metering: boolean;
  sceneRecall: boolean;
  /** Whether the rack can be asked for its current parameter values. */
  stateQuery: 'full' | 'partial' | 'none';
}

export const NO_CAPABILITIES: ProtocolCapabilities = {
  faders: false, mutes: false, pan: false, names: false, colours: false, sends: false, sendDetail: false, assign: false, preamp: false,
  processing: false, routing: false, fx: false, metering: false, sceneRecall: false, stateQuery: 'none',
};

export interface RackIdentity {
  name: string;
  model: 'iDR48';
  firmware: string | null;
  ip: string;
}

export interface ConnectionHealth {
  rttMs: number | null;
  rttAvgMs: number | null;
  lastRxAt: number | null;
  missedProbes: number;
  bytesIn: number;
  bytesOut: number;
  reconnects: number;
  errors: number;
}

export interface RackStatus {
  phase: ConnectionPhase;
  targetId: string | null;
  identity: RackIdentity | null;
  capabilities: ProtocolCapabilities;
  health: ConnectionHealth;
  lastError: string | null;
  /** True when the cache contains values the rack could not confirm (see `stateQuery`). */
  cacheUnverified: boolean;
  /**
   * Sends to the chosen bus whose rack level isn't known yet, as
   * `send:<stripKey>>mix:<n>`. The rack can't be asked for send levels over MIDI,
   * so each one is confirmed when the rack reports it or the operator moves it.
   * Empty when the protocol can report its full state.
   */
  unconfirmed: string[];
}

export const unconfirmedSendKey = (strip: StripRef, bus: number): string => `send:${stripKey(strip)}>mix:${bus}`;

export const emptyHealth = (): ConnectionHealth => ({
  rttMs: null, rttAvgMs: null, lastRxAt: null, missedProbes: 0, bytesIn: 0, bytesOut: 0, reconnects: 0, errors: 0,
});

export const RECONNECT_INTERVAL_MS = 2000;
export const PROBE_INTERVAL_MS = 1000;
export const PROBE_TIMEOUT_MS = 750;
export const MAX_MISSED_PROBES = 3;
