import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_LEVEL_ORDER, type LogCategory, type LogEntry, type LogLevel } from '@shared/log';

export type LogSink = (e: LogEntry) => void;

/**
 * Central logger. Keeps a bounded in-memory ring (for the in-app log view) and
 * fans out to sinks. Never throws: a logging failure must not take down mixing.
 */
export class Logger {
  private readonly ring: LogEntry[] = [];
  private readonly sinks = new Set<LogSink>();

  constructor(
    private minLevel: LogLevel = 'info',
    private readonly ringSize = 2000,
  ) {}

  setLevel(level: LogLevel) {
    this.minLevel = level;
  }

  addSink(s: LogSink): () => void {
    this.sinks.add(s);
    return () => this.sinks.delete(s);
  }

  log(level: LogLevel, category: LogCategory, message: string, data?: Record<string, unknown>) {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = { ts: new Date().toISOString(), level, category, message, ...(data ? { data } : {}) };
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    for (const s of this.sinks) {
      try {
        s(entry);
      } catch {
        /* a broken sink must never break the caller */
      }
    }
  }

  debug = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.log('debug', c, m, d);
  info = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.log('info', c, m, d);
  warn = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.log('warn', c, m, d);
  error = (c: LogCategory, m: string, d?: Record<string, unknown>) => this.log('error', c, m, d);

  tail(limit: number): LogEntry[] {
    return this.ring.slice(-limit);
  }
}

/** JSON-lines file sink with size-based rotation (keeps `keep` old files). */
export function createFileSink(dir: string, opts: { maxBytes?: number; keep?: number } = {}): LogSink {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ilive-touch.log');
  let written = existsSync(file) ? statSync(file).size : 0;

  const rotate = () => {
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
    }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    written = 0;
  };

  return (e) => {
    const line = JSON.stringify(e) + '\n';
    if (written + line.length > maxBytes) rotate();
    appendFileSync(file, line);
    written += line.length;
  };
}

export const consoleSink: LogSink = (e) => {
  const fn = e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log;
  fn(`[${e.ts}] ${e.level.toUpperCase()} ${e.category}: ${e.message}`, e.data ?? '');
};
