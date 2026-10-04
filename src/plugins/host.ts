import type { Profile, ProfileStore } from '../config/store.ts';
import { PROFILE_SCHEMA_VERSION } from '../config/store.ts';
import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import type { PacketEvent, ProxyHost } from '../transport/host.ts';
import type { InterestSpec } from '../transport/interest.ts';
import { log } from '../util/log.ts';
import {
  PLUGIN_API_VERSION, type Capability, type ClientConnection, type CommandHook, type ConnectionEvent,
  type PacketHook, type PluginContext, type PluginDefinition, type ServerInfo, type SettingDef, type WorkerChannel,
} from './api.ts';
import { IDENTITY_PACKETS, PlayerIdentity } from './identity.ts';
import { SettingsStore } from './settings.ts';

const CREDENTIAL_PACKETS: ReadonlySet<string> = new Set(['HELLO']);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ProxyLike = Pick<ProxyHost, 'on' | 'off' | 'setInterest' | 'forward' | 'inject' | 'configureModules' | 'moduleCommand'>;

export interface PluginHostOptions {
  proxy: ProxyLike;
  factory: PacketFactory;
  definitions: readonly PluginDefinition[];
  profile: ProfileStore;
  onData?: (pluginId: string, type: string, data: unknown) => void;
}

interface Registered<T> { plugin: Plugin; fn: T }
interface Listener { plugin: Plugin; event: ConnectionEvent; fn: (client: ClientConnection) => void }

class Client implements ClientConnection {
  readonly clientId: string;
  connected = true;
  server: ServerInfo | null = null;
  readonly identity = new PlayerIdentity();
  private readonly host: PluginHost;

  constructor(host: PluginHost, clientId: string) {
    this.host = host;
    this.clientId = clientId;
  }

  get playerData(): { name: string; ownerObjectId: number } {
    return { name: this.identity.name, ownerObjectId: this.identity.ownerObjectId };
  }

  sendToClient(packet: Packet): void { this.host.send(this, packet, true); }
  sendToServer(packet: Packet): void { this.host.send(this, packet, false); }
}

class Plugin implements PluginContext {
  readonly pluginId: string;
  readonly definition: PluginDefinition;
  name: string;
  category = 'utility';
  readonly settings: SettingsStore;
  readonly data = new Map<string, unknown>();
  failed = false;
  private enabledValue = true;
  private readonly enabledCallbacks: ((enabled: boolean) => void)[] = [];
  readonly cleanups: (() => void)[] = [];
  readonly workerHandlers: ((client: ClientConnection, message: unknown) => void)[] = [];
  private readonly host: PluginHost;

  constructor(host: PluginHost, definition: PluginDefinition) {
    this.host = host;
    this.definition = definition;
    this.pluginId = definition.id;
    this.name = definition.name;
    this.settings = new SettingsStore(definition.settings?.validate?.bind(definition.settings), () => host.changed());
  }

  get enabled(): boolean { return !this.failed && this.enabledValue; }
  set enabled(value: boolean) {
    if (this.failed) return;
    this.enabledValue = value;
    for (const callback of this.enabledCallbacks) {
      try { callback(value); } catch (error) { log.error(this.name, 'Enable callback failed', error); }
    }
    this.host.changed();
  }

  get worker(): WorkerChannel {
    this.require('worker');
    return {
      configure: config => this.host.configureWorker(this, config),
      send: (client, message) => this.host.sendWorker(this, client, message),
      onMessage: handler => { if (!this.failed) this.workerHandlers.push(handler); },
    };
  }

