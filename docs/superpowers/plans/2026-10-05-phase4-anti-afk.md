# RealmTool Phase 4 — Anti-AFK (off until enabled)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in Anti-AFK built-in keeps Exalt from closing its own connection after ~20 minutes without input. After the player has been inactive for a configurable time (default 5 minutes), it posts one left click to that session's game window from RealmTool's process. There's no injection and the helper DLL is unchanged.

**Architecture:** Three layers, one per task.
1. **Native input module** (`src/input/`): find the session's game window and post a pulse through koffi `user32`, behind an injectable source.
2. **Plugin-host `input` capability:** `ctx.input.pulse(client)` resolves the session's game process through the existing TCP-owner lookup, verifies it, and calls the input module.
3. **`anti-afk` plugin:** a main-thread inactivity detector over client packets that requests a pulse.

**Tech Stack:** Node ≥ 22.18 native TypeScript, Vitest 3, koffi (already a runtime dependency), Win32 `user32` (`FindWindowExW`, `GetWindowThreadProcessId`, `IsWindowVisible`, `IsIconic`, `GetClientRect`, `ClientToScreen`, `GetCursorPos`, `PostMessageW`). No new dependencies.

**Spec:** [`docs/design.md`](../../design.md) §2.1 (Anti-AFK input), §2.2 (capabilities), §5 row 4.

**Live findings this plan rests on** (verified with the user on 2026-10-05; see the Phase 6 handoff):
- The AFK disconnect is **client-side**. Exalt closed the socket itself after ~20 min without input. The server sent no warning or `FAILURE` and kept sending traffic, and it tolerated 30+ minutes idle.
- A **left click posted from another process** (`PostMessage` `WM_LBUTTONDOWN`, 32 ms, `WM_LBUTTONUP`) to the `UnityWndClass` window made the character shoot **with the game in the background**. One click every 5 minutes kept the session connected for ~35 minutes with no real input.
- The click's `lParam` coordinates are **ignored**: the game aims at the real cursor. A click while the cursor sits over in-game UI could press that UI.

Source for porting: realm-engine-client `88a66b2` (`REC`), `client/plugins/anti-afk.ts` and `client/src/util/antiAfk.ts`. RealmTool does **not** port REC's DLL bridge, pipe or WndProc subclass.

## Global Constraints

- All earlier constraints apply:
  - `.ts` specifiers, erasable syntax only, and `npm run check` green;
  - Windows x64; listen only on 127.0.0.1;
  - never start `RotMG Exalt.exe` directly; RC4 keys only in `src/protocol/constants.ts`;
  - the access token is never logged.
- **Off until enabled.** The plugin registers with `ctx.enabled = false` (like Auto Drink). The profile's saved `enabled` value is respected. The user ruled this on 2026-10-05.
- **No injection, no helper change:** the helper stays routing-only. RealmTool never moves the real cursor or synthesizes global input (no `SetCursorPos`, `SendInput`, `keybd_event` or `mouse_event`). It only posts messages to one window.
- **Only the session's own verified game window.** A pulse targets a visible `UnityWndClass` top-level window owned by the PID behind that session's loopback socket. Before every pulse it re-checks that the process's creation time still matches the one first seen for the session.
- **Inactivity setting `idleMinutes`:** default 5, range 1–15. It must stay well below the client's ~20-minute timeout.
- **Every pulse is a matched pair:** down, 32 ms, then up. The up message is always posted once the down was posted, even if the plugin is disabled or the session closes in between.
- Ported files keep `// Ported from realm-engine-client <path> @ 88a66b2 (MIT, see NOTICE).`, or `// Adapted from …` when changed beyond imports/syntax.
- The plugin and docs never describe Anti-AFK as undetectable or risk-free. It automates input, and the user enables it knowingly.

## Rulings

