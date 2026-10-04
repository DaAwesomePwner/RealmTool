# RealmTool Phase 2 — Plugin Host, Chat Filter, Server Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins run inside RealmTool. A plugin host loads built-in plugins, routes packet verdicts, observations, chat commands and notifications through Phase 1's `ProxyHost`, and persists each plugin's enabled state and settings in an atomic profile file. Two plugins ship: **Chat Filter** (ported unchanged in behavior from realm-engine-client `88a66b2`) and **Server Switch** (`/con`, `/goto`, `/ip` chat commands).

**Architecture:** `PluginHost` (main thread) owns one `Plugin` context per definition and one `Client` facade per proxy session. It derives the worker's interest set from what the plugins registered: verdict hooks, observers, commands, plus the built-in identity tracker. For every verdict packet it decodes once, runs observers, then commands (client `PLAYERTEXT`), then hooks in registration order. It maps the outcome to exactly one `ProxyHost.forward()`: drop → `null`, modified → re-serialized, otherwise the original bytes. Settings live in a per-plugin `SettingsStore`. Its validation is generic, unless the plugin supplies `settings.validate`/`settings.migrate`. The `ProfileStore` writes `%APPDATA%\RealmTool\profiles\default.json` atomically and debounced.

**Tech Stack:** Same as Phase 1 (Node ≥ 22.18 native TypeScript, Vitest 3). No new runtime dependencies; Server Switch uses the global `fetch`.

**Spec:** [`docs/design.md`](../../design.md) §2.2 (plugin model), §2.4 (persistence), Phase 2 row. Port research: [`docs/research/05-phase2-port-details.md`](../../research/05-phase2-port-details.md).

## Global Constraints

- All Phase 1 constraints still apply: `.ts` import specifiers, erasable syntax only (no enums, namespaces or constructor parameter properties), `npm run check` green, Windows x64, listen only on 127.0.0.1, RC4 keys only in `src/protocol/constants.ts`.
- Built-in plugins live in `plugins/<id>/`. Their entry module's **default export** is a `PluginDefinition` made with `definePlugin(...)`. `plugins/index.ts` lists them in `BUILTIN_PLUGINS`.
- Plugin API version is `1` (`PLUGIN_API_VERSION`).
- Every packet that reaches the host as a verdict (`observeOnly: false`) is forwarded **exactly once**, even when a hook throws.
- The game **access token is never logged, never persisted and never stored beyond the call that uses it**.
- Chat Filter rules, normalization, defaults, labels and limits are ported **byte-for-byte in behavior** from realm-engine-client `88a66b2`. No rule edits.
- Profile files are written atomically (temp file → fsync → rename). An unreadable profile is preserved as `<file>.corrupt-<ms>` and the app starts from defaults.
- Ported files keep the header `// Ported from realm-engine-client <path> @ 88a66b2 (MIT, see NOTICE).`
- No Realm Engine DLL/IL2CPP code paths are ported (e.g. Server Switch's display sync is omitted).

## Review Focus

1. **A plugin hook throws while a verdict packet is held:** the packet is still forwarded, unchanged or as decided so far, and the session doesn't stall. Pinned in Task 5.
2. **The access token appears in any log line or profile file:** it must not. Pinned in Tasks 5 and 7 (log-sink assertion over a full HELLO → refresh failure path).
3. **The profile file is corrupt or half-written** (crash mid-save): RealmTool starts with defaults, keeps the bad file aside and never leaves a temp file as the profile. Pinned in Task 3.
4. **Chat command edge cases:** `/con` alone, `/CON USW`, `/goto 1.2.3.4:99999`, a leading space, an unknown command (must reach the server as normal chat), and a disabled plugin's command (must pass through). Pinned in Tasks 5 and 7.
5. **A plugin's `register()` throws:** that plugin is disabled with a logged error, its partial hooks are removed from the interest set, and every other plugin keeps working. Pinned in Task 5.

---

## File Structure

```
src/transport/session.ts            (mod) HELLO observable (T1)
src/transport/host.ts               (mod) setInterest() remembered for start() (T5)
src/protocol/PacketFactory.ts       (mod) getPacketDirection(name) (T5)
src/plugins/api.ts                  public plugin API types + definePlugin (T2)
src/plugins/settings.ts             SettingsStore + generic validation (T2)
src/config/store.ts                 appDataDir, writeJsonAtomic, ProfileStore (T3)
src/plugins/identity.ts             PlayerIdentity (local name/objectId) (T4)
src/plugins/host.ts                 PluginHost, Plugin context, Client facade (T5)
src/testing/pluginHarness.ts        FakeProxy + startHost test harness (T5)
plugins/index.ts                    BUILTIN_PLUGINS (T5 creates empty, T6/T7 add)
plugins/chat-filter/*               ported Chat Filter + tests (T6)
plugins/server-switch/*             Server Switch + tests (T7)
data/servers.json                   fallback server directory (T7)
src/cli.ts                          wiring, config-path command (T8)
```

`vitest.config.ts` and `tsconfig.json` gain `plugins/**` in Task 5.

## Execution lanes

| Wave | Lane A (main folder) | Lane B (worktree) | Lane C (worktree) |
|---|---|---|---|
| 1 | T1 | T2 | T3 → T4 |
| 2 | T5 (after merging T1–T4) | — | — |
| 3 | — | T6 | T7 |
| 4 | T8 (after merging T6, T7) | — | — |

---

### Task 1: Make HELLO observable (read-only)

**Files:**
- Modify: `src/transport/session.ts` (`routeHello`)
- Test: `src/transport/__tests__/session.test.ts` (add 2 tests)

**Interfaces:**
- Produces: when `interest.classify('HELLO', true) !== 'none'`, the worker posts `{ type: 'packet', id, sequence: 0, generation, fromClient: true, observeOnly: true, data: <the game's original HELLO frame> }` once per session, after `routed` and before connecting upstream. A verdict interest in HELLO is treated as observe. The worker routes HELLO itself, so the main thread never decides on it. `sequence: 0` is never used for verdict packets (they start at 1), so `forward()` must never be called for it.

- [ ] **Step 1: Write the failing tests** (append inside `describe('Session', ...)`)

```ts
  it('lets the main thread observe the HELLO it routed, read-only', async () => {
    const h = await harness({ interest: new Interest({ verdict: { client: ['HELLO'] } }) });
    const server = await fakeServer();
    const { upstream } = await connected(h, server);
    const hellos = packets(h).filter(e => e.fromClient && factory.getPacketName(e.data[4], 'client') === 'HELLO');
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toMatchObject({ sequence: 0, observeOnly: true });
    expect(Buffer.from(hellos[0].data).equals(upstream.frames[0])).toBe(true);
  });

  it('does not post HELLO when nobody is interested', async () => {
    const h = await harness();
    const server = await fakeServer();
    await connected(h, server);
    expect(packets(h)).toHaveLength(0);
  });
```

- [ ] **Step 2: Run and watch the first fail**

Run: `npx vitest run src/transport/__tests__/session.test.ts`
Expected: the "observe the HELLO" test fails (0 HELLO events).

- [ ] **Step 3: Implement.** In `routeHello`, right after the `this.env.post({ type: 'routed', ... })` line and before `this.connect(...)`, add:

```ts
    if (this.env.interest.classify('HELLO', true) !== 'none') {
      // HELLO is routed by the worker; the main thread may read it (e.g. the access token) but never decide on it.
      this.env.post({ type: 'packet', id: this.id, sequence: 0, generation: this.generation, fromClient: true, observeOnly: true, data: frame });
    }
```

- [ ] **Step 4: Run** `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(transport): expose the routed HELLO to observers (read-only)`

---

### Task 2: Plugin API types and settings store

**Files:**
- Create: `src/plugins/api.ts`, `src/plugins/settings.ts`
- Test: `src/plugins/__tests__/settings.test.ts`

**Interfaces:**
- Produces (exact names; Tasks 5–7 rely on them): `SettingOption`, `SettingDef`, `Capability`, `PLUGIN_API_VERSION`, `ServerInfo`, `ClientConnection`, `PacketHook`, `CommandHook`, `ConnectionEvent`, `PluginContext`, `PluginSettingsPolicy`, `PluginDefinition`, `definePlugin`; `SettingsStore`, `validateSetting`.

- [ ] **Step 1: Write `src/plugins/api.ts`** (types only, plus `definePlugin`)

```ts
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
```

- [ ] **Step 2: Write the failing settings tests** in `src/plugins/__tests__/settings.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, validateSetting } from '../settings.ts';
import type { SettingDef } from '../api.ts';

const def = (over: Partial<SettingDef>): SettingDef => ({ key: 'k', label: 'K', type: 'text', value: '', ...over });

describe('validateSetting', () => {
  it('checks types, bounds, options and length', () => {
    expect(validateSetting(def({ type: 'boolean', value: false }), true)).toBe(true);
    expect(() => validateSetting(def({ type: 'boolean', value: false }), 'yes')).toThrow();
    expect(validateSetting(def({ type: 'number', value: 1, min: 0, max: 10 }), 10)).toBe(10);
    expect(() => validateSetting(def({ type: 'number', value: 1, min: 0, max: 10 }), 11)).toThrow();
    expect(() => validateSetting(def({ type: 'range', value: 1 }), Number.NaN)).toThrow();
    expect(validateSetting(def({ type: 'select', value: 'a', options: [{ label: 'A', value: 'a' }] }), 'a')).toBe('a');
    expect(() => validateSetting(def({ type: 'select', value: 'a', options: [{ label: 'A', value: 'a' }] }), 'b')).toThrow();
    expect(() => validateSetting(def({ type: 'text', value: '', maxLength: 3 }), 'abcd')).toThrow();
  });
});

describe('SettingsStore', () => {
  it('stores defaults, notifies on every accepted update, and rejects invalid values', () => {
    const store = new SettingsStore();
    const seen = vi.fn();
    store.register('count', { label: 'Count', type: 'number', value: 3, min: 1, max: 5 }, seen);
    expect(store.get('count')).toBe(3);
    expect(seen).not.toHaveBeenCalled();
    expect(store.update('count', 4)).toBe(true);
    expect(store.update('count', 4)).toBe(true);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.update('count', 9)).toBe(false);
    expect(store.get('count')).toBe(4);
    expect(store.update('missing', 1)).toBe(false);
  });

  it('runs buttons without storing them and leaves buttons and transients out of persistable values', () => {
    const store = new SettingsStore();
    const pressed = vi.fn();
    store.register('go', { label: 'Go', type: 'button', value: undefined }, pressed);
    store.register('draft', { label: 'Draft', type: 'text', value: '', transient: true });
    store.register('keep', { label: 'Keep', type: 'boolean', value: true });
    expect(store.update('go', 'anything')).toBe(true);
    expect(pressed).toHaveBeenCalledWith(true);
    expect(store.persistable()).toEqual({ keep: true });
  });

  it('uses a plugin validator instead of generic validation', () => {
    const store = new SettingsStore((key, value) => {
      if (key !== 'mode' || (value !== 'x' && value !== 'y')) throw new Error('bad');
      return value;
    });
    store.register('mode', { label: 'Mode', type: 'text', value: 'x' });
    expect(store.update('mode', 'y')).toBe(true);
    expect(store.update('mode', 'z')).toBe(false);
  });

  it('reports any change through onChange and isolates callback errors', () => {
    const changed = vi.fn();
    const store = new SettingsStore(undefined, changed);
    store.register('a', { label: 'A', type: 'boolean', value: false }, () => { throw new Error('boom'); });
    expect(store.update('a', true)).toBe(true);
    expect(store.get('a')).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate registration', () => {
    const store = new SettingsStore();
    store.register('a', { label: 'A', type: 'boolean', value: false });
    expect(() => store.register('a', { label: 'A', type: 'boolean', value: false })).toThrow('already registered');
  });
});
```

- [ ] **Step 3: Run and watch them fail.** Run: `npx vitest run src/plugins`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/plugins/settings.ts`**

```ts
import { log } from '../util/log.ts';
import type { SettingDef } from './api.ts';

/** Generic validation from the setting's declaration. Returns the value to store or throws. */
export function validateSetting(def: SettingDef, value: unknown): unknown {
  const fail = (): never => { throw new Error(`Invalid value for ${def.key}`); };
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : fail();
    case 'number':
    case 'range':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail();
      if (def.min !== undefined && (value as number) < def.min) fail();
      if (def.max !== undefined && (value as number) > def.max) fail();
      return value;
    case 'select':
      return typeof value === 'string' && (def.options ?? []).some(option => option.value === value) ? value : fail();
    case 'text':
      if (typeof value !== 'string') fail();
      if (def.maxLength !== undefined && (value as string).length > def.maxLength) fail();
      return value;
    default:
      return fail();
  }
}

