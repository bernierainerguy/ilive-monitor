export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'user' | 'protocol' | 'network' | 'backup' | 'scene' | 'show' | 'window' | 'system' | 'crash';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
}

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
