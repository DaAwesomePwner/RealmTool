import { parentPort, workerData } from 'node:worker_threads';
import { WORKER_MODULES } from '../../workerModules.ts';
import type { WorkerCommand, WorkerEvent, WorkerInit } from '../../messages.ts';
import type { WorkerModule } from '../../modules.ts';

// Populate only this fixture worker's registry, then run the production entry point.
const configs: Record<string, unknown> = { a: 0, b: 0 };
const order: string[] = [];
const post = (message: unknown): void => parentPort!.postMessage({ type: 'module', moduleId: 'fixture', message } satisfies WorkerEvent);
const modules: WorkerModule[] = ['a', 'b'].map((id, priority) => ({
  id, priority, observe: { client: ['ESCAPE'] },
  configure: config => {
    if (typeof config !== 'number') throw new Error('expected a number');
    configs[id] = config;
    order.push(id);
    if (id === 'b') post({ configured: { ...configs }, order: [...order] });
  },
  createSession: context => ({
    observe: () => { if (id === 'a') context.post({ observed: { ...configs } }); },
  }),
}));
(WORKER_MODULES as WorkerModule[]).push(...modules);
post({ init: (workerData as WorkerInit).moduleConfig });
parentPort!.on('message', (command: WorkerCommand) => {
  if (command.type === 'modules' || (command.type === 'module' && command.id === undefined)) post({ command });
});
await import('../../worker.ts');
