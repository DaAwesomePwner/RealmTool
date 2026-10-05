import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log, type LogRecord } from './log.ts';

export interface StoredLog extends LogRecord { seq: number }

export class LogRing {
  private readonly capacity: number;
  private readonly records: StoredLog[] = [];
  private readonly subscribers = new Set<(record: StoredLog) => void>();
  private sequence = 0;

  constructor(capacity?: number) {
    this.capacity = capacity ?? 1000;
    positiveInteger(this.capacity, 'capacity');
  }

  push(record: LogRecord): StoredLog {
    const stored = Object.freeze({ ...record, seq: ++this.sequence });
    this.records[(stored.seq - 1) % this.capacity] = stored;
    for (const subscriber of this.subscribers) {
      try { subscriber(stored); }
      catch {
        this.subscribers.delete(subscriber);
        console.warn('[log] Removed a failing log subscriber.');
      }
    }
    return stored;
  }

  /** Returns records strictly after seq; next is the latest assigned sequence. */
  since(seq: number): { records: StoredLog[]; next: number; dropped: boolean } {
    const oldest = this.sequence - this.records.length + 1;
    const records: StoredLog[] = [];
    for (let current = Math.max(oldest, Math.floor(seq) + 1); current <= this.sequence; current++) {
      records.push(this.records[(current - 1) % this.capacity]);
    }
    return { records, next: this.sequence, dropped: seq < oldest - 1 };
  }

  subscribe(fn: (record: StoredLog) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function fileSize(path: string): number {
  try { return statSync(path).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Rotating UTF-8 file sink: realmtool.log, .1, .2 (P6). Returns detach. */
export function attachFileLog(dir: string, options?: { maxBytes?: number; files?: number }): () => void {
  const maxBytes = options?.maxBytes ?? 1024 * 1024;
  const files = options?.files ?? 3;
  positiveInteger(maxBytes, 'maxBytes');
  positiveInteger(files, 'files');
  const path = join(dir, 'realmtool.log');
  let bytes: number;
  try {
    mkdirSync(dir, { recursive: true });
    bytes = fileSize(path);
  } catch {
    console.warn('[log] Could not attach the file log sink.');
    return () => {};
  }

  // Logging isolates write/rotation failures and detaches this sink on its first throw.
  return log.addSink(record => {
    const singleLine = (text: string): string => text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    const line = `${new Date(record.at).toISOString()} ${record.level.toUpperCase()} [${singleLine(record.module)}] ${singleLine(record.message)}\n`;
    const length = Buffer.byteLength(line, 'utf8');
    // A single oversized record stays intact; the next write rotates it out.
    if (bytes > 0 && bytes + length > maxBytes) {
      rmSync(files === 1 ? path : `${path}.${files - 1}`, { force: true });
      for (let index = files - 2; index >= 0; index--) {
        const source = index === 0 ? path : `${path}.${index}`;
        try { renameSync(source, `${path}.${index + 1}`); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      bytes = 0;
    }
    appendFileSync(path, line, 'utf8');
    bytes += length;
  });
}
