import net from 'node:net';
import { ModuleFailures, type ModuleDiagnosticLimiter } from './workerGuard.ts';
import { RC4_KEYS } from '../protocol/constants.ts';
import { FrameDecoder, isWholeFrame } from '../protocol/frames.ts';
import { RC4Cipher } from '../protocol/RC4Cipher.ts';
import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import type { Destination, Router } from '../routing/router.ts';
import { describeHello, describeReconnect } from '../routing/describeRoute.ts';
import { isCriticalPacket, type Interest } from './interest.ts';
import { VERDICT_DEADLINE_MS, type CloseSide, type WorkerEvent } from './messages.ts';
import type { HeldPacket, PendingDelivery, TransportState, WorkerModule, WorkerSessionContext, WorkerSessionModule, WriteKind } from './modules.ts';
import { SessionAutomation } from './automation.ts';
import { SessionTrace } from './trace.ts';

export interface SessionEnv {
  factory: PacketFactory;
  router: Router;
  interest: Interest;
  modules: readonly WorkerModule[];
  /** Worker-wide diagnostic budget shared across all sessions. */
  moduleDiagnostics?: ModuleDiagnosticLimiter;
  post(event: WorkerEvent): void;
  now(): number;
  fallbackDestination: Destination | null;
  /** How long a new connection waits for the main thread's helper-target answer. */
  targetTimeoutMs: number;
  /** How long the server may stay silent after HELLO before a retry. */
  helloTimeoutMs: number;
  /** Limit for verdicts, pre-connect traffic, and each socket's output queue before faulting. */
  maxPendingBytes: number;
  /** Maximum main-thread verdict wait; defaults to VERDICT_DEADLINE_MS. */
  verdictDeadlineMs?: number;
  onClosed(id: string): void;
}

const MAX_HELLO_RETRIES = 3;

interface Observation {
  id: number;
  name: string;
  fromClient: boolean;
}

interface Pending {
  observation: Observation;
  receivedAt: number;
  generation: number;
  bytes: number;
  original: Buffer;
  deadline: number;
  /** undefined = awaiting a verdict; null = drop; Buffer = write these bytes. */
  result?: Buffer | null;
}

interface ActiveModule {
  id: string;
  client: Set<string>;
  server: Set<string>;
  prepare: Set<string>;
  written: Set<string>;
  writtenServer: Set<string>;
  hooks: WorkerSessionModule;
}

interface Queued {
  data: Buffer;
  kind: WriteKind;
  observation: Observation | null;
}

/**
 * One game TCP connection and its upstream. Owns both ciphers per direction,
 * per-direction ordering of main-thread verdicts, HELLO routing and the final
 * writer. Transfers between servers arrive as new Sessions (the game reconnects).
 */
