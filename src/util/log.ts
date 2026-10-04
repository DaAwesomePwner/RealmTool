export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  at: number;
  level: LogLevel;
  module: string;
  message: string;
}

type Sink = (record: LogRecord) => void;

const sinks = new Set<Sink>();
let consoleEnabled = true;
let debugEnabled = process.env.REALMTOOL_DEBUG === '1';

function emit(level: LogLevel, module: string, message: string): void {
  if (level === 'debug' && !debugEnabled) return;
  const record: LogRecord = { at: Date.now(), level, module, message };
  if (consoleEnabled) {
    const time = new Date(record.at).toISOString().slice(11, 23);
    const prefix = level === 'info' ? '' : `${level.toUpperCase()}: `;
    const line = `[${time}] [${module}] ${prefix}${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
  for (const sink of sinks) {
    try { sink(record); }
    catch {
      sinks.delete(sink);
      console.warn('[log] Removed a failing log sink.');
    }
  }
}

export const log = {
  debug: (module: string, message: string): void => emit('debug', module, message),
  info: (module: string, message: string): void => emit('info', module, message),
  warn: (module: string, message: string): void => emit('warn', module, message),
  error: (module: string, message: string, error?: unknown): void => emit('error', module,
    error instanceof Error ? `${message}: ${error.stack ?? error.message}` : message),
  addSink(sink: Sink): () => void {
    sinks.add(sink);
    return () => { sinks.delete(sink); };
  },
  setConsole(enabled: boolean): void { consoleEnabled = enabled; },
  setDebug(enabled: boolean): void { debugEnabled = enabled; },
};
