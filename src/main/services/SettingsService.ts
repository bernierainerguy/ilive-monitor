import { IDR48 } from '@shared/domain/ids';
import { parseMixConfig } from '@shared/mixLayout';
import { DEFAULT_SETTINGS, type MonitorSettings, type RackTarget } from '@shared/settings';
import type { SettingsPatch } from '@shared/ipc';
import { BUILTIN_THEMES } from '@shared/theme';
import type { Logger } from '../logging/Logger';
import { readJson, writeJsonAtomic } from '../storage/JsonStore';
import { Emitter } from '../transport/Transport';

/**
 * Racks, the chosen mix bus and the theme, kept in one JSON file and restored on
 * every launch. Everything read from disk or IPC is validated here.
 */
export class SettingsService {
  readonly changed = new Emitter<MonitorSettings>();
  private s: MonitorSettings = DEFAULT_SETTINGS;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly log: Logger) {}

  get current(): MonitorSettings {
    return this.s;
  }

  async init(): Promise<MonitorSettings> {
    try {
      this.s = parseSettings(await readJson<unknown>(this.path));
    } catch (err) {
      this.log.error('system', `Settings unreadable, starting fresh: ${(err as Error).message}`);
      this.s = DEFAULT_SETTINGS;
    }
    return this.s;
  }

  update(patch: SettingsPatch): MonitorSettings {
    const next = { ...this.s };
    if (patch.bus !== undefined) next.bus = parseBus(patch.bus);
    if (patch.themeId !== undefined) next.themeId = parseTheme(patch.themeId);
    return this.commit(next);
  }

  upsertRack(t: RackTarget): MonitorSettings {
    const rack = parseRack(t);
    if (!rack) throw new Error('Invalid rack');
    const racks = this.s.racks.some((r) => r.id === rack.id) ? this.s.racks.map((r) => (r.id === rack.id ? rack : r)) : [...this.s.racks, rack];
    return this.commit({ ...this.s, racks });
  }

  deleteRack(id: string): MonitorSettings {
    return this.commit({ ...this.s, racks: this.s.racks.filter((r) => r.id !== id), lastTargetId: this.s.lastTargetId === id ? null : this.s.lastTargetId });
  }

  setLastTarget(id: string | null): void {
    if (id !== this.s.lastTargetId) this.commit({ ...this.s, lastTargetId: id });
  }

  /** Resolves once everything written so far is on disk. */
  flush(): Promise<unknown> {
    return this.writing;
  }

  private commit(next: MonitorSettings): MonitorSettings {
    this.s = next;
    this.writing = this.writing
      .then(() => writeJsonAtomic(this.path, next))
      .catch((err: Error) => this.log.error('system', `Couldn't save settings: ${err.message}`));
    this.changed.emit(next);
    return next;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseBus(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < IDR48.mixBuses ? v : null;
}

function parseTheme(v: unknown): string {
  return typeof v === 'string' && BUILTIN_THEMES.some((t) => t.id === v) ? v : DEFAULT_SETTINGS.themeId;
}

export function parseRack(v: unknown): RackTarget | null {
  if (!isObj(v)) return null;
  const { id, name, host, port, protocol, midiChannel, autoConnect, mixConfig } = v;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof host !== 'string') return null;
  if (protocol !== 'ilive-midi-tcp' && protocol !== 'simulator') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (typeof midiChannel !== 'number' || !Number.isInteger(midiChannel) || midiChannel < 0 || midiChannel > 15) return null;
  const cfg = mixConfig === undefined ? undefined : parseMixConfig(mixConfig);
  if (cfg === null) return null;
  return { id, name: name.slice(0, 64), host: host.trim(), port, protocol, midiChannel, autoConnect: autoConnect === true, ...(cfg ? { mixConfig: cfg } : {}) };
}

export function parseSettings(v: unknown): MonitorSettings {
  if (!isObj(v)) return DEFAULT_SETTINGS;
  const racks = Array.isArray(v['racks']) ? v['racks'].map(parseRack).filter((r): r is RackTarget => r !== null) : [];
  const last = typeof v['lastTargetId'] === 'string' && racks.some((r) => r.id === v['lastTargetId']) ? (v['lastTargetId'] as string) : null;
  return { schema: 1, racks, lastTargetId: last, bus: parseBus(v['bus']), themeId: parseTheme(v['themeId']) };
}
