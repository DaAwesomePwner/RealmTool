import { resourcePaths } from '../app/resources.ts';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { GAME_PORT } from '../protocol/constants.ts';
import type { ProtocolSchema } from '../protocol/schema.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';
import { DEFAULTS, MODULE_HEALTH_QUIET_MS, type ModuleHealthEvent, type ModuleConfigEvent, type CloseSide, type WorkerCommand, type WorkerEvent, type WorkerInit } from './messages.ts';

export interface PacketEvent {
  id: string;
  sequence: number;
  generation: number;
  fromClient: boolean;
  /** True: informational, no verdict accepted. False: forward() may decide within 250 ms; expiry or a critical packet releases the original. */
  observeOnly: boolean;
  data: Buffer;
}

export interface ModuleHealthSnapshot {
  status: 'healthy' | 'failing';
  /** Start of the current episode on the host's performance.now(); null after recovery. */
  failingSince: number | null;
  lastError: string;
  /** Host receipt time of the most recent failure report. */
  lastFailureAt: number;
  totalFailures: number;
}

export type ModuleConfigState = { status: 'accepted' } | { status: 'rejected'; error: string };

export interface ModuleStatusEvent {
  moduleId: string;
  state: 'failing' | 'healthy';
  /** Host performance.now() timestamp when this state began. */
  since: number;
  lastError?: string;
}

export interface HostEvents {
  /** Emitted once per transition, including timer-driven recovery; no polling required. */
  moduleStatus: [event: ModuleStatusEvent];
  /** Incremental reports; query getModuleHealth() for the aggregate snapshot. */
  moduleHealth: [event: ModuleHealthEvent];
  /** Result of each initial or live configure; rejection retains the previous worker config. */
  moduleConfig: [event: ModuleConfigEvent];
  listening: [port: number];
  exit: [info: { code: number; expected: boolean }];
  session: [info: { id: string; remotePort: number }];
  routed: [info: { id: string; host: string; port: number; restored: boolean }];
  connected: [info: { id: string; generation: number }];
  packet: [event: PacketEvent];
  closed: [info: { id: string; by: CloseSide }];
  diagnostic: [info: { id?: string; message: string }];
  note: [info: { id: string; message: string }];
  fault: [info: { id?: string; message: string }];
  module: [info: { moduleId: string; id?: string; message: unknown }];
}

export interface ProxyHostOptions {
  schema: ProtocolSchema;
  listenPort?: number;
  fallbackDestination?: Destination | null;
  /** Main-thread lookup of where a new game socket was going (helper temp file). */
  resolveTarget?: (remotePort: number) => Destination | null;
  interest?: InterestSpec;
  moduleConfig?: Record<string, unknown>;
  targetTimeoutMs?: number;
  helloTimeoutMs?: number;
  maxPendingBytes?: number;
  workerUrl?: URL;
}

/** Main-thread handle on the network worker. */
export class ProxyHost extends EventEmitter<HostEvents> {
  private readonly options: ProxyHostOptions;
  private worker: Worker | null = null;
  private readonly expectedExits = new WeakSet<Worker>();
  private listening = false;
  private readonly health = new Map<string, ModuleHealthSnapshot>();
  private readonly configs = new Map<string, ModuleConfigState>();

  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTrackingStopped = false;
  private starting: { resolve(port: number): void; reject(error: Error): void } | null = null;

  constructor(options: ProxyHostOptions) {
    super();
    this.options = options;
  }

  /** Snapshot across sessions/hooks in this worker run; undefined before the first failure.
   * Recovery emits moduleStatus after MODULE_HEALTH_QUIET_MS without a received failure report.
   * All snapshot times use the host clock. Worker reports can lag by MODULE_FAILURE_REPORT_MS.
   */
  getModuleHealth(moduleId: string): ModuleHealthSnapshot | undefined {
    const state = this.health.get(moduleId);
    return state ? { ...state } : undefined;
  }

  /** Result of the latest worker configuration acknowledgment in this run.
   * Undefined until the worker replies; sending another request retains the previous result
   * until its reply arrives. Rejected means the worker kept its previous configuration.
   * Accepted confirms configuration validation, not that the module is enabled or healthy.
   */
  getModuleConfigState(moduleId: string): ModuleConfigState | undefined {
    const state = this.configs.get(moduleId);
    return state ? { ...state } : undefined;
  }

  start(): Promise<number> {
    if (this.worker) return Promise.reject(new Error('ProxyHost is already started'));
    const o = this.options;
    const init: WorkerInit = {
      host: '127.0.0.1',
      port: o.listenPort ?? GAME_PORT,
      definitions: o.schema.definitions,
      stats: o.schema.stats,
      fallbackDestination: o.fallbackDestination ?? null,
      targetTimeoutMs: o.targetTimeoutMs ?? DEFAULTS.targetTimeoutMs,
      helloTimeoutMs: o.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs,
      maxPendingBytes: o.maxPendingBytes ?? DEFAULTS.maxPendingBytes,
      interest: o.interest ?? {},
      moduleConfig: o.moduleConfig ?? {},
    };
    let worker: Worker;
    try {
      worker = new Worker(o.workerUrl ?? resourcePaths().workerUrl, { workerData: init });
    } catch (error) {
      this.worker = null;
      return Promise.reject(error);
    }
    this.clearRecoveryTimer();
    this.healthTrackingStopped = false;
    this.health.clear();
    this.configs.clear();
    this.worker = worker;
    const started = new Promise<number>((resolve, reject) => { this.starting = { resolve, reject }; });
    worker.on('message', (event: WorkerEvent) => this.handle(event));
    worker.on('error', error => {
      this.failStart(error);
      this.emit('fault', { message: `Network worker crashed: ${error.message}` });
    });
    worker.on('exit', code => {
      this.healthTrackingStopped = true;
      this.clearRecoveryTimer();
      if (this.worker === worker) this.worker = null;
      this.listening = false;
      this.failStart(new Error(`Network worker exited (code ${code}) before listening`));
      this.emit('exit', { code, expected: this.expectedExits.has(worker) });
    });
    return started;
  }

