import { Worker, parentPort } from 'node:worker_threads';
import type { Readable } from 'node:stream';
import type { generateCatalogs } from './generate.ts';

type Result = ReturnType<typeof generateCatalogs>;
export interface CatalogJob { kind: 'catalog-refresh'; args: string[]; alive: SharedArrayBuffer }

/** The extraction thread shares a cancellation flag with the child process's stdin monitor. */
export async function runCatalogJob(job: CatalogJob): Promise<void> {
  try {
    const alive = new Int32Array(job.alive);
    const { generateCatalogs } = await import('./generate.ts');
    const assertParent = () => { if (Atomics.load(alive, 0) !== 1) throw new Error('Refresh parent disconnected'); };
    assertParent();
    const result = generateCatalogs(job.args, { writeSource: true, beforePublish: assertParent });
    parentPort!.postMessage({ result });
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
}

/** Keep the child main thread responsive to EOF throughout synchronous asset extraction. */
export function parentedRefresh(entry: URL, args: string[], input: Readable): Promise<Result> {
  return new Promise((resolve, reject) => {
    const alive = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(alive, 0, 1);
    let worker: Worker | undefined;
    const cleanup = () => {
      input.off('end', gone); input.off('close', gone); input.off('error', gone); input.pause();
    };
    const gone = () => {
      Atomics.store(alive, 0, 0);
      cleanup();
      void worker?.terminate();
      reject(new Error('Refresh parent disconnected'));
    };
    input.once('end', gone); input.once('close', gone); input.once('error', gone);
    if (input.readableEnded || input.destroyed) { gone(); return; }
    input.resume();
    try { worker = new Worker(entry, { workerData: { kind: 'catalog-refresh', args, alive: alive.buffer } satisfies CatalogJob }); }
    catch (error) { cleanup(); reject(error); return; }
    worker.once('message', (message: { result?: Result; error?: string }) => {
      cleanup();
      if (Atomics.load(alive, 0) !== 1) reject(new Error('Refresh parent disconnected'));
      else if (message.result) resolve(message.result);
      else reject(new Error(message.error ?? 'Game data extraction failed'));
    });
    worker.once('error', error => { cleanup(); reject(error); });
    worker.once('exit', code => { cleanup(); reject(new Error(`Game data extraction exited without a result (code ${code})`)); });
  });
}