type Validator = (key: string, value: unknown) => unknown;

/** One plugin's settings: declarations, current values and change callbacks. */
export class SettingsStore {
  private readonly defs = new Map<string, SettingDef>();
  private readonly values = new Map<string, unknown>();
  private readonly callbacks = new Map<string, ((value: any) => void)[]>();
  private readonly validator: Validator | undefined;
  private readonly onChange: (() => void) | undefined;

  constructor(validator?: Validator, onChange?: () => void) {
    this.validator = validator;
    this.onChange = onChange;
  }

  register(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void {
    if (this.defs.has(key)) throw new Error(`Setting ${key} is already registered`);
    this.defs.set(key, { ...def, key });
    if (def.type !== 'button') this.values.set(key, def.value);
    if (onChange) this.callbacks.set(key, [onChange]);
  }

  definition(key: string): SettingDef | undefined {
    return this.defs.get(key);
  }

  definitions(): SettingDef[] {
    return [...this.defs.values()].map(def => ({ ...def, value: def.type === 'button' ? undefined : this.values.get(def.key) }));
  }

  get<T = unknown>(key: string): T {
    return this.values.get(key) as T;
  }

  update(key: string, value: unknown): boolean {
    const def = this.defs.get(key);
    if (!def) return false;
    if (def.type === 'button') {
      this.fire(key, true);
      return true;
    }
    let next: unknown;
    try {
      next = this.validator ? this.validator(key, value) : validateSetting(def, value);
    } catch {
      return false;
    }
    this.values.set(key, next);
    this.fire(key, next);
    this.onChange?.();
    return true;
  }

  /** Values a profile should save: everything except buttons and transient inputs. */
  persistable(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const def of this.defs.values()) {
      if (def.type === 'button' || def.transient) continue;
      out[def.key] = this.values.get(def.key);
    }
    return out;
  }

  private fire(key: string, value: unknown): void {
    for (const callback of this.callbacks.get(key) ?? []) {
      try {
        callback(value);
      } catch (error) {
        log.error('Settings', `Setting ${key} callback failed`, error);
      }
    }
  }
}
```

- [ ] **Step 5: Run** `npm run check`. Expected: all pass.

- [ ] **Step 6: Commit** `feat(plugins): plugin API types and settings store`

---

### Task 3: Profile store (atomic, debounced, corruption-safe)

**Files:**
- Create: `src/config/store.ts`
- Test: `src/config/__tests__/store.test.ts`

**Interfaces:**
- Produces: `PROFILE_SCHEMA_VERSION = 1`, `PluginProfileEntry { enabled?: boolean; settings?: Record<string, unknown> }`, `Profile { schemaVersion: number; plugins: Record<string, PluginProfileEntry> }`, `appDataDir(env?)`, `emptyProfile()`, `writeJsonAtomic(path, value)`, `normalizeProfile(value)`, `ProfileStore { constructor({ dir, name?, debounceMs? }); readonly path; load(): Profile; scheduleSave(profile): void; flush(): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDataDir, emptyProfile, normalizeProfile, ProfileStore, writeJsonAtomic } from '../store.ts';
import { log, type LogRecord } from '../../util/log.ts';

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'realmtool-config-')); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('config store', () => {
  it('resolves the app data folder from APPDATA', () => {
    expect(appDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'RealmTool'));
  });

  it('writes JSON atomically and leaves no temp file', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'a.json');
    writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['a.json']);
  });

  it('loads a missing profile as empty', () => {
    expect(new ProfileStore({ dir: tempDir() }).load()).toEqual(emptyProfile());
  });

  it('keeps a corrupt profile aside and starts from defaults', () => {
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(store.path, '{ not json');
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      expect(store.load()).toEqual(emptyProfile());
    } finally { remove(); log.setConsole(true); }
    expect(existsSync(store.path)).toBe(false);
    expect(readdirSync(join(dir, 'profiles')).some(n => n.startsWith('default.json.corrupt-'))).toBe(true);
    expect(records.some(r => r.level === 'warn')).toBe(true);
  });

  it('drops malformed entries but keeps valid ones, tolerating a BOM', () => {
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(store.path, '\uFEFF' + JSON.stringify({ schemaVersion: 1, plugins: {
      good: { enabled: false, settings: { x: 1 } }, bad: 5, partial: { enabled: 'yes', settings: [] },
    } }));
    log.setConsole(false);
    try {
      expect(store.load().plugins).toEqual({ good: { enabled: false, settings: { x: 1 } }, partial: {} });
    } finally { log.setConsole(true); }
  });

  it('rejects a non-object profile', () => {
    expect(() => normalizeProfile([])).toThrow();
    expect(() => normalizeProfile({ plugins: 'x' })).toThrow();
  });

  it('debounces saves and flushes the latest profile', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const store = new ProfileStore({ dir, debounceMs: 800 });
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: true } } });
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: false } } });
    expect(existsSync(store.path)).toBe(false);
    vi.advanceTimersByTime(800);
    expect(JSON.parse(readFileSync(store.path, 'utf8')).plugins.a.enabled).toBe(false);
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: true } } });
    store.flush();
    expect(JSON.parse(readFileSync(store.path, 'utf8')).plugins.a.enabled).toBe(true);
    store.flush();
  });
});
```

- [ ] **Step 2: Run and watch them fail.** `npx vitest run src/config`. Expected: module not found.

- [ ] **Step 3: Implement `src/config/store.ts`**

```ts
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../util/log.ts';

