import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { GAME_PORT } from '../protocol/constants.ts';
import type { ProtocolSchema } from '../protocol/schema.ts';
import type { Destination } from '../routing/router.ts';
import type { InterestSpec } from './interest.ts';
import { DEFAULTS, type CloseSide, type WorkerCommand, type WorkerEvent, type WorkerInit } from './messages.ts';

export interface PacketEvent {
  id: string;
  sequence: number;
  generation: number;
  fromClient: boolean;
  /** True: already forwarded, informational. False: the worker waits for forward(). */
  observeOnly: boolean;
  data: Buffer;
}

export interface HostEvents {
  listening: [port: number];
  session: [info: { id: string; remotePort: number }];
  routed: [info: { id: string; host: string; port: number; restored: boolean }];
  connected: [info: { id: string; generation: number }];
  packet: [event: PacketEvent];
  closed: [info: { id: string; by: CloseSide }];
  diagnostic: [info: { id?: string; message: string }];
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
  private listening = false;
  private starting: { resolve(port: number): void; reject(error: Error): void } | null = null;

  constructor(options: ProxyHostOptions) {
    super();
    this.options = options;
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
      worker = new Worker(o.workerUrl ?? new URL('./worker.ts', import.meta.url), { workerData: init });
    } catch (error) {
      this.worker = null;
      return Promise.reject(error);
    }
    this.worker = worker;
    const started = new Promise<number>((resolve, reject) => { this.starting = { resolve, reject }; });
    worker.on('message', (event: WorkerEvent) => this.handle(event));
    worker.on('error', error => {
      this.failStart(error);
      this.emit('fault', { message: `Network worker crashed: ${error.message}` });
    });
    worker.on('exit', code => {
      if (this.worker === worker) this.worker = null;
      this.listening = false;
      this.failStart(new Error(`Network worker exited (code ${code}) before listening`));
    });
    return started;
  }

  setInterest(interest: InterestSpec): void { this.send({ type: 'interest', interest }); }

  forward(id: string, sequence: number, generation: number, data: Buffer | null): void {
    this.send({ type: 'forward', id, sequence, generation, data });
  }

  inject(id: string, data: Buffer, toClient: boolean): void { this.send({ type: 'inject', id, data, toClient }); }

  configureModule(moduleId: string, config: unknown): void { this.send({ type: 'module', moduleId, message: config }); }

  moduleCommand(moduleId: string, id: string, message: unknown): void { this.send({ type: 'module', moduleId, id, message }); }

  close(id: string): void { this.send({ type: 'close', id }); }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    worker.postMessage({ type: 'stop' } satisfies WorkerCommand);
    const timeout = setTimeout(() => { void worker.terminate(); }, 2000);
    await exited;
    clearTimeout(timeout);
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
