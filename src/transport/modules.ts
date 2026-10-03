import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';

/** How a frame reached the writer. `priority` frames bypass ordering and are never queued before the server connects. */
export type WriteKind = 'normal' | 'injected' | 'priority';

/** A packet waiting for a main-thread verdict. */
export interface HeldPacket {
  readonly observationId: number;
  readonly name: string;
  readonly fromClient: boolean;
  readonly receivedAt: number;
}

export interface WorkerSessionContext {
  readonly sessionId: string;
  readonly factory: PacketFactory;
  /** Upstream connection generation; increases on every (re)connect of this game socket. */
  generation(): number;
  now(): number;
  /** Encrypt and write now, ahead of anything awaiting a main-thread verdict. False if the socket can't take it. */
  writePriority(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void): boolean;
  /** Whether the upstream is writable, and whether any traffic is still queued or in flight. */
  transport(): { available: boolean; backlog: boolean };
  /** Packets awaiting a main-thread verdict, oldest first (Collision HP's stalled-delivery fail-safe). */
  held(): readonly HeldPacket[];
  /** Message this module's main-thread half (a ProxyHost 'module' event). */
  post(message: unknown): void;
}

/**
 * Per-session hooks for realtime plugin halves that run beside the sockets.
 * Hooks must not throw. A thrown error is reported as a diagnostic and treated
 * as "no opinion" (traffic passes).
 */
export interface WorkerSessionModule {
  /** After decryption, before anything else. True swallows the frame (its input RC4 is already consumed). */
  suppressEntry?(name: string, fromClient: boolean): boolean;
  /**
   * Original packets named in the module's `observe` lists, before the main thread sees them.
   * `observationId` follows the frame to `written` or `dropped`, so a module can tell a delivered
   * hit report from one a plugin withheld (Collision HP must never charge a withheld report twice).
   */
  observe?(packet: Packet, fromClient: boolean, now: number, observationId: number): void;
  /** Last check before output RC4 for every write: released, injected, queued and priority. False drops it. */
  allowWrite?(name: string, toClient: boolean, kind: WriteKind, decode: () => Packet): boolean;
  /** A client→server packet named in `written` was accepted by the socket writer. `observationId` is null for injected/priority frames. */
  written?(packet: Packet, kind: WriteKind, now: number, observationId: number | null): void;
  /** An observed frame will never reach its socket: a plugin dropped it, a module vetoed it, or its upstream generation ended. */
  dropped?(observationId: number, name: string, fromClient: boolean, now: number): void;
  connectionChanged?(generation: number): void;
  tick?(now: number): void;
  command?(message: unknown): void;
  close?(): void;
}

export interface WorkerModule {
  readonly id: string;
  /** Lower runs first. Auto Nexus = 0, Auto Drink = 10. */
  readonly priority: number;
  readonly observe?: { readonly client?: readonly string[]; readonly server?: readonly string[] };
  readonly written?: readonly string[];
  /** Module-wide configuration from the main thread (delivered at startup and on change). */
  configure?(config: unknown): void;
  createSession(context: WorkerSessionContext): WorkerSessionModule;
}
