import type { DefsFile, StatTypesFile } from '../protocol/PacketFactory.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';

export type CloseSide = 'game' | 'server' | 'fault' | 'proxy';

export const VERDICT_DEADLINE_MS = 250;
export const MODULE_FAILURE_REPORT_MS = 5000;
export const MODULE_HEALTH_QUIET_MS = 30_000;

/** Incremental failure report. Timestamps use the process-wide performance.now() clock. */
export interface ModuleHealthEvent {
  type: 'moduleHealth';
  id: string;
  moduleId: string;
  hook: keyof import('./modules.ts').WorkerSessionModule;
  /** Failures since the preceding report, not a cumulative total. */
  failures: number;
  /** First failure in this report. */
  since: number;
  lastError: string;
  /** Most recent failure, rather than report delivery time. */
  at: number;
}

export type ModuleConfigEvent =
  | { type: 'moduleConfig'; moduleId: string; ok: true }
  | { type: 'moduleConfig'; moduleId: string; ok: false; error: string };

export const DEFAULTS = Object.freeze({
  targetTimeoutMs: 2000,
  helloTimeoutMs: 3000,
  maxPendingBytes: 16 * 1024 * 1024,
});

export interface WorkerInit {
  host: string;
  port: number;
  definitions: DefsFile;
  stats: StatTypesFile;
  fallbackDestination: Destination | null;
  targetTimeoutMs: number;
  helloTimeoutMs: number;
  maxPendingBytes: number;
  interest: InterestSpec;
  moduleConfig: Record<string, unknown>;
}

export type WorkerEvent =
  | ModuleHealthEvent
  | ModuleConfigEvent
  | { type: 'listening'; port: number }
  | { type: 'opened'; id: string; remotePort: number }
  | { type: 'routed'; id: string; host: string; port: number; restored: boolean }
  | { type: 'connected'; id: string; generation: number }
  | { type: 'packet'; id: string; sequence: number; generation: number; fromClient: boolean; observeOnly: boolean; data: Uint8Array }
  | { type: 'closed'; id: string; by: CloseSide }
  | { type: 'diagnostic'; id?: string; message: string }
  | { type: 'note'; id: string; message: string }
  | { type: 'fault'; id?: string; message: string }
  | { type: 'module'; moduleId: string; id?: string; message: unknown };

export type WorkerCommand =
  | { type: 'target'; id: string; destination: Destination | null }
  | { type: 'interest'; interest: InterestSpec }
  | { type: 'forward'; id: string; sequence: number; generation: number; data: Uint8Array | null }
  | { type: 'inject'; id: string; data: Uint8Array; toClient: boolean }
  /** Without `id`: module-wide configuration. With `id`: a command for that session's module instance. */
  | { type: 'module'; moduleId: string; id?: string; message: unknown }
  | { type: 'modules'; configs: Record<string, unknown> }
  | { type: 'close'; id: string }
  | { type: 'stop' };
