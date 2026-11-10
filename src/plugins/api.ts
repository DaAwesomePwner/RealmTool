// Ported from realm-engine-client client/src/plugins/PluginContext.ts @ 88a66b2 (MIT, see NOTICE).
import type { Packet } from '../protocol/Packet.ts';
import type { PulseResult } from '../input/gameInput.ts';
export type { PulseResult } from '../input/gameInput.ts';

export interface SettingOption {
  label: string;
  value: string;
}

/** Declares one plugin setting and how a UI renders it. */
export interface SettingDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  value: unknown;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  help?: string;
  /** Display-only section heading: settings sharing a group show together in registration order; ungrouped ones share one unnamed section. Never affects validation, storage or profiles. */
  group?: string;
  /** Runtime-only input (e.g. a message preview); never saved to a profile. */
  transient?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: SettingOption[];
  visibleWhen?: { key: string; value: unknown };
  hidden?: boolean;
  advanced?: boolean;
  warnWhen?: { pluginId?: string; key: string; cmp: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'; message: string };
}

/** What a plugin may do. Context methods throw when a plugin uses a capability it didn't declare. */
export type Capability = 'packets' | 'commands' | 'notifications' | 'inject' | 'worker' | 'input';

export const PLUGIN_API_VERSION = 1;

export interface ServerInfo {
  host: string;
  port: number;
}

/** One game connection, as plugins see it. */
export interface ClientConnection {
  readonly clientId: string;
  readonly connected: boolean;
  /** Local player identity; name is '' until the server has sent it. */
  readonly playerData: { readonly name: string; readonly ownerObjectId: number };
  /** The real server this connection is routed to, once known. */
  readonly server: ServerInfo | null;
  /** Serialize and send a packet to the game. Throws PacketSerializeError for invalid data. */
  sendToClient(packet: Packet): void;
  /** Serialize and send a packet to the server. Throws PacketSerializeError for invalid data. */
  sendToServer(packet: Packet): void;
}

/** A verdict hook: may set `packet.send = false` (drop) or edit `packet.data` and set `packet.modified = true`. */
export type PacketHook = (client: ClientConnection, packet: Packet) => void;
export type CommandHook = (client: ClientConnection, command: string, args: string[]) => void;
export type ConnectionEvent = 'clientConnected' | 'clientDisconnected';

export type WorkerHealth =
  | { state: 'failing' | 'healthy'; since: number }
  | { configOk: boolean; reason?: string };

export interface WorkerChannel {
  /** Only this plugin's module health/config events, including while disabled.
   * Clients is a snapshot of currently connected clients. Removed on cleanup. */
  onHealth(handler: (event: WorkerHealth, clients: readonly ClientConnection[]) => void): void;
  /** Module-wide configuration for this plugin's worker module (module id = plugin id). Coalesced: while the host is starting or applying a profile only the last value per plugin is kept, and all plugins' values are sent in one batch. */
  configure(config: unknown): void;
  /** A message for this plugin's worker module instance on one game connection. Ignored when that client is no longer connected. */
  send(client: ClientConnection, message: unknown): void;
  /** Session messages from the worker module. Delivered while the plugin is disabled (status keeps flowing); removed on cleanup. */
  onMessage(handler: (client: ClientConnection, message: unknown) => void): void;
}

export interface InputApi {
  /** One down/up pulse to this session's own game window. Never throws. */
  pulse(client: ClientConnection): Promise<PulseResult>;
}

export interface PluginContext {
  readonly pluginId: string;
  /** Resolved Exalt installation directory, or null when unavailable. */
  readonly gameDir: string | null;
  /** Throws unless the plugin declares the worker capability. */
  readonly worker: WorkerChannel;
  /** Throws unless the plugin declares the input capability. */
  readonly input: InputApi;
  name: string;
  category: string;
  /** Setting this always notifies onEnabledChange listeners, even if the value is unchanged. */
  enabled: boolean;
  registerSetting(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void;
  getSetting<T = any>(key: string): T;
  /** Validates, stores and notifies (even if unchanged). Buttons just notify with `true`. False if rejected. */
  updateSetting(key: string, value: unknown): boolean;
  /**
   * Verdicts have a 250 ms deadline; expiry forwards the original unchanged (except registered commands) and ignores late answers.
   * RECONNECT/DEATH/MAPINFO/ESCAPE hooks run observe-only; mutations and drops are ignored.
   * PLAYERTEXT has the same deadline: expired registered commands are dropped by the worker.
   * ESCAPE also drops pending registered commands while releasing other queued frames.
   */
  hookPacket(name: string, fn: PacketHook, options?: { prepend?: boolean }): void;
  /** Read-only observer; mutations are ignored. */
  observePacket(name: string, fn: PacketHook): void;
  /** `name` without the slash, case-insensitive. Handlers get the lowercased command and lowercased args. */
  hookCommand(name: string, fn: CommandHook): void;
  on(event: ConnectionEvent, fn: (client: ClientConnection) => void): void;
  onEnabledChange(fn: (enabled: boolean) => void): void;
  /** Called after catalog publication, also while disabled; removed on cleanup. */
  onDataRefreshed(fn: () => void): void;
  /** Known stale data must be disarmed before a refresh or quiet-period wait. */
  onDataInvalidated(fn: (reason: string) => void): void;
  registerCleanup(fn: () => void): void;
  setData(key: string, value: unknown): void;
  broadcastData(type: string, data: unknown): void;
  createPacket(name: string): Packet;
  sendNotification(client: ClientConnection, sender: string, message: string): void;
  log(message: string): void;
}

export interface PluginSettingsPolicy {
  /** Return the value to store, or throw to reject. Replaces generic validation for this plugin. */
  validate?(key: string, value: unknown): unknown;
  /** Turn a saved settings object (or undefined when absent) into the full set to apply. Throw to reject it. */
  migrate?(saved: unknown, present: boolean): Record<string, unknown>;
}

export interface PluginDefinition {
  id: string;
  name: string;
  apiVersion: number;
  capabilities: readonly Capability[];
  register(ctx: PluginContext): void;
  settings?: PluginSettingsPolicy;
  /** Defaults to true. When false, profiles neither save nor restore enabled;
   * the initial state set by register is retained. Settings still persist. */
  persistEnabled?: boolean;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