export const PROFILE_SCHEMA_VERSION = 1;

export interface PluginProfileEntry {
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export interface Profile {
  schemaVersion: number;
  plugins: Record<string, PluginProfileEntry>;
}

export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'RealmTool');
}

export function emptyProfile(): Profile {
  return { schemaVersion: PROFILE_SCHEMA_VERSION, plugins: {} };
}

/** Write via a temp file in the same folder, fsync, then rename over the target. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeProfile(value: unknown): Profile {
  if (!isRecord(value)) throw new Error('profile is not an object');
  const profile = emptyProfile();
  if (value.plugins === undefined) return profile;
  if (!isRecord(value.plugins)) throw new Error('profile.plugins is not an object');
  for (const [id, entry] of Object.entries(value.plugins)) {
    if (!isRecord(entry)) {
      log.warn('Config', `Ignoring invalid profile entry for ${id}`);
      continue;
    }
    const next: PluginProfileEntry = {};
    if (typeof entry.enabled === 'boolean') next.enabled = entry.enabled;
    if (isRecord(entry.settings)) next.settings = entry.settings;
    profile.plugins[id] = next;
  }
  return profile;
}

export interface ProfileStoreOptions {
  dir: string;
  name?: string;
  debounceMs?: number;
}

export class ProfileStore {
  readonly path: string;
  private readonly debounceMs: number;
  private pending: Profile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProfileStoreOptions) {
    this.path = join(options.dir, 'profiles', `${options.name ?? 'default'}.json`);
    this.debounceMs = options.debounceMs ?? 800;
  }

  load(): Profile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProfile();
      throw error;
    }
    try {
      return normalizeProfile(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, backup); } catch { /* keep going with defaults either way */ }
      log.warn('Config', `Profile ${this.path} is unreadable (${(error as Error).message}); kept it as ${backup} and started from defaults`);
      return emptyProfile();
    }
  }

  scheduleSave(profile: Profile): void {
    this.pending = profile;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const profile = this.pending;
    this.pending = null;
    if (!profile) return;
    try {
      writeJsonAtomic(this.path, profile);
    } catch (error) {
      log.error('Config', `Could not save ${this.path}`, error);
    }
  }
}
```

- [ ] **Step 4: Run** `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(config): atomic, debounced profile store`

---

### Task 4: Local player identity

**Files:**
- Create: `src/plugins/identity.ts`
- Test: `src/plugins/__tests__/identity.test.ts`

**Interfaces:**
- Produces: `NAME_STAT = 31`, `IDENTITY_PACKETS: ReadonlySet<string>` (`CREATESUCCESS`, `UPDATE`, `NEWTICK`), `class PlayerIdentity { name: string; ownerObjectId: number; observe(packet: Packet): void }`.
- Schema facts: `CREATESUCCESS.objectId`; `UPDATE.newObjs[]` = `{ objectType, status }`; `NEWTICK.statuses[]` = `Status`; `Status` = `{ objectId, position, data: StatData[] }`; `StatData` = `{ id, value, stackCount }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { createPacket } from '../../protocol/Packet.ts';
import { IDENTITY_PACKETS, NAME_STAT, PlayerIdentity } from '../identity.ts';

const packet = (name: string, data: Record<string, unknown>) => {
  const p = createPacket(1, name, 'server');
  p.isDefined = true;
  p.data = data;
  return p;
};
const status = (objectId: number, stats: { id: number; value: unknown }[]) =>
  ({ objectId, position: { x: 0, y: 0 }, data: stats.map(s => ({ ...s, stackCount: 0 })) });

describe('PlayerIdentity', () => {
  it('learns the owner object from CREATESUCCESS and the name from its own status only', () => {
    const id = new PlayerIdentity();
    id.observe(packet('CREATESUCCESS', { objectId: 77, charId: 1, stats: '' }));
    expect(id).toMatchObject({ ownerObjectId: 77, name: '' });
    id.observe(packet('UPDATE', { newObjs: [
      { objectType: 1, status: status(12, [{ id: NAME_STAT, value: 'Someone' }]) },
      { objectType: 2, status: status(77, [{ id: 0, value: 500 }, { id: NAME_STAT, value: 'Me' }]) },
    ] }));
    expect(id.name).toBe('Me');
    id.observe(packet('NEWTICK', { statuses: [status(77, [{ id: NAME_STAT, value: 'MeRenamed' }])] }));
    expect(id.name).toBe('MeRenamed');
  });

  it('ignores names before CREATESUCCESS, bad shapes and empty names, and resets on a new CREATESUCCESS', () => {
    const id = new PlayerIdentity();
    id.observe(packet('NEWTICK', { statuses: [status(0, [{ id: NAME_STAT, value: 'Ghost' }])] }));
    expect(id.name).toBe('');
    id.observe(packet('CREATESUCCESS', { objectId: 5 }));
    id.observe(packet('UPDATE', { newObjs: [null, { status: null }, { status: status(5, [{ id: NAME_STAT, value: '' }]) }] }));
    expect(id.name).toBe('');
    id.observe(packet('NEWTICK', { statuses: [status(5, [{ id: NAME_STAT, value: 'Me' }])] }));
    id.observe(packet('CREATESUCCESS', { objectId: 9 }));
    expect(id).toMatchObject({ ownerObjectId: 9, name: '' });
  });

  it('lists the packets it needs', () => {
    expect([...IDENTITY_PACKETS].sort()).toEqual(['CREATESUCCESS', 'NEWTICK', 'UPDATE']);
  });
});
```

- [ ] **Step 2: Run and watch them fail.** `npx vitest run src/plugins/__tests__/identity.test.ts`

- [ ] **Step 3: Implement `src/plugins/identity.ts`**

```ts
import type { Packet } from '../protocol/Packet.ts';

/** StatType NameStat in realm-engine-client client/src/constants/StatType.ts @ 88a66b2. */
export const NAME_STAT = 31;
export const IDENTITY_PACKETS: ReadonlySet<string> = new Set(['CREATESUCCESS', 'UPDATE', 'NEWTICK']);

interface StatusLike { objectId?: unknown; data?: unknown }

/** The local player's object id and name, learned from the server stream. */
export class PlayerIdentity {
  name = '';
  ownerObjectId = 0;

  observe(packet: Packet): void {
    if (!packet.isDefined) return;
    if (packet.name === 'CREATESUCCESS') {
      const objectId = Number(packet.data.objectId);
      this.ownerObjectId = Number.isInteger(objectId) && objectId > 0 ? objectId : 0;
      this.name = '';
      return;
    }
    if (!this.ownerObjectId) return;
    if (packet.name === 'UPDATE' && Array.isArray(packet.data.newObjs)) {
      for (const entity of packet.data.newObjs) this.status(entity?.status);
    } else if (packet.name === 'NEWTICK' && Array.isArray(packet.data.statuses)) {
      for (const status of packet.data.statuses) this.status(status);
    }
  }

  private status(status: StatusLike | null | undefined): void {
    if (!status || status.objectId !== this.ownerObjectId || !Array.isArray(status.data)) return;
    for (const stat of status.data) {
      if (stat?.id === NAME_STAT && typeof stat.value === 'string' && stat.value) this.name = stat.value;
    }
  }
}
```

- [ ] **Step 4: Run** `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit** `feat(plugins): track the local player's object id and name`

---

### Task 5: Plugin host

**Files:**
- Modify: `src/protocol/PacketFactory.ts` (add `getPacketDirection`), `src/transport/host.ts` (`setInterest` remembers the spec), `vitest.config.ts`, `tsconfig.json`
- Create: `src/plugins/host.ts`, `src/testing/pluginHarness.ts`, `plugins/index.ts`
- Test: `src/plugins/__tests__/host.test.ts`, `src/protocol/__tests__/schema.test.ts` (one added assertion)

**Interfaces:**
- Consumes: T1–T4 exactly as defined above; `ProxyHost`/`HostEvents`/`PacketEvent` from Phase 1.
- Produces:
  - `PacketFactory.getPacketDirection(name: string): PacketDirection | undefined`.
  - `ProxyHost.setInterest()` also stores the spec, so a later `start()` uses it.
  - `type ProxyLike = Pick<ProxyHost, 'on' | 'off' | 'setInterest' | 'forward' | 'inject'>`.
  - `interface PluginHostOptions { proxy: ProxyLike; factory: PacketFactory; definitions: readonly PluginDefinition[]; profile: ProfileStore; onData?: (pluginId: string, type: string, data: unknown) => void }`.
  - `class PluginHost { start(): InterestSpec; stop(): void; loaded(): string[]; context(id): PluginContext | undefined; data(id): ReadonlyMap<string, unknown> | undefined }`.
  - `BUILTIN_PLUGINS: readonly PluginDefinition[]` (empty here; T6/T7 add entries).
  - Test harness: `FakeProxy`, `startHost(definitions, options?)` returning `{ host, proxy, factory, profile, profileDir, connect(id?), route(id, host, port), close(id), packet(id, name, data, options?) }`.