- **P4-1 Pulse method: left click.** Task 0 (2026-10-05) tested an `F15` key press (`WM_KEYDOWN`/`WM_KEYUP`, `VK_F15`) posted every 5 minutes. It did **not** reset the idle timer: the session closed 20 m 1 s after its last real input, with four F15 presses in that window. The verified left click (`WM_LBUTTONDOWN` `MK_LBUTTON`, 32 ms, `WM_LBUTTONUP`) is the only method, always with the cursor guard (P4-2). There's no method setting. *If wrong:* clicks stop resetting the timer after a game update; the live acceptance check and the session-end idle line would show it.
- **P4-2 Cursor guard (click only).** A click is posted only when the cursor is outside the game window's client rectangle, or inside its central safe box: the middle 50% of width and height, where the character and play area are. Otherwise the pulse is skipped with reason `cursor-over-game-ui`. *If wrong:* a click still lands on UI near the center (for example an open trade window). Skipping costs nothing beyond a missed pulse; the next one comes `idleMinutes` later.
- **P4-3 Inactivity, not just stationarity.** The idle window resets on these:
  - a changed final MOVE position;
  - any client `PLAYERSHOOT`, `USEITEM`, `PLAYERTEXT` or `INVSWAP`;
  - a MOVE gap over 10 s (loading, suspended client);
  - `MAPINFO` and `RECONNECT`;
  - connect/disconnect and enable/disable.

  This extends REC's MOVE-only detector, so an active stationary player (shooting in place, trading, chatting) never gets pulses. *If wrong:* the player gets kicked while "active" in a way that sends none of these packets, which is no worse than today.
- **P4-4 Minimized windows.** The pulse is posted anyway and the result reports `minimized: true`. Task 0 records whether it helps. *If wrong:* a minimized client still idles out; the log shows `minimized` on each pulse.

## Review Focus

1. **Cursor over the game's UI:** never click. Skip with `cursor-over-game-ui` (Task 1 test).
2. **PID reuse or a restarted game:** a session whose process creation time changed must never be pulsed (`process-changed`; Task 2 test).
3. **Two Exalt clients running:** only the window owned by the session's PID is pulsed, never another client's window (Task 1 test).
4. **Stationary but active player** (shooting, chatting, inventory): no pulse (Task 3 test).
5. **Disabled or disconnected between down and up:** the up message is still posted, and no further pulses follow (Task 1 and Task 3 tests).

---

### Task 0: Live gate — pulse method (done, 2026-10-05)

- [x] **F15 key press:** posted every 5 minutes with the game in the background. Failed: the session closed 20 m 1 s after the last real input.
- [x] **Left click:** posted every 5 minutes with the game in the background. Passed: connected ~35 minutes with no real input (earlier the same day).
- [ ] **Optional, 1 min, before Task 3 ships:** with the game minimized, post one click and ask the user whether the character shot after restoring. Record the result under P4-4.

---

### Task 1: Native game-input module

**Files:**
- Create: `src/input/gameInput.ts` (pure logic, no Win32)
- Create: `src/input/win32GameInput.ts` (koffi source, loaded lazily)
- Test: `src/input/__tests__/gameInput.test.ts`

**Interfaces:**
- Consumes: `readTcpProcessIdentity(gamePort, proxyPort)` and `ProcessIdentity` from `src/routing/tcpProcessIdentity.ts`; `GAME_PORT` from `src/protocol/constants.ts`.
- Produces (later tasks rely on these exact names):

```ts
export interface ScreenRect { left: number; top: number; right: number; bottom: number }
export interface GameWindow { handle: unknown; minimized: boolean; client: ScreenRect }
export interface GameInputSource {
  /** The game process behind a loopback session socket, or null. */
  identify(remotePort: number): ProcessIdentity | null;
  /** The visible UnityWndClass top-level window owned by `pid`, or null when there is none or more than one. */
  findGameWindow(pid: number): GameWindow | null;
  cursor(): { x: number; y: number } | null;
  post(handle: unknown, message: number, wParam: number, lParam: number): boolean;
}
export type PulseResult =
  | { ok: true; minimized: boolean }
  | { ok: false; reason: 'unavailable' | 'no-process' | 'process-changed' | 'no-window' | 'cursor-over-game-ui' | 'post-failed' };
export const PULSE_GAP_MS = 32;
/** Posts one matched left-button down/up pair; never moves the cursor. */
export function pulseGameWindow(window: GameWindow, source: GameInputSource,
  wait?: (ms: number) => Promise<void>): Promise<PulseResult>;
export function insideSafeBox(client: ScreenRect, cursor: { x: number; y: number }): boolean;
/** Lazily loaded Win32 source; null with `win32GameInputError()` set when koffi/user32 can't load. */
export function win32GameInputSource(): GameInputSource | null;   // in win32GameInput.ts
export function win32GameInputError(): string | null;             // in win32GameInput.ts
```

