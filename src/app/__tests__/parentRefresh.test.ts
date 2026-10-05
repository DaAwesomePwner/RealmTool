import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { parentedRefresh, type CatalogJob } from '../../catalogs/parentRefresh.ts';
vi.mock('node:worker_threads', () => ({ Worker: vi.fn(), parentPort: null }));
afterEach(() => vi.resetAllMocks());
it.each(['end', 'close', 'error'])('parent %s disarms publication and terminates a still-busy extraction thread', async event => {
  const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 1) });
  vi.mocked(Worker).mockImplementation(function () { return worker as unknown as Worker; });
  const input = new PassThrough();
  const pending = parentedRefresh(new URL('file:///fixture/cli.ts'), [], input);
  const result = pending.catch(error => error);
  const job = vi.mocked(Worker).mock.calls[0][1]!.workerData as CatalogJob;
  expect(Atomics.load(new Int32Array(job.alive), 0)).toBe(1);
  input.emit(event, ...(event === 'error' ? [new Error('fixture broken pipe')] : []));
  expect(Atomics.load(new Int32Array(job.alive), 0)).toBe(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(await result).toMatchObject({ message: 'Refresh parent disconnected' });
  // A queued success cannot revive a cancelled run.
  worker.emit('message', { result: { gameBuild: 'late' } }); worker.emit('exit', 1);
  input.destroy();
});