- Behavior contract:
  - **Start:** load the profile. For each definition in order: reject a duplicate id or `apiVersion !== 1` (log the error and skip). Create the context and call `register(ctx)`. If register throws, log the error, remove that plugin's hooks, observers, commands and listeners, and mark it failed (not loaded). Otherwise apply the profile entry:
    - `settings.migrate(entry?.settings, entry !== undefined)` when defined. If it throws, warn and use `migrate(undefined, false)`.
    - Otherwise use the saved settings as-is.
    - Apply each non-button, non-transient key through `updateSetting`, warning on rejected values.
    - Then, if the entry has a boolean `enabled`, assign it.
    - Saves are suppressed while applying.
    - Finally compute the interest, call `proxy.setInterest`, and subscribe to proxy events.
  - **Interest:** verdict = every `hookPacket` name, plus client `PLAYERTEXT` when any command is registered; observe = every `observePacket` name plus `IDENTITY_PACKETS`. Each name goes to its own direction via `getPacketDirection`. `hookPacket`/`observePacket` with an unknown name throws inside register. Registering after start recomputes and re-sends the interest.
  - **Packet event:**
    1. Decode with `createFromBytes(data, fromClient ? 'client' : 'server')`.
    2. Server `IDENTITY_PACKETS` update that client's identity.
    3. Run observers (enabled plugins only, each in try/catch).
    4. If not `observeOnly`: client `PLAYERTEXT` runs the commands, then the hooks run in order (prepend → front), enabled only, each in try/catch, and all of them run even after a drop.
    5. The `finally` always calls `forward()` exactly once for non-observe events: `send === false` → `null`; `modified` → `serialize()`, or on throw the original bytes plus a warning; otherwise the original bytes.
    6. Unknown client ids pass through unchanged.
  - **Commands:**
    - Parsing matches Realm Engine: a text starting with `/` gives `parts = text.slice(1).trimEnd().toLowerCase().split(/\s+/)`, where `parts[0]` is the command and the rest are args.
    - Every enabled handler runs.
    - The packet is consumed (`send = false`) only if at least one handler finished without throwing.
    - Unknown commands, or commands whose handlers are all disabled, pass through.
  - **Notifications:** TEXT with `{ name: sender, objectId: -1, numStars: -1, bubbleTime: 0, recipient: '', text: message, cleanText: message, isSupporter: false, starBg: 0 }`, injected to the client.
  - **Client facade:** created on `session`, `server` set on `routed`. On `closed` it's marked disconnected, `clientDisconnected` fires for enabled plugins, and it's removed. `sendToClient`/`sendToServer` serialize and `inject`, and are no-ops once disconnected.
  - **Capabilities:**
    - `hookPacket`/`observePacket` need `packets`.
    - `hookCommand` needs `commands`.
    - `sendNotification` needs `notifications`.
    - `createPacket` needs `inject`.
    - Otherwise it throws `Error('<plugin> did not declare the "<cap>" capability')`.
  - **Persistence:** any accepted setting update, or any `enabled` assignment after start, schedules a save. The snapshot is `{ schemaVersion: 1, plugins: { ...loaded profile entries for unknown ids, [id]: { enabled, settings: persistable() } } }`. `stop()` runs cleanups (try/catch), unsubscribes and flushes.

- [ ] **Step 1: Small production changes**

`src/protocol/PacketFactory.ts`, below `getPacketId`:
```ts
  /** Direction of the packet with this name, if defined. */
  getPacketDirection(name: string): PacketDirection | undefined {
    return this.nameToPacket.get(name)?.def.direction;
  }
```
Add to `schema.test.ts`'s first test: `expect(factory.getPacketDirection('TEXT')).toBe('server'); expect(factory.getPacketDirection('PLAYERTEXT')).toBe('client'); expect(factory.getPacketDirection('NOPE')).toBeUndefined();`

`src/transport/host.ts`, replace `setInterest`:
```ts
  setInterest(interest: InterestSpec): void {
    this.options.interest = interest;
    this.send({ type: 'interest', interest });
  }
```

`vitest.config.ts`: `include: ['src/**/__tests__/**/*.test.ts', 'plugins/**/__tests__/**/*.test.ts']`. `tsconfig.json`: `"include": ["src", "plugins", "tools", "vitest.config.ts"]`.

`plugins/index.ts`:
```ts
import type { PluginDefinition } from '../src/plugins/api.ts';

/** Built-in plugins, loaded in this order. */
export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [];
```

- [ ] **Step 2: Write the test harness `src/testing/pluginHarness.ts`**

```ts
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../config/store.ts';
import type { PluginDefinition } from '../plugins/api.ts';
import { PluginHost } from '../plugins/host.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import { createFactory } from '../protocol/schema.ts';
import type { HostEvents } from '../transport/host.ts';
import type { InterestSpec } from '../transport/interest.ts';

export interface Forwarded { id: string; sequence: number; generation: number; data: Buffer | null }
export interface Injected { id: string; data: Buffer; toClient: boolean }

/** Stands in for ProxyHost: records interest, verdicts and injections; tests emit its events. */
export class FakeProxy extends EventEmitter<HostEvents> {
  interest: InterestSpec = {};
  readonly forwards: Forwarded[] = [];
  readonly injected: Injected[] = [];
  setInterest(interest: InterestSpec): void { this.interest = interest; }
  forward(id: string, sequence: number, generation: number, data: Buffer | null): void { this.forwards.push({ id, sequence, generation, data }); }
  inject(id: string, data: Buffer, toClient: boolean): void { this.injected.push({ id, data, toClient }); }
}

export interface PacketOptions { observeOnly?: boolean }

export function startHost(definitions: readonly PluginDefinition[], options: { profileDir?: string; factory?: PacketFactory } = {}) {
  const proxy = new FakeProxy();
  const factory = options.factory ?? createFactory();
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), 'realmtool-plugins-'));
  const profile = new ProfileStore({ dir: profileDir, debounceMs: 0 });
  const host = new PluginHost({ proxy, factory, definitions, profile });
  host.start();
  let sequence = 0;
  return {
    host, proxy, factory, profile, profileDir,
    connect(id = 'c1'): string { proxy.emit('session', { id, remotePort: 50000 }); return id; },
    route(id: string, server: string, port = 2050): void { proxy.emit('routed', { id, host: server, port, restored: false }); },
    close(id: string): void { proxy.emit('closed', { id, by: 'game' }); },
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
```

- [ ] **Step 3: Write the failing host tests** (`src/plugins/__tests__/host.test.ts`)

