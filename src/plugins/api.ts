import type { Packet } from '../protocol/Packet.ts';

export interface SettingOption {
  label: string;
  value: string;
}

/** Copied from realm-engine-client client/src/plugins/PluginContext.ts @ 88a66b2 (MIT, see NOTICE). */
export interface SettingDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'range' | 'select' | 'text' | 'button';
  value: unknown;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  help?: string;
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
export type Capability = 'packets' | 'commands' | 'notifications' | 'inject';

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

export interface PluginContext {
  readonly pluginId: string;
  name: string;
  category: string;
  /** Setting this always notifies onEnabledChange listeners, even if the value is unchanged. */
  enabled: boolean;
  registerSetting(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void;
  getSetting<T = any>(key: string): T;
  /** Validates, stores and notifies (even if unchanged). Buttons just notify with `true`. False if rejected. */
  updateSetting(key: string, value: unknown): boolean;
  hookPacket(name: string, fn: PacketHook, options?: { prepend?: boolean }): void;
  /** Read-only observer; mutations are ignored. */
  observePacket(name: string, fn: PacketHook): void;
  /** `name` without the slash, case-insensitive. Handlers get the lowercased command and lowercased args. */
  hookCommand(name: string, fn: CommandHook): void;
  on(event: ConnectionEvent, fn: (client: ClientConnection) => void): void;
  onEnabledChange(fn: (enabled: boolean) => void): void;
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
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
