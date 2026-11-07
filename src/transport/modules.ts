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

/** A frame accepted from a socket and not yet written or dropped (the stalled-delivery view). */
export interface PendingDelivery {
  readonly observationId: number;
  readonly name: string;
  readonly fromClient: boolean;
  /** Same clock as WorkerSessionContext.now(). */
  readonly receivedAt: number;
  readonly generation: number;
  /** awaiting: a main-thread verdict is outstanding. ready: passed (or needed no verdict) but blocked behind earlier frames. */
  readonly state: 'awaiting' | 'ready';
}

/** A client→server frame named in the module's `prepare` list, about to be encrypted and written. */
export interface PreparedWrite {
  /** Session-unique; exactly one writeOutcome follows for each module that received prepareWrite. */
  readonly token: number;
  /** The final frame as it will be written (after plugin replacement). */
  readonly packet: Packet;
  readonly kind: WriteKind;
  readonly now: number;
  /** The original observation when this is that frame's same-named release; null for injected, priority or renamed frames. */
  readonly observationId: number | null;
  readonly origin: string | null;
}

export interface WorkerSessionContext {
  readonly sessionId: string;
  readonly factory: PacketFactory;
  readonly automation: SessionAutomation;
  /** Upstream connection generation; increases on every (re)connect of this game socket. */
  generation(): number;
  /** Milliseconds on the worker's monotonic clock (performance.now()). Every timestamp in this file — hook `now` arguments and `HeldPacket.receivedAt` — uses this same clock. */
  now(): number;
  /** Timestamp immediately after the most recent socket write returned. */
  lastWriteAcceptedAt?(): number;
  /** Encrypt and write now, ahead of anything awaiting a main-thread verdict. False if the socket can't take it.
   * `origin` (a module id) is reported back to `written` so a module can recognise its own writes. */
  writePriority(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void, origin?: string): boolean;
  /** Whether the upstream is writable, and whether any traffic is still queued or in flight. */
  transport(): TransportState;
  /** Packets awaiting a main-thread verdict, oldest first (Collision HP's stalled-delivery fail-safe). */
  held(): readonly HeldPacket[];
  /** Pending delivery, oldest first; excludes verdict-dropped frames at once and other generations' server frames. */
  pendingDelivery(): readonly PendingDelivery[];
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
   *   routed bytes and the original observation id for a same-named release.
   * - `dropped`: the post-observe `suppressEntry` guard swallowed it, a plugin verdict dropped it,
   *   a module's `allowWrite` vetoed it, the socket couldn't take it,
   *   a plugin replaced it with a different packet or with malformed bytes,
   *   or it was a server→client frame whose upstream generation ended. Client→server frames survive an
   *   upstream generation change; they belong to the game socket.
   * Frames still pending when the session closes get neither. `close()` is the signal to release every
   * outstanding observation. (Collision HP must not charge a withheld report twice; this lifecycle is how it tells.)
   */
  /** receivedAt is first-byte socket data delivery, before framing and decoding. */
  observe?(packet: Packet, fromClient: boolean, now: number, observationId: number, receivedAt?: number): void;
  /** Before module vetoes and output RC4. May write priority frames reentrantly (e.g. ESCAPE). */
  prepareWrite?(write: PreparedWrite): void;
  /** accepted = the socket writer took the frame; false = vetoed, malformed, socket gone, or session closed. */
  writeOutcome?(token: number, accepted: boolean, now: number): void;
  /** Last check before output RC4 for every write: released, injected, queued and priority. False drops it. */
  allowWrite?(name: string, toClient: boolean, kind: WriteKind, decode: () => Packet): boolean;
  /** A client→server packet named in `written` was accepted by the socket writer. `observationId` is null for injected/priority frames. */
  written?(packet: Packet, kind: WriteKind, now: number, observationId: number | null, origin: string | null): void;
  /** A server→client packet named in the module's `writtenServer` list was accepted by the game-socket writer, after routing rewrite (the packet as written). `observationId` is null for injected/priority or renamed frames. */
  writtenServer?(packet: Packet, kind: WriteKind, now: number, observationId: number | null): void;
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
  /** Client→server packets to prepare at the final writer, before vetoes and encryption. */
  readonly prepare?: readonly string[];
  readonly written?: readonly string[];
  readonly writtenServer?: readonly string[];
  /** Module-wide configuration from the main thread (delivered at startup and on change).
   * Validate first, then apply. Throwing rejects the whole configuration and leaves the previous one in force. */
  configure?(config: unknown): void;
  createSession(context: WorkerSessionContext): WorkerSessionModule;
}