```ts
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginContext, type PluginDefinition } from '../api.ts';
import { log, type LogRecord } from '../../util/log.ts';
import { startHost, textData, type Harness } from '../../testing/pluginHarness.ts';

const records: LogRecord[] = [];
let removeSink: () => void = () => {};
afterEach(() => { removeSink(); log.setConsole(true); records.length = 0; });
function quietLogs() { log.setConsole(false); removeSink = log.addSink(r => records.push(r)); }

const plugin = (id: string, register: (ctx: PluginContext) => void, extra: Partial<PluginDefinition> = {}) =>
  definePlugin({ id, name: id, apiVersion: 1, capabilities: ['packets', 'commands', 'notifications', 'inject'], register, ...extra });
const decode = (h: Harness, data: Buffer | null, dir: 'client' | 'server') => h.factory.createFromBytes(data!, dir);

describe('PluginHost', () => {
  it('maps hook outcomes to exactly one verdict: pass, drop, modify', () => {
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, p) => {
      if (p.data.text === 'drop') p.send = false;
      if (p.data.text === 'edit') { p.data.text = 'edited'; p.data.cleanText = 'edited'; p.modified = true; }
    }))]);
    const id = h.connect();
    const pass = h.packet(id, 'TEXT', textData({ text: 'hi' }))!;
    expect(decode(h, pass.data, 'server').data.text).toBe('hi');
    expect(h.packet(id, 'TEXT', textData({ text: 'drop' }))!.data).toBeNull();
    expect(decode(h, h.packet(id, 'TEXT', textData({ text: 'edit' }))!.data, 'server').data.text).toBe('edited');
    expect(h.proxy.forwards).toHaveLength(3);
  });

  it('still forwards once when a hook throws, and runs later hooks after a drop', () => {
    quietLogs();
    const later = vi.fn();
    const h = startHost([plugin('p', ctx => {
      ctx.hookPacket('TEXT', () => { throw new Error('boom'); });
      ctx.hookPacket('TEXT', (_c, p) => { p.send = false; });
      ctx.hookPacket('TEXT', later);
    })]);
    const id = h.connect();
    expect(h.packet(id, 'TEXT', textData())!.data).toBeNull();
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.proxy.forwards).toHaveLength(1);
    expect(records.some(r => r.level === 'error' && r.message.includes('boom'))).toBe(true);
  });

  it('forwards the original bytes when a modification cannot be serialized', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, p) => { p.data.objectId = {} as never; p.modified = true; }))]);
    const id = h.connect();
    const verdict = h.packet(id, 'TEXT', textData({ text: 'keep' }))!;
    expect(decode(h, verdict.data, 'server').data.text).toBe('keep');
    expect(records.some(r => r.level === 'warn')).toBe(true);
  });

  it('runs observers on observe-only events and never forwards them', () => {
    const seen = vi.fn();
    const h = startHost([plugin('p', ctx => ctx.observePacket('HELLO', (_c, p) => seen(p.data.accessToken)))]);
    const id = h.connect();
    h.packet(id, 'HELLO', { gameId: -2, buildVersion: 'b', accessToken: 'secret-token', keyTime: -1, key: Buffer.alloc(0), gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: '', userToken: '', clientIdentification: '' }, { observeOnly: true });
    expect(seen).toHaveBeenCalledWith('secret-token');
    expect(h.proxy.forwards).toHaveLength(0);
  });

  it('builds interest from hooks, observers, commands and identity', () => {
    const h = startHost([plugin('p', ctx => {
      ctx.hookPacket('TEXT', () => {});
      ctx.observePacket('HELLO', () => {});
      ctx.hookCommand('con', () => {});
    })]);
    expect(h.proxy.interest.verdict).toEqual({ client: ['PLAYERTEXT'], server: ['TEXT'] });
    expect([...(h.proxy.interest.observe?.client ?? [])]).toEqual(['HELLO']);
    expect([...(h.proxy.interest.observe?.server ?? [])].sort()).toEqual(['CREATESUCCESS', 'NEWTICK', 'UPDATE']);
  });

  it('consumes handled commands with lowercased args and passes unknown or disabled ones through', () => {
    quietLogs();
    const calls: string[][] = [];
    const h = startHost([plugin('p', ctx => {
      ctx.hookCommand('/CON', (_c, command, args) => calls.push([command, ...args]));
      ctx.hookCommand('broken', () => { throw new Error('nope'); });
    })]);
    const id = h.connect();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/CON USWest  ' })!.data).toBeNull();
    expect(calls).toEqual([['con', 'uswest']]);
    expect(h.packet(id, 'PLAYERTEXT', { text: '/unknown x' })!.data).not.toBeNull();
    expect(h.packet(id, 'PLAYERTEXT', { text: ' /con usw' })!.data).not.toBeNull();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/broken' })!.data).not.toBeNull();
    h.host.context('p')!.enabled = false;
    expect(h.packet(id, 'PLAYERTEXT', { text: '/con usw' })!.data).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('skips a disabled plugin\'s hooks and listeners', () => {
    const hook = vi.fn();
    const connected = vi.fn();
    const h = startHost([plugin('p', ctx => { ctx.hookPacket('TEXT', hook); ctx.on('clientConnected', connected); })]);
    h.host.context('p')!.enabled = false;
    const id = h.connect();
    expect(h.packet(id, 'TEXT', textData())!.data).not.toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  });

  it('sends notifications as TEXT with the Realm Engine field values', () => {
    let send: (() => void) | undefined;
    const h = startHost([plugin('p', ctx => ctx.on('clientConnected', client => { send = () => ctx.sendNotification(client, 'Server Switch', 'hi there'); }))]);
    h.connect();
    send!();
    expect(h.proxy.injected).toHaveLength(1);
    expect(h.proxy.injected[0].toClient).toBe(true);
    expect(decode(h, h.proxy.injected[0].data, 'server').data).toEqual({
      name: 'Server Switch', objectId: -1, numStars: -1, bubbleTime: 0, recipient: '', text: 'hi there', cleanText: 'hi there', isSupporter: false, starBg: 0,
    });
  });

  it('tracks identity, server and lifecycle on the client facade', () => {
    const events: string[] = [];
    let client: import('../api.ts').ClientConnection | undefined;
    const h = startHost([plugin('p', ctx => {
      ctx.on('clientConnected', c => { client = c; events.push('up'); });
      ctx.on('clientDisconnected', () => events.push('down'));
    })]);
    const id = h.connect();
    h.route(id, '1.2.3.4');
    h.packet(id, 'CREATESUCCESS', { objectId: 42, charId: 1, stats: '' });
    h.packet(id, 'NEWTICK', { tickId: 1, tickTime: 0, serverRealTimeMs: 0, serverLastRttMs: 0, statuses: [{ objectId: 42, position: { x: 0, y: 0 }, data: [{ id: 31, value: 'Me', stackCount: 0 }] }] });
    expect(client!.playerData).toEqual({ name: 'Me', ownerObjectId: 42 });
    expect(client!.server).toEqual({ host: '1.2.3.4', port: 2050 });
    h.close(id);
    expect(client!.connected).toBe(false);
    expect(events).toEqual(['up', 'down']);
  });

  it('enforces declared capabilities', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookCommand('x', () => {}), { capabilities: ['packets'] })]);
    expect(h.host.loaded()).toEqual([]);
    expect(records.some(r => r.level === 'error' && r.message.includes('"commands"'))).toBe(true);
  });

  it('isolates a plugin whose register throws and removes its partial hooks', () => {
    quietLogs();
    const good = vi.fn();
    const h = startHost([
      plugin('bad', ctx => { ctx.hookPacket('TEXT', () => {}); throw new Error('nope'); }),
      plugin('good', ctx => ctx.hookPacket('NEWTICK', good)),
    ]);
    expect(h.host.loaded()).toEqual(['good']);
    expect(h.proxy.interest.verdict?.server).toEqual(['NEWTICK']);
  });

  it('rejects duplicate ids and unsupported API versions', () => {
    quietLogs();
    const h = startHost([plugin('a', () => {}), plugin('a', () => {}), plugin('b', () => {}, { apiVersion: 2 })]);
    expect(h.host.loaded()).toEqual(['a']);
  });

  it('applies saved settings via migrate, persists changes, and keeps unknown plugin entries', () => {
    const first = startHost([plugin('p', ctx => {
      ctx.registerSetting('words', { label: 'Words', type: 'text', value: '' });
      ctx.registerSetting('draft', { label: 'Draft', type: 'text', value: '', transient: true });
    })]);
    first.host.context('p')!.updateSetting('words', 'spam');
    first.host.context('p')!.updateSetting('draft', 'unsaved');
    first.host.context('p')!.enabled = false;
    first.host.stop();
    const saved = JSON.parse(readFileSync(first.profile.path, 'utf8'));
    expect(saved.plugins.p).toEqual({ enabled: false, settings: { words: 'spam' } });

    const migrate = vi.fn((s: unknown) => ({ ...(s as object), words: `${(s as { words: string }).words}!` }));
    const second = startHost([plugin('p', ctx => ctx.registerSetting('words', { label: 'Words', type: 'text', value: '' }), { settings: { migrate } })], { profileDir: first.profileDir });
    expect(migrate).toHaveBeenCalledWith({ words: 'spam' }, true);
    expect(second.host.context('p')!.getSetting('words')).toBe('spam!');
    expect(second.host.context('p')!.enabled).toBe(false);
  });

  it('falls back to defaults when migrate rejects a saved entry', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }), {
      settings: { migrate: (saved, present) => { if (present) throw new Error('invalid'); return { n: 7 }; } },
    })], { profileDir: (() => {
      const first = startHost([plugin('p', ctx => ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }))]);
      first.host.context('p')!.updateSetting('n', 3);
      first.host.stop();
      return first.profileDir;
    })() });
    expect(h.host.context('p')!.getSetting('n')).toBe(7);
    expect(records.some(r => r.level === 'warn' && r.message.includes('invalid'))).toBe(true);
  });

  it('never writes an observed access token into the profile', () => {
    const h = startHost([plugin('p', ctx => ctx.observePacket('HELLO', () => {}))]);
    const id = h.connect();
    h.packet(id, 'HELLO', { gameId: -2, buildVersion: 'b', accessToken: 'secret-token', keyTime: -1, key: Buffer.alloc(0), gameNet: '', playPlatform: '', platformToken: '', userToken: '', clientIdentification: '' }, { observeOnly: true });
    h.host.context('p')!.enabled = true;
    h.host.stop();
    expect(readFileSync(h.profile.path, 'utf8')).not.toContain('secret-token');
  });
});
```

- [ ] **Step 4: Run and watch them fail.** `npx vitest run src/plugins/__tests__/host.test.ts`

- [ ] **Step 5: Implement `src/plugins/host.ts`**