export class Session {
  readonly id: string;
  private readonly client: net.Socket;
  private readonly env: SessionEnv;
  private readonly modules: ActiveModule[];
  private readonly automation = new SessionAutomation();
  private readonly trace: SessionTrace;
  private readonly failures: ModuleFailures;
  private server: net.Socket | null = null;
  private serverReady = false;
  private serverResponded = false;
  private generation = 0;
  private destination: Destination | null = null;
  private target: Destination | null = null;
  private targetResolved = false;
  private targetTimer: ReturnType<typeof setTimeout> | null = null;
  private sawHello = false;
  private heldHello: Buffer | null = null;
  private helloForRetry: Buffer | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloAttempt = 0;
  private helloSentAt = 0;
  private clientFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.clientToServer));
  private serverFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
  private toClientCipher = new RC4Cipher(RC4_KEYS.serverToClient);
  private toServerCipher = new RC4Cipher(RC4_KEYS.clientToServer);
  private pending = new Map<number, Pending>();
  private clientOrder: number[] = [];
  private serverOrder: number[] = [];
  private sequence = 0;
  private observations = 0;
  private writeTokens = 0;
  private pendingBytes = 0;
  private expiredVerdicts = 0;
  private expiredCommandDrops = 0;
  private overriddenVerdicts = 0;
  private lastVerdictDiagnostic = -Infinity;
  private beforeConnect: Queued[] = [];
  private beforeConnectBytes = 0;
  private closed = false;

  constructor(id: string, client: net.Socket, env: SessionEnv) {
    this.id = id;
    this.client = client;
    this.env = env;
    this.failures = new ModuleFailures(id, event => env.post(event), env.moduleDiagnostics);
    this.trace = new SessionTrace(env.now());
    this.modules = [...env.modules].sort((a, b) => a.priority - b.priority).map(module => ({
      id: module.id,
      client: new Set(module.observe?.client ?? []),
      server: new Set(module.observe?.server ?? []),
      prepare: new Set(module.prepare ?? []),
      written: new Set(module.written ?? []),
      writtenServer: new Set(module.writtenServer ?? []),
      hooks: module.createSession(this.context(module.id)),
    }));
    client.setNoDelay(true);
    client.on('data', data => this.receive(data, true, this.clientFrames));
    client.on('error', error => this.fault(new Error(`Game connection error (${error.message})`)));
    client.on('close', () => this.close('game'));
    this.targetTimer = setTimeout(() => this.setTarget(null), env.targetTimeoutMs);
    env.post({ type: 'opened', id, remotePort: client.remotePort ?? 0 });
  }

  /** The main thread's answer: where the helper says this game socket was going (null = unknown). */
  setTarget(destination: Destination | null): void {
    if (this.closed || this.targetResolved) return;
    this.targetResolved = true;
    this.target = destination;
    if (this.targetTimer) { clearTimeout(this.targetTimer); this.targetTimer = null; }
    if (this.heldHello) this.routeHello(this.heldHello);
  }

  forward(sequence: number, generation: number, data: Buffer | null): void {
    const pending = this.pending.get(sequence);
    if (!pending || pending.generation !== generation || pending.result !== undefined) return;
    if (this.env.now() >= pending.deadline) this.expireVerdicts(this.env.now());
    if (pending.result !== undefined) return;
    pending.result = data;
    this.flush(pending.observation.fromClient);
  }

  inject(data: Buffer, toClient: boolean): boolean {
    return this.write(data, toClient, 'injected');
  }

  command(moduleId: string, message: unknown): void {
    const module = this.modules.find(m => m.id === moduleId);
    if (module) this.call(module, 'command', () => module.hooks.command?.(message), undefined);
  }

  tick(now: number): void {
    if (this.closed) return;
    for (const module of this.modules) this.call(module, 'tick', () => module.hooks.tick?.(now), undefined);
    if (!this.closed) this.expireVerdicts(now);
    this.failures.flush(now);
  }

  close(by: CloseSide = 'proxy'): void {
    if (this.closed) return;
    this.closed = true;
    this.env.post({ type: 'note', id: this.id, message: this.summary() });
    if (this.targetTimer) clearTimeout(this.targetTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.heldHello = null;
    this.helloForRetry = null;
    for (const module of this.modules) this.call(module, 'close', () => module.hooks.close?.(by), undefined);
    this.failures.flush(this.env.now(), true);
    // A fault is an abort, so the game gets the reset it would see without us. While it loads
    // a map it ignores a clean FIN and sits on the loading screen with the socket in CLOSE_WAIT.
    if (by === 'fault' && !this.client.destroyed) this.client.resetAndDestroy();
    else this.client.destroy();
    this.server?.destroy();
    this.pending.clear();
    this.beforeConnect = [];
    this.env.post({ type: 'closed', id: this.id, by });
    this.env.onClosed(this.id);
  }

  private context(moduleId: string): WorkerSessionContext {
    return {
      sessionId: this.id,
      factory: this.env.factory,
      automation: this.automation,
      generation: () => this.generation,
      now: () => this.env.now(),
      lastWriteAcceptedAt: () => this.lastWriteAcceptedAt,
      writePriority: (data, toClient, done, origin) => this.write(data, toClient, 'priority', done, null, origin),
      transport: () => this.transport(),
      held: () => this.held(),
      pendingDelivery: () => this.pendingDelivery(),
      post: message => this.env.post({ type: 'module', moduleId, id: this.id, message }),
    };
  }

  private held(): HeldPacket[] {
    const out: HeldPacket[] = [];
    for (const pending of this.pending.values()) {
      if (pending.result === undefined) {
        out.push({ observationId: pending.observation.id, name: pending.observation.name, fromClient: pending.observation.fromClient, receivedAt: pending.receivedAt });
      }
    }
    return out;
  }

  private summary(): string {
    const now = this.env.now();
    const held = [];
    for (const pending of this.pending.values()) {
      if (pending.result !== undefined) continue;
      const { name, fromClient } = pending.observation;
      held.push({ name, fromClient, ageMs: now - pending.receivedAt });
    }
    const summary = this.trace.summary(now, held, { game: this.client.writableLength, server: this.server?.writableLength ?? 0 });
    return this.expiredVerdicts || this.overriddenVerdicts || this.expiredCommandDrops
      ? `${summary}; unreported verdict releases: ${this.expiredVerdicts} expired, ${this.overriddenVerdicts} overridden, ${this.expiredCommandDrops} expired command drops`
      : summary;
  }

  private notifyDropped(observation: Observation): void {
    this.trace.dropped(observation.fromClient);
    const now = this.env.now();
    for (const module of this.modules) {
      if ((observation.fromClient ? module.client : module.server).has(observation.name)) {
        this.call(module, 'dropped', () => module.hooks.dropped?.(observation.id, observation.name, observation.fromClient, now), undefined);
      }
    }
  }

  private pendingDelivery(): PendingDelivery[] {
    const out: PendingDelivery[] = [];
    for (const pending of this.pending.values()) {
      const { observation, receivedAt, generation, result } = pending;
      if (result === null || (!observation.fromClient && generation !== this.generation)) continue;
      out.push({ observationId: observation.id, name: observation.name, fromClient: observation.fromClient,
        receivedAt, generation, state: result === undefined ? 'awaiting' : 'ready' });
    }
    return out;
  }

  private transport(): TransportState {
    const server = this.server;
    const available = !this.closed && this.serverReady && !!server && !server.destroyed && server.writable;
    const backlog = this.pending.size > 0 || this.beforeConnect.length > 0
      || this.clientFrames.incomplete || this.serverFrames.incomplete
      || !!server?.writableNeedDrain || (server?.writableLength ?? 0) > 0 || (server?.readableLength ?? 0) > 0
      || this.client.readableLength > 0 || this.client.writableNeedDrain || this.client.writableLength > 0;
    const upstreamBackpressure = !!server?.writableNeedDrain || (server?.writableLength ?? 0) > 0;
    return { available, backlog, upstreamBackpressure };
  }

  private call<T>(module: ActiveModule, hook: keyof WorkerSessionModule, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      this.failures.record(module.id, hook, error, this.env.now());
      return fallback;
    }
  }

  private fault(error: Error): void {
    if (this.closed) return;
    this.env.post({ type: 'fault', id: this.id, message: error.message });
    this.close('fault');
  }

  private clientReceivedAt = 0;
  private serverReceivedAt = 0;

  private receive(data: Buffer, fromClient: boolean, frames: FrameDecoder, receivedAt = this.env.now()): void {
    const key = fromClient ? 'clientReceivedAt' : 'serverReceivedAt';
    if (!frames.incomplete) this[key] = receivedAt;
    try {
      frames.feed(data, frame => {
        const start = this[key];
        this[key] = receivedAt;
        this.accept(frame, fromClient, start);
      });
    } catch (error) {
      this.fault(error as Error);
    }
  }

  private accept(frame: Buffer, fromClient: boolean, receivedAt: number): void {
    if (this.closed) return;
    const direction = fromClient ? 'client' : 'server';
    const name = this.env.factory.getPacketName(frame[4], direction);
    this.trace.received(fromClient, name, frame.length, this.env.now());
    if (fromClient && name === 'ESCAPE') this.env.post({ type: 'note', id: this.id, message: 'Game sent ESCAPE (Nexus request)' });
    for (const module of this.modules) {
      if (this.call(module, 'suppressEntry', () => module.hooks.suppressEntry?.(name, fromClient) ?? false, false)) return;
    }
    if (fromClient && !this.sawHello) {
      if (name !== 'HELLO') { this.fault(new Error(`Expected HELLO as the first game packet, got ${name}`)); return; }
      this.sawHello = true;
      if (this.targetResolved) this.routeHello(frame);
      else this.heldHello = frame;
      return;
    }
    let packet: Packet | null = null;
    const decode = (): Packet => (packet ??= this.env.factory.createFromBytes(frame, direction));
    const now = this.env.now();
    const observationId = ++this.observations;
    for (const module of this.modules) {
      if ((fromClient ? module.client : module.server).has(name)) {
        this.call(module, 'observe', () => module.hooks.observe?.(decode(), fromClient, now, observationId, receivedAt), undefined);
      }
      if (this.closed) return;
    }
    for (const module of this.modules) {
      if (this.call(module, 'suppressEntry', () => module.hooks.suppressEntry?.(name, fromClient) ?? false, false)) {
        this.notifyDropped({ id: observationId, name, fromClient });
        return;
      }
      if (this.closed) return;
    }
    if (isCriticalPacket(name, fromClient)) {
      for (const pending of this.pending.values()) {
        if (pending.observation.fromClient === fromClient && pending.result === undefined) {
          pending.result = pending.original;
          ++this.overriddenVerdicts;
        }
      }
      this.flush(fromClient);
      if (this.closed) return;
      this.reportVerdictReleases(now);
    }
    const kind = this.env.interest.classify(name, fromClient);
    const sequence = ++this.sequence;
    this.pending.set(sequence, { observation: { id: observationId, name, fromClient }, receivedAt: now, generation: this.generation,
      original: frame, deadline: now + (this.env.verdictDeadlineMs ?? VERDICT_DEADLINE_MS),
      bytes: frame.length, result: kind === 'verdict' ? undefined : frame });
    (fromClient ? this.clientOrder : this.serverOrder).push(sequence);
    this.pendingBytes += frame.length;
    if (this.pendingBytes > this.env.maxPendingBytes) {
      this.fault(new Error('Packets awaiting a plugin verdict exceeded the backlog limit'));
      return;
    }
    if (kind !== 'none') {
      this.env.post({ type: 'packet', id: this.id, sequence, generation: this.generation, fromClient, observeOnly: kind === 'observe', data: frame });
    }
    if (kind !== 'verdict') this.flush(fromClient);
  }

  private expireVerdicts(now: number): void {
    let client = false;
    let server = false;
    for (const pending of this.pending.values()) {
      if (pending.result !== undefined || now < pending.deadline) continue;
      const drop = this.isExpiredCommand(pending);
      pending.result = drop ? null : pending.original;
      if (drop) ++this.expiredCommandDrops;
      else ++this.expiredVerdicts;
      if (pending.observation.fromClient) client = true;
      else server = true;
    }
    if (client) this.flush(true);
    if (server) this.flush(false);
    if (!this.closed) this.reportVerdictReleases(now);
  }

  private isExpiredCommand(pending: Pending): boolean {
    if (!pending.observation.fromClient || pending.observation.name !== 'PLAYERTEXT') return false;
    try {
      const packet = this.env.factory.createFromBytes(pending.original, 'client');
      return packet.isDefined && this.env.interest.isCommand(packet.data.text);
    } catch {
      return false; // Preserve fail-open behaviour when text cannot be decoded.
    }
  }

  private reportVerdictReleases(now: number): void {
    if ((!this.expiredVerdicts && !this.overriddenVerdicts && !this.expiredCommandDrops) || now - this.lastVerdictDiagnostic < 5000) return;
    const counts = [];
    if (this.expiredVerdicts) counts.push(`Plugin verdict deadlines expired: ${this.expiredVerdicts}`);
    if (this.overriddenVerdicts) counts.push(`Critical-packet verdict overrides: ${this.overriddenVerdicts}`);
    if (counts.length) counts.push('released original packets');
    if (this.expiredCommandDrops) counts.push(`Expired command drops: ${this.expiredCommandDrops}`);
    this.env.post({ type: 'diagnostic', id: this.id, message: counts.join('; ') });
    this.expiredCommandDrops = 0;
    this.expiredVerdicts = 0;
    this.overriddenVerdicts = 0;
    this.lastVerdictDiagnostic = now;
  }

  private routeHello(frame: Buffer): void {
    this.heldHello = null;
    const hello = this.env.factory.createFromBytes(frame, 'client');
    const route = this.env.router.routeHello(hello, this.target ?? this.env.fallbackDestination);
    if (!route) {
      this.fault(new Error(hello.isDefined
        ? 'No destination for this connection: the helper recorded no server and no fallback server is configured'
        : "Could not decode the game's HELLO; packet definitions may be out of date for this game build"));
      return;
    }
    this.env.post({ type: 'routed', id: this.id, host: route.destination.host, port: route.destination.port, restored: route.restored });
    this.env.post({ type: 'note', id: this.id, message: describeHello(hello, route) });
    if (this.env.interest.classify('HELLO', true) !== 'none') {
      // HELLO is routed by the worker; the main thread may read it (e.g. the access token) but never decide on it.
      this.env.post({ type: 'packet', id: this.id, sequence: 0, generation: this.generation, fromClient: true, observeOnly: true, data: frame });
    }
    this.connect(route.destination, route.hello);
  }

  private flush(fromClient: boolean): void {
    const order = fromClient ? this.clientOrder : this.serverOrder;
    while (order.length > 0) {
      const sequence = order[0];
      const next = this.pending.get(sequence);
      if (next && next.result === undefined) break;
      order.shift();
      if (!next) continue;
      this.pending.delete(sequence);
      this.pendingBytes -= next.bytes;
      // Game packets belong to this socket forever; server packets only to their upstream generation.
      if (next.result && (next.observation.fromClient || next.generation === this.generation)) {
        this.write(next.result, !next.observation.fromClient, 'normal', undefined, next.observation);
      } else {
        this.notifyDropped(next.observation);
      }
      if (this.closed) return;
    }
  }

  private connect(destination: Destination, hello: Buffer, retry = false): void {
    if (this.closed) return;
    this.helloForRetry = hello;
    ++this.generation;
    this.serverReady = false;
    this.serverResponded = false;
    this.destination = destination;
    for (const [sequence, pending] of this.pending) {
      if (!pending.observation.fromClient && pending.generation !== this.generation) {
        this.pending.delete(sequence);
        this.pendingBytes -= pending.bytes;
        this.notifyDropped(pending.observation);
      }
    }
    this.serverOrder = this.serverOrder.filter(sequence => this.pending.has(sequence));
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (!retry) this.helloAttempt = 0;
    if (this.server) { this.server.removeAllListeners(); this.server.destroy(); }
    this.toServerCipher = new RC4Cipher(RC4_KEYS.clientToServer);
    const frames = this.serverFrames = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const generation = this.generation;
    this.automation.reset(generation);
    for (const module of this.modules) {
      this.call(module, 'connectionChanged', () => module.hooks.connectionChanged?.(generation), undefined);
    }
    const server = this.server = new net.Socket();
    server.setNoDelay(true);
    const label = `${destination.host}:${destination.port}`;
    const retryHello = (error?: Error): void => {
      if (this.closed || this.server !== server) return;
      // A server that accepted HELLO and then reset has refused it; resending looks like a flood.
      if (error && this.serverReady && !this.serverResponded) {
        const elapsed = Math.round(this.env.now() - this.helloSentAt);
        this.fault(new Error(`${label} reset the connection ${elapsed} ms after HELLO (${error.message}); not retrying`));
        return;
      }
      if (this.serverResponded || !this.helloForRetry || this.helloAttempt >= MAX_HELLO_RETRIES) {
        this.fault(error ? new Error(`Server connection error (${error.message})`) : new Error(`${label} never answered HELLO`));
        return;
      }
      ++this.helloAttempt;
      this.env.post({ type: 'diagnostic', id: this.id, message: `${label} ${error
        ? `connect failed (${error.message})`
        : `did not answer HELLO within ${this.env.helloTimeoutMs} ms`}; retry ${this.helloAttempt}/${MAX_HELLO_RETRIES}` });
      this.connect(destination, this.helloForRetry, true);
    };
    server.on('data', data => {
      const receivedAt = this.env.now();
      if (this.closed || this.server !== server) return;
      this.serverResponded = true;
      this.helloForRetry = null;
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      this.receive(data, false, frames, receivedAt);
    });
    server.on('error', error => retryHello(error));
    server.on('close', () => { if (this.server === server) this.close('server'); });
    server.connect(destination.port, destination.host, () => {
      if (this.closed || this.server !== server || !this.helloForRetry) return;
      this.serverReady = true;
      this.writeRaw(this.helloForRetry, false);
      this.helloSentAt = this.env.now();
      this.trace.helloSent(this.helloSentAt);
      const queued = this.beforeConnect;
      this.beforeConnect = [];
      this.beforeConnectBytes = 0;
      for (const item of queued) this.write(item.data, false, item.kind, undefined, item.observation);
      this.env.post({ type: 'connected', id: this.id, generation });
      this.helloTimer = setTimeout(() => retryHello(), this.env.helloTimeoutMs);
    });
  }

  private write(data: Buffer, toClient: boolean, kind: WriteKind, done?: (error?: Error | null) => void,
    observation: Observation | null = null, origin: string | null = null): boolean {
    if (this.closed) {
      if (observation !== null) this.notifyDropped(observation);
      return false;
    }
    if (!isWholeFrame(data)) {
      this.env.post({ type: 'diagnostic', id: this.id, message: `Dropped a malformed ${kind} frame (${data.length} bytes)` });
      if (observation !== null) this.notifyDropped(observation);
      return false;
    }
    const direction = toClient ? 'server' : 'client';
    const name = this.env.factory.getPacketName(data[4], direction);
    let packet: Packet | null = null;
    const decode = (): Packet => (packet ??= this.env.factory.createFromBytes(data, direction));
    if (!toClient && !this.serverReady) {
      if (kind === 'priority') {
        if (observation !== null) this.notifyDropped(observation);
        return false;
      }
      this.beforeConnectBytes += data.length;
      if (this.beforeConnectBytes > this.env.maxPendingBytes) {
        if (observation !== null) this.notifyDropped(observation);
        this.fault(new Error('Too much game traffic queued before the server connected'));
        return false;
      }
      this.beforeConnect.push({ data: Buffer.from(data), kind, observation });
      return true;
    }
    // A renamed client frame no longer delivers its original observation. Retire it
    // before modules assess the replacement, including when that replacement is vetoed.
    if (!toClient && observation !== null && name !== observation.name) {
      this.notifyDropped(observation);
      observation = null;
    }
    const observationId = observation !== null && name === observation.name ? observation.id : null;
    const token = ++this.writeTokens;
    const prepared: ActiveModule[] = [];
    let accepted = false;
    let out = data;
    try {
      if (!toClient) {
        const now = this.env.now();
        for (const module of this.modules) {
          if (this.closed) break;
          if (!module.prepare.has(name) || !module.hooks.prepareWrite) continue;
          prepared.push(module); // A throwing hook still owns an outcome.
          this.call(module, 'prepareWrite', () => module.hooks.prepareWrite!({ token, packet: decode(), kind, now,
            observationId, origin }), undefined);
        }
      }
      if (this.closed) {
        if (observation !== null) this.notifyDropped(observation);
        return false;
      }
      for (const module of this.modules) {
        const allowed = this.call(module, 'allowWrite', () => module.hooks.allowWrite?.(name, toClient, kind, decode) ?? true, true);
        if (!allowed || this.closed) {
          if (observation !== null) this.notifyDropped(observation);
          return false;
        }
      }
      if (toClient && name === 'RECONNECT') {
        const original = decode();
        const rewritten = this.destination ? this.env.router.rewriteReconnect(original, this.destination) : null;
        if (!rewritten) {
          this.env.post({ type: 'diagnostic', id: this.id, message: 'Dropped a malformed RECONNECT; the current route is unchanged' });
          if (observation !== null) this.notifyDropped(observation);
          return false;
        }
        out = rewritten;
        this.env.post({ type: 'note', id: this.id, message: describeReconnect(original) });
        // Final-write subscribers must see the rewritten bytes, never the original route.
        packet = null;
      }
      accepted = this.writeRaw(out, toClient, done, kind !== 'normal');
      if (!accepted) {
        if (observation !== null) this.notifyDropped(observation);
        return false;
      }
    } finally {
      const now = this.env.now();
      for (const module of prepared) {
        this.call(module, 'writeOutcome', () => module.hooks.writeOutcome?.(token, accepted, now), undefined);
      }
    }
    if (observation !== null && name !== observation.name) this.notifyDropped(observation);
    if (toClient) {
      const now = this.env.now();
      const decodeWritten = (): Packet => (packet ??= this.env.factory.createFromBytes(out, direction));
      for (const module of this.modules) {
        if (module.writtenServer.has(name)) {
          this.call(module, 'writtenServer', () => module.hooks.writtenServer?.(decodeWritten(), kind, now, observationId), undefined);
        }
      }
    } else {
      const now = this.env.now();
      for (const module of this.modules) {
        if (module.written.has(name)) this.call(module, 'written', () => module.hooks.written?.(decode(), kind, now, observationId, origin), undefined);
      }
    }
    return true;
  }

  private lastWriteAcceptedAt = 0;

  private writeRaw(data: Buffer, toClient: boolean, done?: (error?: Error | null) => void, byRealmTool = false): boolean {
    const socket = toClient ? this.client : this.server;
    if (!socket || socket.destroyed || !socket.writable) return false;
    this.trace.sent(toClient, data.length, byRealmTool);
    const encrypted = Buffer.from(data);
    (toClient ? this.toClientCipher : this.toServerCipher).cipher(encrypted);
    socket.write(encrypted, done);
    this.lastWriteAcceptedAt = this.env.now();
    if (socket.writableLength > this.env.maxPendingBytes) {
      this.fault(new Error(`${toClient ? 'Game' : 'Server'} is not reading; output backlog exceeded the limit`));
    }
    return true;
  }
}
