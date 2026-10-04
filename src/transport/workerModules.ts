import type { WorkerModule } from './modules.ts';
import { autoNexusModule } from '../../plugins/auto-nexus/worker.ts';

/** Realtime plugin halves bundled into the network worker. Phase 3 adds Auto Nexus and Auto Drink. */
export const WORKER_MODULES: readonly WorkerModule[] = [autoNexusModule];
