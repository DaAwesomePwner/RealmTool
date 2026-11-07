import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Serial async writes, bounded by the file cap; no partial JSONL records. */
export class CaptureWriter {
  private chain = Promise.resolve();
  private handle?: FileHandle;
  private bytes = 0;
  private ended = false;
  private failed = false;
  readonly path: string;
  readonly limit: number;
  private log: (s: string) => void;
  private stop: () => void;
  constructor(path: string, limit: number, log: (s: string) => void, stop: () => void) {
    this.path = path; this.limit = limit; this.log = log; this.stop = stop;
  }
  write(record: unknown): void {
    if (this.ended) return;
    const line = JSON.stringify(record) + '\n';
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.limit) {
      this.log(`Capture size cap reached (${this.limit} bytes); stopping`);
      void this.close(); this.stop(); return;
    }
    this.bytes += size;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      if (!this.handle) {
        await mkdir(dirname(this.path), { recursive: true });
        this.handle = await open(this.path, 'wx');
        this.log(`Capture started: ${this.path}`);
      }
      await this.handle.writeFile(line);
    }).catch((error: NodeJS.ErrnoException) => {
      this.failed = true; this.log(`Capture write failed (${error.code ?? 'unknown'}); stopping`); this.stop(); void this.close();
    });
  }
  close(): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.chain = this.chain.then(async () => {
        if (this.handle) {
          try { await this.handle.sync(); } finally { await this.handle.close(); }
          this.log(`Capture stopped: ${this.path}`);
        }
      }).catch((error: NodeJS.ErrnoException) => { this.log(`Capture close failed (${error.code ?? 'unknown'}): ${this.path}`); });
    }
    return this.chain;
  }
}