  registerSetting(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void {
    if (!this.failed) this.settings.register(key, def, onChange);
  }
  getSetting<T = any>(key: string): T { return this.settings.get<T>(key); }
  updateSetting(key: string, value: unknown): boolean {
    if (this.failed) return false;
    const accepted = this.settings.update(key, value);
    // SettingsStore buttons notify their callbacks without its store-wide change
    // callback. Every accepted context update still schedules a profile snapshot.
    if (accepted && this.settings.definition(key)?.type === 'button') this.host.changed();
    return accepted;
  }

  hookPacket(name: string, fn: PacketHook, options: { prepend?: boolean } = {}): void {
    if (this.failed) return;
    this.require('packets');
    this.host.addHook(this, name, fn, !!options.prepend);
  }
  observePacket(name: string, fn: PacketHook): void {
    if (this.failed) return;
    this.require('packets');
    this.host.addObserver(this, name, fn);
  }
  hookCommand(name: string, fn: CommandHook): void {
    if (this.failed) return;
    this.require('commands');
    this.host.addCommand(this, name.replace(/^\//, '').toLowerCase(), fn);
  }
  on(event: ConnectionEvent, fn: (client: ClientConnection) => void): void { this.host.addListener({ plugin: this, event, fn }); }
  onEnabledChange(fn: (enabled: boolean) => void): void { if (!this.failed) this.enabledCallbacks.push(fn); }
  registerCleanup(fn: () => void): void { if (!this.failed) this.cleanups.push(fn); }
  setData(key: string, value: unknown): void { this.data.set(key, value); }
  broadcastData(type: string, data: unknown): void { this.host.broadcast(this, type, data); }
  createPacket(name: string): Packet {
    this.require('inject');
    return this.host.factory.createByName(name);
  }
  sendNotification(client: ClientConnection, sender: string, message: string): void {
    this.require('notifications');
    const packet = this.host.factory.createByName('TEXT');
    packet.data = { name: sender, objectId: -1, numStars: -1, bubbleTime: 0, recipient: '', text: message, cleanText: message, isSupporter: false, starBg: 0 };
    client.sendToClient(packet);
  }
  log(message: string): void { log.info(this.name, message); }

  private require(capability: Capability): void {
    if (!this.definition.capabilities.includes(capability)) {
      throw new Error(`${this.name} did not declare the "${capability}" capability`);
    }
  }
}

/** Loads plugins and connects them to the proxy's packet stream. */
export class PluginHost {
  readonly factory: PacketFactory;
  private readonly proxy: ProxyLike;
  private readonly definitions: readonly PluginDefinition[];
  private readonly profile: ProfileStore;
  private readonly onData: PluginHostOptions['onData'];
  private readonly plugins = new Map<string, Plugin>();
  private readonly hooks = new Map<string, Registered<PacketHook>[]>();
  private readonly observers = new Map<string, Registered<PacketHook>[]>();
  private readonly commands = new Map<string, Registered<CommandHook>[]>();
  private listeners: Listener[] = [];
  private readonly clients = new Map<string, Client>();
  private readonly pendingConfigs = new Map<string, unknown>();
  private loadedProfile: Profile = { schemaVersion: PROFILE_SCHEMA_VERSION, plugins: {} };
  private applying = false;
  private started = false;

  constructor(options: PluginHostOptions) {
    this.proxy = options.proxy;
    this.factory = options.factory;
    this.definitions = options.definitions;
    this.profile = options.profile;
    this.onData = options.onData;
  }

  start(): InterestSpec {
    this.loadedProfile = this.profile.load();
    this.applying = true;
    try {
      for (const definition of this.definitions) this.load(definition);
    } finally {
      this.applying = false;
    }
    const interest = this.interest();
    this.proxy.setInterest(interest);
    this.proxy.on('session', this.onSession);
    this.proxy.on('routed', this.onRouted);
    this.proxy.on('closed', this.onClosed);
    this.proxy.on('packet', this.onPacket);
    this.proxy.on('module', this.onModule);
    this.started = true;
    this.flushConfigs();
    return interest;
  }

  stop(): void {
    for (const plugin of this.plugins.values()) this.cleanup(plugin);
    this.proxy.off('session', this.onSession);
    this.proxy.off('routed', this.onRouted);
    this.proxy.off('closed', this.onClosed);
    this.proxy.off('packet', this.onPacket);
    this.proxy.off('module', this.onModule);
    this.pendingConfigs.clear();
    this.started = false;
    this.profile.flush();
  }

  loaded(): string[] {
    return [...this.plugins.values()].filter(p => !p.failed).map(p => p.pluginId);
  }

  context(id: string): PluginContext | undefined {
    const plugin = this.plugins.get(id);
    return plugin && !plugin.failed ? plugin : undefined;
  }

  data(id: string): ReadonlyMap<string, unknown> | undefined {
    return this.context(id) ? this.plugins.get(id)!.data : undefined;
  }

  // ── called by Plugin / Client ─────────────────────────────

  addHook(plugin: Plugin, name: string, fn: PacketHook, prepend: boolean): void {
    if (plugin.failed) return;
    this.direction(name);
    const list = this.hooks.get(name) ?? [];
    if (prepend) list.unshift({ plugin, fn }); else list.push({ plugin, fn });
    this.hooks.set(name, list);
    this.refreshInterest();
  }

  addObserver(plugin: Plugin, name: string, fn: PacketHook): void {
    if (plugin.failed) return;
    this.direction(name);
    this.observers.set(name, [...(this.observers.get(name) ?? []), { plugin, fn }]);
    this.refreshInterest();
  }

  addCommand(plugin: Plugin, name: string, fn: CommandHook): void {
    if (plugin.failed) return;
    this.commands.set(name, [...(this.commands.get(name) ?? []), { plugin, fn }]);
    this.refreshInterest();
  }

  addListener(listener: Listener): void { if (!listener.plugin.failed) this.listeners.push(listener); }

  configureWorker(plugin: Plugin, config: unknown): void {
    if (plugin.failed) return;
    this.pendingConfigs.set(plugin.pluginId, config);
    if (this.started && !this.applying) this.flushConfigs();
  }

  sendWorker(plugin: Plugin, client: ClientConnection, message: unknown): void {
    if (plugin.failed || !this.started || !client.connected || this.clients.get(client.clientId) !== client) return;
    this.proxy.moduleCommand(plugin.pluginId, client.clientId, message);
  }

  broadcast(plugin: Plugin, type: string, data: unknown): void { this.onData?.(plugin.pluginId, type, data); }

  send(client: Client, packet: Packet, toClient: boolean): void {
    if (!client.connected) return;
    this.proxy.inject(client.clientId, this.factory.serialize(packet), toClient);
  }

  changed(): void {
    if (this.applying || !this.started) return;
    this.profile.scheduleSave(this.snapshot());
  }

  // ── internals ─────────────────────────────────────────────

  private load(definition: PluginDefinition): void {
    if (definition.apiVersion !== PLUGIN_API_VERSION) {
      log.error('Plugins', `${definition.name} targets plugin API ${definition.apiVersion}; this RealmTool supports ${PLUGIN_API_VERSION}`);
      return;
    }
    if (this.plugins.has(definition.id)) {
      log.error('Plugins', `Duplicate plugin id ${definition.id}; ignoring ${definition.name}`);
      return;
    }
    const plugin = new Plugin(this, definition);
    this.plugins.set(definition.id, plugin);
    try {
      definition.register(plugin);
      this.applyProfile(plugin);
    } catch (error) {
      log.error('Plugins', `${definition.name} failed to load and is disabled`, error);
      this.fail(plugin);
    }
  }

  private applyProfile(plugin: Plugin): void {
    const entry = this.loadedProfile.plugins[plugin.pluginId];
    const policy = plugin.definition.settings;
    let values: Record<string, unknown> = entry?.settings ?? {};
    if (policy?.migrate) {
      try {
        values = policy.migrate(entry?.settings, entry !== undefined);
      } catch (error) {
        log.warn('Plugins', `${plugin.name}: saved settings are invalid (${describeError(error)}); using defaults`);
        values = policy.migrate(undefined, false);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      const def = plugin.settings.definition(key);
      if (!def || def.type === 'button' || def.transient) continue;
      if (!plugin.updateSetting(key, value)) log.warn('Plugins', `${plugin.name}: ignored an invalid saved value for ${key}`);
    }
    if (typeof entry?.enabled === 'boolean') plugin.enabled = entry.enabled;
  }

  private fail(plugin: Plugin): void {
    plugin.failed = true;
    this.pendingConfigs.delete(plugin.pluginId);
    this.unregister(plugin);
    this.cleanup(plugin);
  }

  private cleanup(plugin: Plugin): void {
    for (const cleanup of plugin.cleanups.splice(0)) {
      try { cleanup(); } catch (error) { log.error(plugin.name, 'Cleanup failed', error); }
    }
    plugin.workerHandlers.length = 0;
  }

  private flushConfigs(): void {
    if (this.pendingConfigs.size === 0) return;
    const configs = Object.fromEntries(this.pendingConfigs);
    this.pendingConfigs.clear();
    this.proxy.configureModules(configs);
  }

  private unregister(plugin: Plugin): void {
    for (const map of [this.hooks, this.observers, this.commands] as Map<string, Registered<unknown>[]>[]) {
      for (const [name, list] of map) {
        const kept = list.filter(entry => entry.plugin !== plugin);
        if (kept.length) map.set(name, kept); else map.delete(name);
      }
    }
    this.listeners = this.listeners.filter(listener => listener.plugin !== plugin);
    this.refreshInterest();
  }

  private snapshot(): Profile {
    const plugins: Profile['plugins'] = { ...this.loadedProfile.plugins };
    for (const plugin of this.plugins.values()) {
      if (plugin.failed) continue;
      plugins[plugin.pluginId] = { enabled: plugin.enabled, settings: plugin.settings.persistable() };
    }
    return { schemaVersion: PROFILE_SCHEMA_VERSION, plugins };
  }

  private direction(name: string): 'client' | 'server' {
    const direction = this.factory.getPacketDirection(name);
    if (!direction) throw new Error(`Unknown packet ${name}`);
    return direction;
  }

  private interest(): InterestSpec {
    const verdict = { client: new Set<string>(), server: new Set<string>() };
    const observe = { client: new Set<string>(), server: new Set<string>() };
    for (const name of this.hooks.keys()) verdict[this.direction(name)].add(name);
    if (this.commands.size > 0) verdict.client.add('PLAYERTEXT');
    for (const name of this.observers.keys()) observe[this.direction(name)].add(name);
    for (const name of IDENTITY_PACKETS) observe[this.direction(name)].add(name);
    return {
      verdict: { client: [...verdict.client], server: [...verdict.server] },
      observe: { client: [...observe.client], server: [...observe.server] },
    };
  }

  private refreshInterest(): void {
    if (this.started) this.proxy.setInterest(this.interest());
  }

  private emitConnection(event: ConnectionEvent, client: Client): void {
    for (const listener of this.listeners) {
      if (listener.event !== event || listener.plugin.failed || !listener.plugin.enabled) continue;
      try { listener.fn(client); } catch (error) { log.error(listener.plugin.name, `${event} handler failed`, error); }
    }
  }

  private readonly onSession = ({ id }: { id: string }): void => {
    const client = new Client(this, id);
    this.clients.set(id, client);
    this.emitConnection('clientConnected', client);
  };

  private readonly onRouted = ({ id, host, port }: { id: string; host: string; port: number }): void => {
    const client = this.clients.get(id);
    if (client) client.server = { host, port };
  };

  private readonly onClosed = ({ id }: { id: string }): void => {
    const client = this.clients.get(id);
    if (!client) return;
    client.connected = false;
    this.clients.delete(id);
    this.emitConnection('clientDisconnected', client);
  };

  private readonly onModule = ({ moduleId, id, message }: { moduleId: string; id?: string; message: unknown }): void => {
    const plugin = this.plugins.get(moduleId);
    const client = id === undefined ? undefined : this.clients.get(id);
    if (!plugin || plugin.failed || !client || !client.connected) return;
    for (const handler of plugin.workerHandlers) {
      try { handler(client, message); } catch (error) { log.error(plugin.name, 'Worker message handler failed', error); }
    }
  };

  private readonly onPacket = (event: PacketEvent): void => {
    let packet: Packet | null = null;
    try {
      const client = this.clients.get(event.id);
      if (!client) return;
      packet = this.factory.createFromBytes(event.data, event.fromClient ? 'client' : 'server');
      if (!event.fromClient && IDENTITY_PACKETS.has(packet.name)) client.identity.observe(packet);
      this.run(this.observers.get(packet.name), client, packet, 'observer');
      if (event.observeOnly) return;
      if (event.fromClient && packet.name === 'PLAYERTEXT') this.runCommands(client, packet);
      this.run(this.hooks.get(packet.name), client, packet, 'hook');
    } catch (error) {
      if (packet && CREDENTIAL_PACKETS.has(packet.name)) {
        log.error('Plugins', 'Packet handling failed (details withheld: this packet carries credentials)');
      } else {
        log.error('Plugins', 'Packet handling failed', error);
      }
    } finally {
      if (!event.observeOnly) this.proxy.forward(event.id, event.sequence, event.generation, this.verdict(event, packet));
    }
  };

  private run(list: Registered<PacketHook>[] | undefined, client: Client, packet: Packet, kind: string): void {
    for (const { plugin, fn } of list ?? []) {
      if (plugin.failed || !plugin.enabled) continue;
      try {
        // Observers get an independent decode, including independent Buffer
        // fields, so their mutations cannot affect hooks, verdicts or each other.
        const input = kind === 'observer'
          ? this.factory.createFromBytes(Buffer.from(packet.rawBytes), this.direction(packet.name))
          : packet;
        fn(client, input);
      } catch (error) {
        if (CREDENTIAL_PACKETS.has(packet.name)) {
          log.error(plugin.name, `${packet.name} ${kind} failed (details withheld: this packet carries credentials)`);
        } else {
          log.error(plugin.name, `${packet.name} ${kind} failed`, error);
        }
      }
    }
  }

  private runCommands(client: Client, packet: Packet): void {
    const text = typeof packet.data.text === 'string' ? packet.data.text : '';
    if (!text.startsWith('/')) return;
    const [command, ...args] = text.slice(1).trimEnd().toLowerCase().split(/\s+/);
    let consumed = false;
    for (const { plugin, fn } of this.commands.get(command) ?? []) {
      if (plugin.failed || !plugin.enabled) continue;
      try {
        fn(client, command, args);
        consumed = true;
      } catch (error) {
        log.error(plugin.name, `/${command} failed`, error);
      }
    }
    if (consumed) packet.send = false;
  }

  private verdict(event: PacketEvent, packet: Packet | null): Buffer | null {
    if (!packet) return event.data;
    if (packet.send === false) return null;
    if (!packet.modified) return event.data;
    try {
      return this.factory.serialize(packet);
    } catch (error) {
      const details = CREDENTIAL_PACKETS.has(packet.name)
        ? 'details withheld: this packet carries credentials'
        : describeError(error);
      log.warn('Plugins', `Could not apply a change to ${packet.name}; forwarding the original (${details})`);
      return event.data;
    }
  }
}
