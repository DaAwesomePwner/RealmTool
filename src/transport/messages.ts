import type { DefsFile, StatTypesFile } from '../protocol/PacketFactory.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';

export type CloseSide = 'game' | 'server' | 'fault' | 'proxy';

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
