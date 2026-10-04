import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../config/store.ts';
import type { PluginDefinition } from '../plugins/api.ts';
import { PluginHost, type ProxyLike } from '../plugins/host.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import { createFactory } from '../protocol/schema.ts';
import type { HostEvents } from '../transport/host.ts';
import type { InterestSpec } from '../transport/interest.ts';

export interface Forwarded { id: string; sequence: number; generation: number; data: Buffer | null }
export interface Injected { id: string; data: Buffer; toClient: boolean }

/** Stands in for ProxyHost: records interest, verdicts, injections and worker messages; tests emit its events. */
export class FakeProxy extends EventEmitter<HostEvents> {
  interest: InterestSpec = {};
  readonly forwards: Forwarded[] = [];
  readonly injected: Injected[] = [];
  readonly configured: Record<string, unknown>[] = [];
  readonly commands: { moduleId: string; id: string; message: unknown }[] = [];
  setInterest(interest: InterestSpec): void { this.interest = interest; }
  forward(id: string, sequence: number, generation: number, data: Buffer | null): void { this.forwards.push({ id, sequence, generation, data }); }
  inject(id: string, data: Buffer, toClient: boolean): void { this.injected.push({ id, data, toClient }); }
  configureModules(configs: Record<string, unknown>): void { this.configured.push(configs); }
  moduleCommand(moduleId: string, id: string, message: unknown): void { this.commands.push({ moduleId, id, message }); }
}

export interface PacketOptions { observeOnly?: boolean }

export function startHost(definitions: readonly PluginDefinition[], options: { profileDir?: string; factory?: PacketFactory } = {}) {
  const proxy = new FakeProxy();
  const factory = options.factory ?? createFactory();
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'realmtool-plugins-'));
  const profile = new ProfileStore({ dir: profileDir, debounceMs: 0 });
  // EventEmitter's fluent on/off return this; Pick<ProxyHost> retains ProxyHost's
  // return type. The host uses only the seven methods implemented by this fake.
  const host = new PluginHost({ proxy: proxy as unknown as ProxyLike, factory, definitions, profile });
  host.start();
  let sequence = 0;
  return {
    host, proxy, factory, profile, profileDir,
    connect(id = 'c1'): string { proxy.emit('session', { id, remotePort: 50000 }); return id; },
    route(id: string, server: string, port = 2050): void { proxy.emit('routed', { id, host: server, port, restored: false }); },
    close(id: string): void { proxy.emit('closed', { id, by: 'game' }); },
    workerMessage(id: string, moduleId: string, message: unknown): void { proxy.emit('module', { id, moduleId, message }); },
    /** Emit one packet event; returns the verdict (undefined for observe-only events). */
    packet(id: string, name: string, data: Record<string, unknown>, opts: PacketOptions = {}): Forwarded | undefined {
      const p = factory.createByName(name);
      p.data = data;
      const bytes = factory.serialize(p);
      const fromClient = factory.getPacketDirection(name) === 'client';
      const seq = opts.observeOnly ? 0 : ++sequence;
      const before = proxy.forwards.length;
      proxy.emit('packet', { id, sequence: seq, generation: 1, fromClient, observeOnly: !!opts.observeOnly, data: bytes });
      return opts.observeOnly ? undefined : proxy.forwards.slice(before).find(f => f.sequence === seq);
    },
  };
}
export type Harness = ReturnType<typeof startHost>;

/** A TEXT packet's full data with sensible defaults. */
export function textData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Player', objectId: 1, numStars: 10, bubbleTime: 0, recipient: '', text: 'hello', cleanText: 'hello', isSupporter: false, starBg: 0, ...over };
}
