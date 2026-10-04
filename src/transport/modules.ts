import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import type { SessionAutomation } from './automation.ts';

/** How a frame reached the writer. `priority` frames bypass ordering and are never queued before the server connects. */
export type WriteKind = 'normal' | 'injected' | 'priority';

export interface TransportState {
  available: boolean;
  backlog: boolean;
  /** Upstream socket has unflushed output (writableNeedDrain or writableLength > 0). */
  upstreamBackpressure: boolean;
}

/** A packet waiting for a main-thread verdict. */
export interface HeldPacket {
  readonly observationId: number;
  readonly name: string;
  readonly fromClient: boolean;
  /** When the frame was accepted, on the same clock as `WorkerSessionContext.now()`. */
  readonly receivedAt: number;
}

export interface WorkerSessionContext {
  readonly sessionId: string;
  readonly factory: PacketFactory;
  readonly automation: SessionAutomation;
  /** Upstream connection generation; increases on every (re)connect of this game socket. */
  generation(): number;
  /** Milliseconds on the worker's monotonic clock (performance.now()). Every timestamp in this file — hook `now` arguments and `HeldPacket.receivedAt` — uses this same clock. */
  now(): number;
  /** Encrypt and write now, ahead of anything awaiting a main-thread verdict. False if the socket can't take it.
   * `origin` (a module id) is reported back to `written` so a module can recognise its own writes. */
  writePriority(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void, origin?: string): boolean;
  /** Whether the upstream is writable, and whether any traffic is still queued or in flight. */
  transport(): TransportState;
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
   *
   * `observationId` is unique for the session's lifetime, across upstream generations. After `observe`,
   * a frame reaches at most one of these outcomes:
   * - `written`: only for a client→server frame that is also named in the module's `written` list and is
   *   accepted by the socket writer. Written frames not named in `written` get no callback.
   * - `writtenServer`: for an accepted server→client frame named in `writtenServer`, with its final
   *   routed bytes. This hook does not carry an observation id.
   * - `dropped`: a plugin verdict dropped it, a module's `allowWrite` vetoed it, the socket couldn't take it,
   *   a plugin replaced it with a different packet or with malformed bytes,
   *   or it was a server→client frame whose upstream generation ended. Client→server frames survive an
   *   upstream generation change; they belong to the game socket.
   * Frames still pending when the session closes get neither. `close()` is the signal to release every
   * outstanding observation. (Collision HP must not charge a withheld report twice; this lifecycle is how it tells.)
   */
  observe?(packet: Packet, fromClient: boolean, now: number, observationId: number): void;
  /** Last check before output RC4 for every write: released, injected, queued and priority. False drops it. */
  allowWrite?(name: string, toClient: boolean, kind: WriteKind, decode: () => Packet): boolean;
  /** A client→server packet named in `written` was accepted by the socket writer. `observationId` is null for injected/priority frames. */
  written?(packet: Packet, kind: WriteKind, now: number, observationId: number | null, origin: string | null): void;
  /** A server→client packet named in the module's `writtenServer` list was accepted by the game-socket writer, after routing rewrite (the packet as written). */
  writtenServer?(packet: Packet, kind: WriteKind, now: number): void;
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
  readonly writtenServer?: readonly string[];
  /** Module-wide configuration from the main thread (delivered at startup and on change).
   * Validate first, then apply. Throwing rejects the whole configuration and leaves the previous one in force. */
  configure?(config: unknown): void;
  createSession(context: WorkerSessionContext): WorkerSessionModule;
}
