import { WORKER_MODULES } from '../../workerModules.ts';
import type { WorkerModule } from '../../modules.ts';

// Empty only this fixture worker's registry, then use the production entry point.
(WORKER_MODULES as WorkerModule[]).length = 0;
await import('../../worker.ts');