```ts
import type { Profile, ProfileStore } from '../config/store.ts';
import { PROFILE_SCHEMA_VERSION } from '../config/store.ts';
import type { Packet } from '../protocol/Packet.ts';
import type { PacketFactory } from '../protocol/PacketFactory.ts';
import type { PacketEvent, ProxyHost } from '../transport/host.ts';
import type { InterestSpec } from '../transport/interest.ts';
import { log } from '../util/log.ts';
import {
  PLUGIN_API_VERSION, type Capability, type ClientConnection, type CommandHook, type ConnectionEvent,
  type PacketHook, type PluginContext, type PluginDefinition, type ServerInfo, type SettingDef,
} from './api.ts';
import { IDENTITY_PACKETS, PlayerIdentity } from './identity.ts';
import { SettingsStore } from './settings.ts';

export type ProxyLike = Pick<ProxyHost, 'on' | 'off' | 'setInterest' | 'forward' | 'inject'>;

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
  private readonly host: PluginHost;

  constructor(host: PluginHost, definition: PluginDefinition) {
    this.host = host;
    this.definition = definition;
    this.pluginId = definition.id;
    this.name = definition.name;
    this.settings = new SettingsStore(definition.settings?.validate?.bind(definition.settings), () => host.changed());
  }

  get enabled(): boolean { return this.enabledValue; }
  set enabled(value: boolean) {
    this.enabledValue = value;
    for (const callback of this.enabledCallbacks) {
      try { callback(value); } catch (error) { log.error(this.name, 'Enable callback failed', error); }
    }
    this.host.changed();
  }

  registerSetting(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void { this.settings.register(key, def, onChange); }
  getSetting<T = any>(key: string): T { return this.settings.get<T>(key); }
  updateSetting(key: string, value: unknown): boolean { return this.settings.update(key, value); }

  hookPacket(name: string, fn: PacketHook, options: { prepend?: boolean } = {}): void {
    this.require('packets');
    this.host.addHook(this, name, fn, !!options.prepend);
  }
  observePacket(name: string, fn: PacketHook): void {
    this.require('packets');
    this.host.addObserver(this, name, fn);
  }
  hookCommand(name: string, fn: CommandHook): void {
    this.require('commands');
    this.host.addCommand(this, name.replace(/^\//, '').toLowerCase(), fn);
  }
  on(event: ConnectionEvent, fn: (client: ClientConnection) => void): void { this.host.addListener({ plugin: this, event, fn }); }
  onEnabledChange(fn: (enabled: boolean) => void): void { this.enabledCallbacks.push(fn); }
  registerCleanup(fn: () => void): void { this.cleanups.push(fn); }
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
    this.proxy.on('session', this.onSession);
    this.proxy.on('routed', this.onRouted);
    this.proxy.on('closed', this.onClosed);
    this.proxy.on('packet', this.onPacket);
    this.started = true;
    const interest = this.interest();
    this.proxy.setInterest(interest);
    return interest;
  }

  stop(): void {
    for (const plugin of this.plugins.values()) {
      for (const cleanup of plugin.cleanups) {
        try { cleanup(); } catch (error) { log.error(plugin.name, 'Cleanup failed', error); }
      }
    }
    this.proxy.off('session', this.onSession);
    this.proxy.off('routed', this.onRouted);
    this.proxy.off('closed', this.onClosed);
    this.proxy.off('packet', this.onPacket);
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
    this.direction(name);
    const list = this.hooks.get(name) ?? [];
    if (prepend) list.unshift({ plugin, fn }); else list.push({ plugin, fn });
    this.hooks.set(name, list);
    this.refreshInterest();
  }

  addObserver(plugin: Plugin, name: string, fn: PacketHook): void {
    this.direction(name);
    this.observers.set(name, [...(this.observers.get(name) ?? []), { plugin, fn }]);
    this.refreshInterest();
  }

  addCommand(plugin: Plugin, name: string, fn: CommandHook): void {
    this.commands.set(name, [...(this.commands.get(name) ?? []), { plugin, fn }]);
    this.refreshInterest();
  }

  addListener(listener: Listener): void { this.listeners.push(listener); }

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
    } catch (error) {
      log.error('Plugins', `${definition.name} failed to load and is disabled`, error);
      plugin.failed = true;
      this.unregister(plugin);
      return;
    }
    this.applyProfile(plugin);
  }

  private applyProfile(plugin: Plugin): void {
    const entry = this.loadedProfile.plugins[plugin.pluginId];
    const policy = plugin.definition.settings;
    let values: Record<string, unknown> = entry?.settings ?? {};
    if (policy?.migrate) {
      try {
        values = policy.migrate(entry?.settings, entry !== undefined);
      } catch (error) {
        log.warn('Plugins', `${plugin.name}: saved settings are invalid (${(error as Error).message}); using defaults`);
        values = policy.migrate(undefined, false);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      const def = plugin.settings.definition(key);
      if (!def || def.type === 'button' || def.transient) continue;
      if (!plugin.settings.update(key, value)) log.warn('Plugins', `${plugin.name}: ignored an invalid saved value for ${key}`);
    }
    if (typeof entry?.enabled === 'boolean') plugin.enabled = entry.enabled;
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
      if (listener.event !== event || !listener.plugin.enabled) continue;
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
      log.error('Plugins', 'Packet handling failed', error);
    } finally {
      if (!event.observeOnly) this.proxy.forward(event.id, event.sequence, event.generation, this.verdict(event, packet));
    }
  };

  private run(list: Registered<PacketHook>[] | undefined, client: Client, packet: Packet, kind: string): void {
    for (const { plugin, fn } of list ?? []) {
      if (!plugin.enabled) continue;
      try { fn(client, packet); } catch (error) { log.error(plugin.name, `${packet.name} ${kind} failed`, error); }
    }
  }

  private runCommands(client: Client, packet: Packet): void {
    const text = typeof packet.data.text === 'string' ? packet.data.text : '';
    if (!text.startsWith('/')) return;
    const [command, ...args] = text.slice(1).trimEnd().toLowerCase().split(/\s+/);
    let consumed = false;
    for (const { plugin, fn } of this.commands.get(command) ?? []) {
      if (!plugin.enabled) continue;
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
    if (!packet.send) return null;
    if (!packet.modified) return event.data;
    try {
      return this.factory.serialize(packet);
    } catch (error) {
      log.warn('Plugins', `Could not apply a change to ${packet.name}; forwarding the original (${(error as Error).message})`);
      return event.data;
    }
  }
}
```

- [ ] **Step 6: Run** `npx vitest run src/plugins` until green, then `npm run check`. If a host test conflicts with this contract, fix the code, not the test, unless the test itself contradicts the contract. In that case report it.

- [ ] **Step 7: Commit** `feat(plugins): plugin host with verdicts, observers, commands, notifications and profiles`

---

### Task 6: Port Chat Filter

**Files:**
- Create (ported from `$REC/client/plugins/` @ 88a66b2): `plugins/chat-filter/index.ts` (from `chat-filter.ts`), `engine.ts`, `normalize.ts`, `rules.ts`, `sender-state.ts`, `settings.ts`
- Create (ported): `plugins/chat-filter/__tests__/chatFilter.test.ts` (from `$REC/client/src/plugins/__tests__/chatFilter.test.ts`)
- Modify: `plugins/index.ts` (add Chat Filter)

**Interfaces:**
- Consumes: `definePlugin`, `PluginContext`, `ClientConnection`, `SettingDef` from `src/plugins/api.ts`; `startHost`/`textData` from `src/testing/pluginHarness.ts`.
- Produces: default export `definePlugin({ id: 'chat-filter', name: 'Chat Filter', apiVersion: 1, capabilities: ['packets'], register, settings: { validate: validateChatSetting, migrate: normalizeChatProfile } })`. It keeps a named export `register` (the original function, unchanged body).

Steps:

- [ ] **Step 1: Copy the six files** (`REC=../realm-engine-client`)
```bash
mkdir -p plugins/chat-filter/__tests__
cp "$REC/client/plugins/chat-filter.ts" plugins/chat-filter/index.ts
cp "$REC/client/plugins/chat-filter/"{engine,normalize,rules,sender-state,settings}.ts plugins/chat-filter/
cp "$REC/client/src/plugins/__tests__/chatFilter.test.ts" plugins/chat-filter/__tests__/chatFilter.test.ts
```
- [ ] **Step 2: Mechanical edits** (and nothing else in behavior):
  - Every file gets line 1 `// Ported from realm-engine-client <original path> @ 88a66b2 (MIT, see NOTICE).`
  - All relative imports use `.ts`. `./chat-filter/x.js` in the old entry becomes `./x.ts`.
  - `index.ts`: replace `import type { PluginContext, ClientConnection } from './api.js'` with `import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts'`. Keep `export function register(ctx: PluginContext)` byte-identical in body. Add at the end:
    ```ts
    export default definePlugin({
      id: 'chat-filter', name: 'Chat Filter', apiVersion: 1, capabilities: ['packets'], register,
      settings: { validate: validateChatSetting, migrate: normalizeChatProfile },
    });
    ```
    Import `validateChatSetting` and `normalizeChatProfile` from `./settings.ts`. If either isn't exported there, export it. Don't change it otherwise.
  - `settings.ts`: `import type { SettingDef } from '../../src/plugins/api.ts'`.
  - `sender-state.ts`: replace constructor parameter properties with explicit `readonly` fields assigned in the constructor. Same names, same defaults.
  - `npx tsc --noEmit` must pass. If a type mismatch with `src/plugins/api.ts` appears (e.g. `SettingDef.value` typing), fix it at the call site in the plugin with the narrowest cast, and list it.