- [ ] **Step 1: Write the failing tests.** Use a fake `GameInputSource` that records posts:

```ts
import { expect, it } from 'vitest';
import { insideSafeBox, pulseGameWindow, type GameInputSource, type GameWindow } from '../gameInput.ts';

function fake(overrides: Partial<GameInputSource> = {}) {
  const posts: Array<[number, number, number]> = [];
  const source: GameInputSource = {
    identify: () => ({ pid: 10, processStartTime: '1' }),
    findGameWindow: () => window,
    cursor: () => ({ x: 5000, y: 5000 }),
    post: (_h, m, w, l) => { posts.push([m, w, l]); return true; },
    ...overrides,
  };
  return { source, posts };
}
const window: GameWindow = { handle: {}, minimized: false, client: { left: 0, top: 0, right: 3440, bottom: 1440 } };
const noWait = async () => {};

it('click pulse posts left down/up when the cursor is outside the game window', async () => {
  const { source, posts } = fake();
  expect(await pulseGameWindow(window, source, noWait)).toEqual({ ok: true, minimized: false });
  expect(posts).toEqual([[0x201, 1, 1], [0x202, 0, 1]]);
});

it('click pulse is skipped when the cursor is over game UI, and allowed in the central safe box', async () => {
  const edge = fake({ cursor: () => ({ x: 3400, y: 700 }) });
  expect(await pulseGameWindow(window, edge.source, noWait)).toEqual({ ok: false, reason: 'cursor-over-game-ui' });
  expect(edge.posts).toEqual([]);
  const center = fake({ cursor: () => ({ x: 1720, y: 720 }) });
  expect((await pulseGameWindow(window, center.source, noWait)).ok).toBe(true);
  expect(insideSafeBox(window.client, { x: 860, y: 360 })).toBe(true);    // exactly at 25%/25%
  expect(insideSafeBox(window.client, { x: 859, y: 360 })).toBe(false);
});

it('click pulse with an unknown cursor position is skipped', async () => {
  const { source, posts } = fake({ cursor: () => null });
  expect(await pulseGameWindow(window, source, noWait)).toEqual({ ok: false, reason: 'cursor-over-game-ui' });
  expect(posts).toEqual([]);
});

it('a failed down post sends nothing else; a failed up post still reports post-failed', async () => {
  const downFails = fake({ post: () => false });
  expect(await pulseGameWindow(window, downFails.source, noWait)).toEqual({ ok: false, reason: 'post-failed' });
  let n = 0;
  const upFails = fake({ post: () => ++n === 1 });
  expect(await pulseGameWindow(window, upFails.source, noWait)).toEqual({ ok: false, reason: 'post-failed' });
  expect(n).toBe(2);   // the up was attempted after a successful down
});

it('reports minimized windows but still pulses (P4-4)', async () => {
  const { source } = fake();
  expect(await pulseGameWindow({ ...window, minimized: true }, source, noWait)).toMatchObject({ ok: true, minimized: true });
});

it('waits PULSE_GAP_MS between down and up', async () => {
  const { source } = fake();
  const waits: number[] = [];
  await pulseGameWindow(window, source, async ms => { waits.push(ms); });
  expect(waits).toEqual([32]);
});
```

Also add `src/input/__tests__/win32GameInput.test.ts`, skipped on non-win32 platforms only (`it.skipIf(process.platform !== 'win32')`). It asserts that `win32GameInputSource()` loads, that `findGameWindow(process.pid)` returns `null` (the test runner owns no `UnityWndClass` window), and that `cursor()` returns finite numbers or null. Review Focus 3 (two clients) is pinned by the source contract: `findGameWindow` filters by PID and returns null when the PID owns more than one matching window. Test it through a fake `user32` binding layer. `win32GameInput.ts` must take its raw functions (`FindWindowExW`, `GetWindowThreadProcessId`, …) through an internal `createWin32Source(bindings)` so the test can supply two windows with different PIDs and check that only the matching one is returned.

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --configLoader native src/input`. Expected: FAIL, because `../gameInput.ts` doesn't exist.

- [ ] **Step 3: Implement `src/input/gameInput.ts`.**

```ts
import type { ProcessIdentity } from '../routing/tcpProcessIdentity.ts';

