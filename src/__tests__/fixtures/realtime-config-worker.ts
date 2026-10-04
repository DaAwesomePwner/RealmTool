import { parentPort } from 'node:worker_threads';
import { WORKER_MODULES } from '../../transport/workerModules.ts';
import type { WorkerEvent } from '../../transport/messages.ts';

// Observe actual startup configuration calls without replacing either real module.
const configured: { id: string; config: unknown }[] = [];
for (const module of WORKER_MODULES) {
  const configure = module.configure!.bind(module);
  module.configure = config => {
    configure(config);
    configured.push({ id: module.id, config });
  };
}
await import('../../transport/worker.ts');
parentPort!.postMessage({ type: 'module', moduleId: 'startup-snapshot', message: configured } satisfies WorkerEvent);