  setInterest(interest: InterestSpec): void {
    this.options.interest = interest;
    this.send({ type: 'interest', interest });
  }

  forward(id: string, sequence: number, generation: number, data: Buffer | null): void {
    this.send({ type: 'forward', id, sequence, generation, data });
  }

  inject(id: string, data: Buffer, toClient: boolean): void { this.send({ type: 'inject', id, data, toClient }); }

  configureModule(moduleId: string, config: unknown): void {
    this.options.moduleConfig = { ...this.options.moduleConfig, [moduleId]: config };
    this.send({ type: 'module', moduleId, message: config });
  }

  configureModules(configs: Record<string, unknown>): void {
    this.options.moduleConfig = { ...this.options.moduleConfig, ...configs };
    this.send({ type: 'modules', configs });
  }

  moduleCommand(moduleId: string, id: string, message: unknown): void { this.send({ type: 'module', moduleId, id, message }); }

  close(id: string): void { this.send({ type: 'close', id }); }

  async stop(): Promise<void> {
    this.healthTrackingStopped = true;
    this.clearRecoveryTimer();
    const worker = this.worker;
    if (!worker) return;
    this.expectedExits.add(worker);
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'stop' } satisfies WorkerCommand);
    const timeout = setTimeout(() => { void worker.terminate(); }, 2000);
    await exited;
    clearTimeout(timeout);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private scheduleRecovery(): void {
    this.clearRecoveryTimer();
    if (this.healthTrackingStopped) return;
    let deadline = Infinity;
    for (const state of this.health.values()) {
      if (state.status === 'failing') deadline = Math.min(deadline, state.lastFailureAt + MODULE_HEALTH_QUIET_MS);
    }
    if (deadline === Infinity) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      const now = performance.now();
      for (const [moduleId, state] of this.health) {
        if (state.status !== 'failing' || now - state.lastFailureAt < MODULE_HEALTH_QUIET_MS) continue;
        state.status = 'healthy';
        state.failingSince = null;
        this.emit('moduleStatus', { moduleId, state: 'healthy', since: now });
      }
      this.scheduleRecovery();
    }, Math.max(1, deadline - performance.now()));
    this.recoveryTimer.unref();
  }

  private send(command: WorkerCommand): void {
    this.worker?.postMessage(command);
  }

  private failStart(error: Error): void {
    const starting = this.starting;
    this.starting = null;
    if (!starting) return;
    starting.reject(error);
    void this.worker?.terminate();
  }

  private handle(event: WorkerEvent): void {
    switch (event.type) {
      case 'moduleHealth': {
        const now = performance.now();
        const previous = this.health.get(event.moduleId);
        const continuing = previous?.status === 'failing';
        this.health.set(event.moduleId, {
          status: 'failing',
          failingSince: continuing ? previous.failingSince : now,
          lastError: event.lastError,
          lastFailureAt: now,
          totalFailures: (previous?.totalFailures ?? 0) + event.failures,
        });
        this.scheduleRecovery();
        if (!continuing) this.emit('moduleStatus', {
          moduleId: event.moduleId, state: 'failing', since: now, lastError: event.lastError,
        });
        this.emit('moduleHealth', event);
        return;
      }
      case 'moduleConfig':
        this.configs.set(event.moduleId, event.ok ? { status: 'accepted' } : { status: 'rejected', error: event.error });
        this.emit('moduleConfig', event);
        return;
      case 'listening':
        this.listening = true;
        this.starting?.resolve(event.port);
        this.starting = null;
        this.emit('listening', event.port);
        return;
      case 'opened': {
        this.emit('session', { id: event.id, remotePort: event.remotePort });
        let destination: Destination | null = null;
        try {
          destination = this.options.resolveTarget?.(event.remotePort) ?? null;
        } catch (error) {
          this.emit('diagnostic', { id: event.id, message: `Target lookup failed: ${(error as Error).message}` });
        }
        this.send({ type: 'target', id: event.id, destination });
        return;
      }
      case 'routed':
        this.emit('routed', { id: event.id, host: event.host, port: event.port, restored: event.restored });
        return;
      case 'connected':
        this.emit('connected', { id: event.id, generation: event.generation });
        return;
      case 'packet': {
        const data = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        const packet: PacketEvent = { id: event.id, sequence: event.sequence, generation: event.generation,
          fromClient: event.fromClient, observeOnly: event.observeOnly, data };
        if (!packet.observeOnly && this.listenerCount('packet') === 0) {
          this.forward(packet.id, packet.sequence, packet.generation, data);
          return;
        }
        this.emit('packet', packet);
        return;
      }
      case 'closed':
        this.emit('closed', { id: event.id, by: event.by });
        return;
      case 'diagnostic':
        this.emit('diagnostic', { id: event.id, message: event.message });
        return;
      case 'note':
        this.emit('note', { id: event.id, message: event.message });
        return;
      case 'fault':
        if (!event.id && !this.listening) this.failStart(new Error(event.message));
        this.emit('fault', { id: event.id, message: event.message });
        return;
      case 'module':
        this.emit('module', { moduleId: event.moduleId, id: event.id, message: event.message });
        return;
    }
  }
}