export interface ScreenRect { left: number; top: number; right: number; bottom: number }
export interface GameWindow { handle: unknown; minimized: boolean; client: ScreenRect }
export interface GameInputSource {
  identify(remotePort: number): ProcessIdentity | null;
  findGameWindow(pid: number): GameWindow | null;
  cursor(): { x: number; y: number } | null;
  post(handle: unknown, message: number, wParam: number, lParam: number): boolean;
}
export type PulseResult =
  | { ok: true; minimized: boolean }
  | { ok: false; reason: 'unavailable' | 'no-process' | 'process-changed' | 'no-window' | 'cursor-over-game-ui' | 'post-failed' };

export const PULSE_GAP_MS = 32;
const WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, MK_LBUTTON = 1;

/** Central half of the client area in both directions: the character and play field (P4-2). */
export function insideSafeBox(client: ScreenRect, cursor: { x: number; y: number }): boolean {
  const width = client.right - client.left, height = client.bottom - client.top;
  return cursor.x >= client.left + width / 4 && cursor.x <= client.right - width / 4
    && cursor.y >= client.top + height / 4 && cursor.y <= client.bottom - height / 4;
}

function insideClient(client: ScreenRect, cursor: { x: number; y: number }): boolean {
  return cursor.x >= client.left && cursor.x < client.right && cursor.y >= client.top && cursor.y < client.bottom;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function pulseGameWindow(window: GameWindow, source: GameInputSource,
  wait: (ms: number) => Promise<void> = sleep): Promise<PulseResult> {
  // The game aims at the real cursor (lParam is ignored), so only click where no UI can be hit.
  const cursor = source.cursor();
  if (!cursor || (insideClient(window.client, cursor) && !insideSafeBox(window.client, cursor))) {
    return { ok: false, reason: 'cursor-over-game-ui' };
  }
  if (!source.post(window.handle, WM_LBUTTONDOWN, MK_LBUTTON, 1)) return { ok: false, reason: 'post-failed' };
  await wait(PULSE_GAP_MS);
  // Always release what was pressed, whatever happened during the gap.
  if (!source.post(window.handle, WM_LBUTTONUP, 0, 1)) return { ok: false, reason: 'post-failed' };
  return { ok: true, minimized: window.minimized };
}
```

- [ ] **Step 4: Implement `src/input/win32GameInput.ts`.** Follow the lazy-load pattern of `src/routing/tcpProcessIdentity.ts` (`createRequire(import.meta.url)('koffi')`, cached source, cached load error). Bindings (all `__stdcall`):
  - `void * FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)`
  - `uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)`
  - `int IsWindowVisible(void *hwnd)`, `int IsIconic(void *hwnd)`
  - `int GetClientRect(void *hwnd, _Out_ RECT *r)`, `int ClientToScreen(void *hwnd, _Inout_ POINT *p)`, `int GetCursorPos(_Out_ POINT *p)`
  - `int PostMessageW(void *hwnd, uint32_t msg, uintptr_t w, intptr_t l)`

  Define `RECT`/`POINT` with `koffi.struct`. `findGameWindow(pid)` loops `FindWindowExW(null, previous, 'UnityWndClass', null)` until null and keeps visible windows whose owner PID equals `pid`. It returns the single match, or null for 0 or more than 1. The client rect is converted to screen coordinates with `ClientToScreen` of `{0,0}`. `identify(remotePort)` = `readTcpProcessIdentity(remotePort, GAME_PORT)`. Any thrown error inside a call returns null/false; it never throws to callers. Export `win32GameInputSource()` and `win32GameInputError()`, plus `createWin32Source(bindings)` for the test.

- [ ] **Step 5: Run the tests and see them pass.** Run `npx vitest run --configLoader native src/input` and `npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 6: Commit.** `git add src/input && git commit -m "feat: native game-window input pulse (no injection)"`

---

### Task 2: Plugin-host `input` capability

**Files:**
- Modify: `src/plugins/api.ts`: `Capability` gains `'input'`; add the `InputApi` interface and `PluginContext.input`
- Modify: `src/plugins/host.ts`: keep each session's `remotePort`; add the `input` option and `ctx.input.pulse`
- Test: `src/plugins/__tests__/input.test.ts`

**Interfaces:**
- Consumes (Task 1): `GameInputSource`, `PulseResult`, `pulseGameWindow`, `win32GameInputSource`, `win32GameInputError`.
- Produces:

```ts
// api.ts
export type Capability = 'packets' | 'commands' | 'notifications' | 'inject' | 'worker' | 'input';
export interface InputApi {
  /** One down/up pulse to this session's own game window. Never throws. */
  pulse(client: ClientConnection): Promise<PulseResult>;
}
// PluginContext:
  /** Throws unless the plugin declares the input capability. */
  readonly input: InputApi;
// host.ts PluginHostOptions:
  /** Game-window input source; defaults to the lazily loaded Win32 source. `null` disables input. */
  input?: GameInputSource | null;
```

Re-export `PulseResult` from `api.ts` (`export type { PulseResult } from '../input/gameInput.ts';`) so plugins import only from the API.

- [ ] **Step 1: Write the failing tests** in `src/plugins/__tests__/input.test.ts`, using `startHost` from `src/testing/pluginHarness.ts` (extend the harness to pass `input` and a session `remotePort` if it doesn't already; keep its existing callers unchanged). Cases:
  - A plugin without `'input'` gets an error naming the capability from `ctx.input`.
  - **First pulse binds the identity:** with `identify` → `{pid: 7, processStartTime: '100'}` and a window, `pulse(client)` resolves `{ok: true, …}`. `findGameWindow` was called with `7`, and `identify` was called with the session's `remotePort`.
  - **Review Focus 2:** a second pulse where `identify` now returns `{pid: 7, processStartTime: '200'}` resolves `{ok: false, reason: 'process-changed'}`, and nothing is posted. A pulse where `identify` returns `null` resolves `no-process`.
  - `findGameWindow` → null resolves `no-window`; `input: null` resolves `unavailable`.
  - A disconnected client (after the proxy `closed` event) resolves `no-process` without calling `identify`.
  - A source whose `identify` throws resolves `no-process` and logs no error spam (at most one warning per session).

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --configLoader native src/plugins/__tests__/input.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `host.ts`, `onSession` receives `{ id, remotePort }`; the proxy event already carries `remotePort`, see `src/transport/host.ts:155`. Store it on `Client` as a non-API field `readonly remotePort: number`.
  - Add `private readonly identities = new WeakMap<Client, ProcessIdentity>()`.
  - Add `input` on `Plugin`, created once:

```ts
get input(): InputApi {
  this.require('input');
  return { pulse: client => this.host.pulse(client) };
}
```

  Add `PluginHost.pulse(client)`:

```ts
async pulse(client: ClientConnection): Promise<PulseResult> {
  const source = this.inputSource();
  if (!source) return { ok: false, reason: 'unavailable' };
  const known = this.clients.get(client.clientId);
  if (!known || known !== client || !known.connected) return { ok: false, reason: 'no-process' };
  let identity: ProcessIdentity | null = null;
  try { identity = source.identify(known.remotePort); } catch { identity = null; }
  if (!identity) return { ok: false, reason: 'no-process' };
  const first = this.identities.get(known);
  if (!first) this.identities.set(known, identity);
  else if (first.pid !== identity.pid || first.processStartTime !== identity.processStartTime) return { ok: false, reason: 'process-changed' };
  const window = source.findGameWindow(identity.pid);
  if (!window) return { ok: false, reason: 'no-window' };
  return pulseGameWindow(window, source);
}
```

  `inputSource()` returns `options.input` when it was provided (including `null`), else `win32GameInputSource()`. Log `win32GameInputError()` once at warn level the first time it's null.

- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run --configLoader native src/plugins src/input` and `npx tsc --noEmit`. Expected: PASS. Existing plugin-host tests stay green.

- [ ] **Step 5: Commit.** `git add src/plugins src/testing && git commit -m "feat: input capability for session-bound game-window pulses"`

---

### Task 3: `anti-afk` built-in plugin (default off) + docs

**Files:**
- Create: `plugins/anti-afk/detector.ts` (adapted from REC `client/src/util/antiAfk.ts`)
- Create: `plugins/anti-afk/settings.ts`
- Create: `plugins/anti-afk/index.ts`
- Test: `plugins/anti-afk/__tests__/antiAfk.test.ts`
- Modify: `plugins/index.ts` (append `antiAfk` last), `src/__tests__/api.integration.test.ts` (built-in count 5 → 6), `tools/smoke-package.ts` (count 5 → 6, message "six built-ins")
- Modify docs: `docs/design.md` (§2.1 Anti-AFK bullet, §2.2 capabilities line, §5 row 4), `README.md` (plugin list: Anti-AFK, off by default, what it does, the cursor note)

**Interfaces:**
- Consumes (Task 2): `ctx.input.pulse(client): Promise<PulseResult>`, `Capability 'input'`.
- Produces: plugin id `anti-afk`, setting `idleMinutes` (range 1–15, step 1, default 5); status data `status = { idleSeconds, pulses, lastPulse: { at: string; result: string } | null }`.

**Detector** (`detector.ts`, keyed by `ClientConnection` in a `WeakMap`, monotonic `performance.now()`):

```ts
// Adapted from realm-engine-client client/src/util/antiAfk.ts @ 88a66b2 (MIT, see NOTICE).
import type { ClientConnection } from '../../src/plugins/api.ts';

export const MAX_MOVE_GAP_MS = 10_000;
interface Observation { x: number; y: number; seenAt: number; idleSince: number }

/** Inactivity from client packets. Packet timestamps are not clocks; uses performance.now(). */
export class InactivityDetector {
  private sessions = new WeakMap<ClientConnection, Observation>();
  // A plain field, not a constructor parameter property (erasable syntax only).
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  clear(): void { this.sessions = new WeakMap(); }
  reset(client: ClientConnection): void { this.sessions.delete(client); }
  /** Any non-movement activity restarts the idle window (P4-3). */
  active(client: ClientConnection): void {
    const o = this.sessions.get(client);
    if (o) o.idleSince = this.now();
  }
  idleMs(client: ClientConnection): number | null {
    const o = this.sessions.get(client);
    return o ? this.now() - o.idleSince : null;
  }
  /** True once per idle window of `idleMs`; consumes the window. */
  observeMove(client: ClientConnection, records: unknown, idleMs: number): boolean {
    let position: { x: number; y: number } | undefined;
    if (client.connected && Array.isArray(records)) {
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r && !Array.isArray(r) && Number.isFinite(r.x) && Number.isFinite(r.y)) { position = { x: r.x, y: r.y }; break; }
      }
    }
    if (!position) { this.reset(client); return false; }
    const now = this.now(), previous = this.sessions.get(client);
    if (!previous || now - previous.seenAt > MAX_MOVE_GAP_MS || position.x !== previous.x || position.y !== previous.y) {
      this.sessions.set(client, { ...position, seenAt: now, idleSince: now });
      return false;
    }
    previous.seenAt = now;
    if (now - previous.idleSince <= idleMs) return false;
    previous.idleSince = now;   // consume even if the pulse later fails; never queue or retry
    return true;
  }
}
```

**Plugin** (`index.ts`):

```ts
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { InactivityDetector } from './detector.ts';
import { SETTING_DEFS, validate } from './settings.ts';

