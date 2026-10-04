import type { WorkerModule } from './modules.ts';
import { autoDrinkModule } from '../../plugins/auto-drink/worker.ts';

/** Realtime plugin halves bundled into the network worker. Phase 3 adds Auto Nexus and Auto Drink. */
export const WORKER_MODULES: readonly WorkerModule[] = [autoDrinkModule];