- [ ] **Step 3: Port the tests.** Keep **all 62 cases**, with their names, case tables and assertions. Replace only the harness: the Proxy EventEmitter mock, `PluginContext`/`PluginManager`/`PluginConfigService` construction and `createPacket` plumbing all go through `startHost([chatFilter])` from `src/testing/pluginHarness.ts`:
  - Send TEXT with `h.packet(id, 'TEXT', textData({...}))`. Blocked means the verdict's `data` is `null`.
  - Set the local player name through `CREATESUCCESS` + `NEWTICK` (stat 31), as in the host tests, or another path that goes through the real identity tracker.
  - Settings go through `h.host.context('chat-filter')!.updateSetting(...)`. Status is read with `h.host.data('chat-filter')!.get('status')`.
  - `performance.now` spying stays as in the original.
  - Profile/prevalidation cases map to RealmTool semantics. An invalid saved profile is rejected wholesale by `migrate` and falls back to defaults with a warning. An invalid `updateSetting` returns `false` and changes nothing. Each such case keeps its intent and assertion strength.
  - If a case tests a Realm Engine-only mechanism with no RealmTool equivalent (e.g. dashboard WebSocket fan-out), replace it with the nearest equivalent assertion on RealmTool behavior and keep the case name. **List every adapted case in the report, with before/after.**
- [ ] **Step 4: Add** `import chatFilter from './chat-filter/index.ts'` to `plugins/index.ts` and put it in `BUILTIN_PLUGINS`.
- [ ] **Step 5: Run** `npx vitest run plugins/chat-filter`. Expected: 62/62. Then `npm run check`.
- [ ] **Step 6: Commit** `feat(chat-filter): port Chat Filter from realm-engine-client 88a66b2`

---

### Task 7: Server Switch plugin

**Files:**
- Create: `plugins/server-switch/directory.ts`, `plugins/server-switch/index.ts`, `data/servers.json` (copy of `$REC/client/data/servers.json`)
- Test: `plugins/server-switch/__tests__/directory.test.ts`, `plugins/server-switch/__tests__/serverSwitch.test.ts`
- Modify: `plugins/index.ts` (add Server Switch after Chat Filter)

**Interfaces:**
- Produces: `SERVER_LIST_URL`, `ServerEntry`, `parseServerList(xml)`, `fallbackServers(json)`, `abbreviation(name)`, `Resolution`, `resolveServer(query, servers)`, `ServerDirectory { constructor({ fallback, fetch?, now?, timeoutMs? }); list(); refresh(accessToken): Promise<void> }`, `createServerSwitch(directory?)`, default export plugin `{ id: 'server-switch', name: 'Server Switch', capabilities: ['packets','commands','notifications','inject'] }`.

- [ ] **Step 1: Copy data.** `cp ../realm-engine-client/client/data/servers.json data/servers.json`

- [ ] **Step 2: Write the failing tests.** `directory.test.ts` must cover:
  - `parseServerList` keeps `<Server><Name>USWest</Name><DNS>1.2.3.4</DNS></Server>`, skips blocks with `<AdminOnly/>` or `<AdminOnly>`, and skips invalid names (e.g. `9Bad`, `Has Space`) and non-IPv4 DNS values (`host.example`, `1.2.3`).
  - `abbreviation('USWest') === 'usw'`, `abbreviation('USEast2') === 'use2'`, `abbreviation('EUSouthWest') === 'eusw'`.
  - `resolveServer` resolves `'1.2.3.4'` to itself; exact names case-insensitively; `'usw'` → USWest; a unique prefix (`'austr'` → Australia); and returns the exact Realm Engine messages:
    - `'Use a server name, abbreviation, or IPv4 address.'` for blank input;
    - `'Ambiguous server: USSouth, USSouth3. Use the full name.'` for `'ussou'` against those two;
    - `'Unknown server or invalid IPv4 address. Use /con to list servers.'` otherwise.
  - `ServerDirectory.refresh` with a fake `fetch`:
    - GETs `SERVER_LIST_URL` with query `accessToken=<t>&game_net=Unity&play_platform=Unity&game_net_user_id=`;
    - sends headers `User-Agent: UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)` and `X-Unity-Version: 2021.3.31f1`;
    - replaces the list on success;
    - deduplicates concurrent calls (one fetch);
    - skips calls for 15 min after success and 60 s after failure (fake `now`);
    - keeps the previous list on non-OK (`Server list API returned 503`), on thrown errors and on an empty parse.
  - **Token never logged:** make fetch reject with an error whose message contains the token, capture `log` records, and assert no record contains the token.

  `serverSwitch.test.ts` (via `startHost([createServerSwitch(directory)])` with a directory built from fixed entries):
  - `/con usw` consumes the command; the injected packets are a TEXT `Connecting to USWest...` from `Server Switch`, then a RECONNECT decoding to `{ name: 'USWest', host: '<ip>', port: 2050, gameId: -2, keyTime: -1, key: <empty> }` (`toClient: true`);
  - `/con` alone lists the server names using the exact usage text from the research report;
  - `/con nowhere` sends the unknown-server message and injects no RECONNECT;
  - `/goto 1.2.3.4` → port 2050 and sender `IP Connect`;
  - `/goto 1.2.3.4:2051` → port 2051;
  - `/goto 1.2.3.4:0` and `/goto 1.2.3.4:99999` → `Invalid port: <x>`;
  - `/goto 999.1.1.1` → `Invalid IP: 999.1.1.1`;
  - `/goto` → usage;
  - `/goto a b` → usage;
  - `/ip` before routing → `No established server connection.`; after `route(id, '5.6.7.8')` → `Connected to 5.6.7.8:2050`;
  - an observed HELLO with `accessToken` triggers exactly one `refresh(token)`;
  - with the plugin disabled, `/con usw` passes through (verdict not null).

- [ ] **Step 3: Run and watch them fail.** `npx vitest run plugins/server-switch`

- [ ] **Step 4: Implement `plugins/server-switch/directory.ts`**

```ts
// Server list logic ported from realm-engine-client client/src/services/ServerSwitchService.ts and
// ServerListFetcher.ts @ 88a66b2 (MIT, see NOTICE). The display-sync (DLL) path is intentionally omitted.
import { isIPv4 } from 'node:net';
import { log } from '../../src/util/log.ts';

export const SERVER_LIST_URL = 'https://www.realmofthemadgod.com/account/servers';
const NAME = /^[a-z][a-z\d]{0,63}$/i;
const SUCCESS_REFRESH_MS = 15 * 60_000;
const FAILURE_RETRY_MS = 60_000;

export interface ServerEntry { name: string; address: string }
export type Resolution = { ok: true; name: string; address: string } | { ok: false; message: string };

const valid = (name: unknown, address: unknown): boolean =>
  typeof name === 'string' && typeof address === 'string' && NAME.test(name) && isIPv4(address);

export function parseServerList(xml: string): ServerEntry[] {
  const servers: ServerEntry[] = [];
  for (const block of xml.match(/<Server>[\s\S]*?<\/Server>/g) ?? []) {
    if (/<AdminOnly\s*\/>|<AdminOnly>/.test(block)) continue;
    const name = /<Name>([^<]*)<\/Name>/.exec(block)?.[1];
    const address = /<DNS>([^<]*)<\/DNS>/.exec(block)?.[1];
    if (valid(name, address)) servers.push({ name: name!, address: address! });
  }
  return servers;
}

export function fallbackServers(json: Record<string, unknown>): ServerEntry[] {
  return Object.entries(json).filter(([name, address]) => valid(name, address)).map(([name, address]) => ({ name, address: address as string }));
}

/** Upper-case letters and digits of a server name, lower-cased: USWest → usw, USEast2 → use2. */
export function abbreviation(name: string): string {
  return name.replace(/[^A-Z\d]/g, '').toLowerCase();
}

const ambiguous = (matches: readonly ServerEntry[]): Resolution =>
  ({ ok: false, message: `Ambiguous server: ${matches.map(s => s.name).join(', ')}. Use the full name.` });

export function resolveServer(query: string, servers: readonly ServerEntry[]): Resolution {
  const text = query.trim();
  if (!text) return { ok: false, message: 'Use a server name, abbreviation, or IPv4 address.' };
  if (isIPv4(text)) return { ok: true, name: text, address: text };
  const lower = text.toLowerCase();
  const exact = servers.find(s => s.name.toLowerCase() === lower);
  if (exact) return { ok: true, ...exact };
  for (const matches of [servers.filter(s => abbreviation(s.name) === lower), servers.filter(s => s.name.toLowerCase().startsWith(lower))]) {
    if (matches.length === 1) return { ok: true, ...matches[0] };
    if (matches.length > 1) return ambiguous(matches);
  }
  return { ok: false, message: 'Unknown server or invalid IPv4 address. Use /con to list servers.' };
}

export interface DirectoryOptions {
  fallback: readonly ServerEntry[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** In-memory server list. The access token is only ever a parameter: it is never stored or logged. */
export class ServerDirectory {
  private servers: ServerEntry[];
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: DirectoryOptions) {
    this.servers = [...options.fallback];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  list(): readonly ServerEntry[] {
    return this.servers;
  }

  refresh(accessToken: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!accessToken || this.now() < this.nextRefreshAt) return Promise.resolve();
    this.inFlight = this.load(accessToken).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(accessToken: string): Promise<void> {
    try {
      const query = new URLSearchParams({ accessToken, game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' });
      const response = await this.fetchImpl(`${SERVER_LIST_URL}?${query}`, {
        headers: {
          'User-Agent': 'UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
          'X-Unity-Version': '2021.3.31f1',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error(`Server list API returned ${response.status}`);
      const servers = parseServerList(await response.text());
      if (servers.length === 0) throw new Error('Server list API returned no servers');
      this.servers = servers;
      this.nextRefreshAt = this.now() + SUCCESS_REFRESH_MS;
      log.info('Server Switch', `Loaded ${servers.length} servers`);
    } catch (error) {
      this.nextRefreshAt = this.now() + FAILURE_RETRY_MS;
      const message = (error instanceof Error ? error.message : String(error)).split(accessToken).join('<token>');
      log.warn('Server Switch', `Server list refresh failed (${message}); using the last known list`);
    }
  }
}
```