export function register(ctx: PluginContext): void {
  ctx.name = 'Anti-AFK'; ctx.category = 'utility';
  ctx.enabled = false;                                   // off until enabled (user ruling)
  const idle = new InactivityDetector();
  let pulses = 0, lastPulse: { at: string; result: string } | null = null;
  const skipLogged = new WeakMap<ClientConnection, string>();
  const publish = (client?: ClientConnection) => ctx.setData('status', {
    idleSeconds: client ? Math.floor((idle.idleMs(client) ?? 0) / 1000) : 0, pulses, lastPulse });
  for (const { key, ...def } of SETTING_DEFS) ctx.registerSetting(key, def);
  ctx.onEnabledChange(() => idle.clear());
  ctx.registerCleanup(() => idle.clear());
  ctx.on('clientConnected', client => idle.reset(client));
  ctx.on('clientDisconnected', client => idle.reset(client));
  for (const name of ['MAPINFO', 'RECONNECT']) ctx.observePacket(name, client => idle.reset(client));
  for (const name of ['PLAYERSHOOT', 'USEITEM', 'PLAYERTEXT', 'INVSWAP']) ctx.observePacket(name, client => idle.active(client));
  ctx.observePacket('MOVE', (client, packet) => {
    if (!ctx.enabled) return;
    const minutes = ctx.getSetting<number>('idleMinutes');
    if (!idle.observeMove(client, packet.isDefined ? packet.data.records : undefined, minutes * 60_000)) return;
    void ctx.input.pulse(client).then(result => {
      lastPulse = { at: new Date().toISOString(), result: result.ok ? `sent${result.minimized ? ' (minimized)' : ''}` : `skipped: ${result.reason}` };
      if (result.ok) { pulses++; ctx.log(`Inactive for ${minutes} min; click sent.`); skipLogged.delete(client); }
      else if (skipLogged.get(client) !== result.reason) { skipLogged.set(client, result.reason); ctx.log(`Pulse skipped: ${result.reason}.`); }
      publish(client);
    });
  });
}

