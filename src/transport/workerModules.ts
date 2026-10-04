import type { WorkerModule } from './modules.ts';
import { autoNexusModule } from '../../plugins/auto-nexus/worker.ts';
import { autoDrinkModule } from '../../plugins/auto-drink/worker.ts';

/** Realtime plugin halves bundled into the network worker, in priority order (Auto Nexus 0, Auto Drink 10). */
export const WORKER_MODULES: readonly WorkerModule[] = [autoNexusModule, autoDrinkModule];