- [ ] **Step 5: Implement `plugins/server-switch/index.ts`**

```ts
// Commands ported from realm-engine-client client/src/core/CoreCommands.ts, ServerSwitchService.ts and
// client/plugins/ip-connect.ts @ 88a66b2 (MIT, see NOTICE). RECONNECT targets the real server: RealmTool's
// worker Router rewrites every RECONNECT to the game, so no loopback/GUID handling belongs here.
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { GAME_PORT } from '../../src/protocol/constants.ts';
import { fallbackServers, resolveServer, ServerDirectory } from './directory.ts';

const NEXUS_GAME_ID = -2;

function defaultDirectory(): ServerDirectory {
  const json = JSON.parse(readFileSync(new URL('../../data/servers.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  return new ServerDirectory({ fallback: fallbackServers(json) });
}

function reconnect(ctx: PluginContext, client: ClientConnection, name: string, host: string, port: number): void {
  const packet = ctx.createPacket('RECONNECT');
  packet.data = { name, host, port, gameId: NEXUS_GAME_ID, keyTime: -1, key: Buffer.alloc(0) };
  client.sendToClient(packet);
}

export function createServerSwitch(directory: ServerDirectory = defaultDirectory()) {
  return definePlugin({
    id: 'server-switch',
    name: 'Server Switch',
    apiVersion: 1,
    capabilities: ['packets', 'commands', 'notifications', 'inject'],
    register(ctx) {
      ctx.observePacket('HELLO', (_client, packet) => {
        const token = packet.data.accessToken;
        if (typeof token === 'string' && token) void directory.refresh(token);
      });

      ctx.hookCommand('con', (client, _command, args) => {
        const say = (message: string) => ctx.sendNotification(client, 'Server Switch', message);
        if (args.length !== 1) {
          const names = directory.list().map(s => s.name).join(', ');
          say(`Use /con <name, abbreviation, or IPv4>, e.g. /con USEast or /con USE. Servers: ${names || '(none loaded)'}`);
          return;
        }
        const result = resolveServer(args[0], directory.list());
        if (!result.ok) { say(result.message); return; }
        say(`Connecting to ${result.name}...`);
        reconnect(ctx, client, result.name, result.address, GAME_PORT);
      });

      ctx.hookCommand('goto', (client, _command, args) => {
        const say = (message: string) => ctx.sendNotification(client, 'IP Connect', message);
        const parts = args.length === 1 ? args[0].split(':') : [];
        if (parts.length < 1 || parts.length > 2) { say('Usage: /goto {ip} or /goto {ip}:{port}'); return; }
        const [ip, portText] = parts;
        if (!isIPv4(ip)) { say(`Invalid IP: ${ip}`); return; }
        const port = portText === undefined ? GAME_PORT : /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) { say(`Invalid port: ${portText}`); return; }
        say(`Connecting to ${ip}:${port}...`);
        reconnect(ctx, client, `${ip}:${port}`, ip, port);
      });

      ctx.hookCommand('ip', client => {
        const server = client.server;
        ctx.sendNotification(client, 'Server Switch', server ? `Connected to ${server.host}:${server.port}` : 'No established server connection.');
      });
    },
  });
}

export default createServerSwitch();
```

- [ ] **Step 6: Add to `plugins/index.ts`** after Chat Filter: `import serverSwitch from './server-switch/index.ts'`, then put it in `BUILTIN_PLUGINS`. If Task 6 hasn't merged yet in your worktree, create `plugins/index.ts` with only Server Switch; the controller merges the two lists.

- [ ] **Step 7: Run** `npx vitest run plugins/server-switch`, then `npm run check`.

- [ ] **Step 8: Commit** `feat(server-switch): /con, /goto and /ip through the proxy's router`

---

### Task 8: CLI wiring and docs

**Files:**
- Modify: `src/cli.ts`, `src/__tests__/cli.test.ts`, `README.md`

**Interfaces:**
- Consumes: `PluginHost`, `ProfileStore`, `appDataDir`, `BUILTIN_PLUGINS`, `createFactory`.
- Produces:
  - `RunDeps.createHost` returns `Pick<ProxyHost, 'on' | 'off' | 'start' | 'stop' | 'setInterest' | 'forward' | 'inject'>`.
  - `RunDeps` gains `plugins: readonly PluginDefinition[]` and `profileDir(): string`.
  - New CLI command `config-path`, which prints the profile file path.

- [ ] **Step 1: Write the failing tests** (extend `cli.test.ts`):
  - `parseCli(['config-path']).command === 'config-path'`.
  - `runProxy` with fakes passes, where the fake host extends `FakeProxy` from the plugin harness and adds `start`/`stop`. The test plugin registers a TEXT hook; `profileDir` is a temp dir.
  - `setInterest` was called before `start()` resolved, and its verdict includes `TEXT`.
  - On normal shutdown the profile is flushed: after an `updateSetting` during the run, the file exists with that value.
  - The plugin host is stopped before `host.stop()`: a cleanup registered by the plugin runs before the fake's `stop` records its call.
- [ ] **Step 2: Implement**
  - In `runProxy`, load the schema once: `const schema = loadSchema();`. Pass it to `createHost` and build `const factory = createFactory(schema)`.
  - Right after creating the host (inside the try), add:
    ```ts
    const plugins = new PluginHost({ proxy: host, factory, definitions: deps.plugins, profile: new ProfileStore({ dir: deps.profileDir() }) });
    plugins.start();
    log.info('Plugins', `Loaded ${plugins.loaded().join(', ') || 'no plugins'}`);
    ```
  - In `finally`, before `await host.stop()`: `plugins?.stop();`. Declare `let plugins: PluginHost | undefined` outside the try.
  - `defaultRunDeps`: `plugins: BUILTIN_PLUGINS`, `profileDir: () => appDataDir()`.
  - `config-path` command: prints `new ProfileStore({ dir: appDataDir() }).path` and returns 0. Add it to `COMMANDS` and to HELP as `config-path        Print the settings profile location`.
- [ ] **Step 3: README.** Add a "Plugins (Phase 2)" section:
  - **Chat Filter:** on by default. Its settings live in the profile. Edit them with RealmTool stopped, because RealmTool saves its own state on exit. `node src/cli.ts config-path` prints the profile location.
  - **Server Switch:** `/con <server>` (names like `USWest`, abbreviations like `usw`, or an IPv4), `/goto <ip>[:port]`, `/ip`. Exalt's own server label doesn't change.
  - The profile is created on the first run that changes a setting.
- [ ] **Step 4: Run** `npm run check` and `node src/cli.ts config-path`.
- [ ] **Step 5: Commit** `feat(cli): load plugins and persist their profile`
- [ ] **Step 6: Live smoke test (user):**
  1. `npm start`, Play, log in.
  2. In Nexus, `/con` lists servers, and `/con usw` (or another server) moves you to that server's Nexus. The terminal shows a `(transfer)` routed line to the new IP.
  3. `/goto <ip>` works the same way.
  4. Ad spam in Nexus chat is hidden.
  5. Ctrl+C, then check `config-path`: the file exists only if a setting was changed.

## Phase 2 exit criteria

- `npm run check` green locally and in CI; Chat Filter 62/62 ported cases pass.
- The live smoke test passes: `/con`, `/goto`, `/ip` and chat filtering on the real game.
- No log line or profile file contains the access token (Tasks 5 and 7 tests).