export default definePlugin({ id: 'anti-afk', name: 'Anti-AFK', apiVersion: 1, capabilities: ['packets', 'input'], register,
  settings: { validate } });
```

`settings.ts`:
- `SETTING_DEFS`: one entry, `idleMinutes`: label "Click the game after this many minutes without activity", range 1–15, step 1, value 5, help "Exalt disconnects after about 20 minutes without input. The click shoots toward your cursor and is skipped while the cursor is over the game's buttons or panels."
- `validate`: `idleMinutes` must be a finite number, truncated and clamped to 1–15; anything else throws `TypeError('Invalid Anti-AFK <key>')`.

- [ ] **Step 1: Write the failing tests** (fake clock and a fake `ctx.input`, in the style of `plugins/server-messages/__tests__/serverMessages.test.ts`, plus one `startHost` test for default-off registration):
  - Registers **disabled** by default. With the plugin disabled, 6 minutes of stationary MOVEs send no pulse.
  - Enabled, `idleMinutes` 5: stationary MOVEs every 200 ms for 5 min 1 s give exactly one `pulse(client)`. Another 5 min gives a second.
  - A changed position at 4 min restarts the window (no pulse at 5 min, one at 9 min 1 s).
  - **Review Focus 4:** `PLAYERSHOOT`, `USEITEM`, `PLAYERTEXT` or `INVSWAP` at 4 min each restart the window.
  - A MOVE gap over 10 s, a `MAPINFO`, a `RECONNECT` or a reconnect event restarts the window.
  - **Review Focus 5:** disabling at 4 min 59 s means no pulse at 5 min. A pulse in flight when the client disconnects only updates status, and later MOVEs from that client do nothing.
  - A skipped result (`cursor-over-game-ui`) logs once per reason per session, not on every window. A sent result logs every time and increments `pulses`.
  - `validate` clamps `idleMinutes` (0 → 1, 99 → 15, 4.7 → 4) and rejects non-numbers and unknown keys.
  - The built-in list has six entries, with `anti-afk` last.

- [ ] **Step 2: Run them and see them fail.** Run `npx vitest run --configLoader native plugins/anti-afk`. Expected: FAIL.

- [ ] **Step 3: Implement** `detector.ts`, `settings.ts` and `index.ts` as above, then register in `plugins/index.ts` and update the two built-in counts.

- [ ] **Step 4: Docs.**
  - In `docs/design.md` §2.1, replace the Anti-AFK bullet with the verified design (out-of-process left click, no helper change, cursor guard; a posted F15 key press does not reset the idle timer).
  - In §2.2, add `input` to the capability example.
  - Set §5 row 4 to "**Anti-AFK — opt-in (off until enabled)**: inactivity detector + session-bound game-window pulse; no injection".
  - Add Anti-AFK to the README plugin list.

- [ ] **Step 5: Run everything.** Run `npx tsc --noEmit`, `npx tsc --noEmit -p ui`, and `npx vitest run --configLoader native plugins src/plugins src/input src/__tests__/api.integration.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit.** `git add plugins src/__tests__/api.integration.test.ts tools/smoke-package.ts docs/design.md README.md && git commit -m "feat: opt-in Anti-AFK built-in"`

---

### After the tasks (coordinator)

- Run `npm run check`, `npm run build:app`, and the package smoke with fake folders.
- **Live acceptance with the user:**
  1. Enable Anti-AFK in the UI.
  2. Stand idle in the Nexus with the game in the background for 30 minutes.
  3. Expect `[Anti-AFK] Inactive for 5 min; click sent.` about every 5 minutes, and no disconnect.
  4. Move the cursor over the inventory panel and confirm that the next pulse logs `Pulse skipped: cursor-over-game-ui`.
- Write `docs/handoff/<date>-phase4-handoff.md` and open the PR.
