import type { RackMixConfig } from './mixLayout';

export interface RackTarget {
  readonly id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'ilive-midi-tcp' | 'simulator';
  midiChannel: number; // 0..15, must match the MixRack's MIDI setting
  autoConnect: boolean;
  /** iLive MIDI: the rack's mix configuration, which MIDI can't report. Without it sends can't reach the rack. */
  mixConfig?: RackMixConfig;
}

/**
 * Everything iLive Monitor keeps between launches. There is no show file: the
 * rack is the only source of mix state, and this is only how to reach it and
 * which bus this Mac mixes.
 */
export interface MonitorSettings {
  readonly schema: 1;
  racks: RackTarget[];
  lastTargetId: string | null;
  /**
   * The aux whose sends this Mac adjusts, by aux number (1 = the rack's first aux), as an engineer names it.
   * Not a mix index: where Aux 3 sits depends on the rack's mix configuration, which can change. Null until chosen.
   */
  aux: number | null;
  themeId: string;
}

/** Built in so the app can be tried and learned without hardware. */
export const SIMULATOR_RACK: RackTarget = { id: 'simulator', name: 'iDR48 Simulator', host: '', port: 0, protocol: 'simulator', midiChannel: 0, autoConnect: false };

export const DEFAULT_SETTINGS: MonitorSettings = {
  schema: 1,
  racks: [SIMULATOR_RACK],
  lastTargetId: null,
  aux: null,
  themeId: 'dark',
};
