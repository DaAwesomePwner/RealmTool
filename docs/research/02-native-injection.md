# Research: Native / Injection / Game Launch (realm-engine-client)

> Source: Codex read-only investigation of `realm-engine-client` @ `9ab4f8f`, 2026-10-03.
> No builds, launches, injections, or native harnesses were run (only the read-only bridge-contract checker).

**Headline:** Auto Drink, Auto Nexus, Chat Filter and O3 Helper need **no** IL2CPP DLL — only connection routing. **Anti-AFK** is the only retained plugin needing in-process native code, and it uses plain Win32 window messages, not game offsets or IL2CPP. Smallest replacement: one **routing + Anti-AFK helper DLL** with no IL2CPP, DirectX, ImGui, memory reads, or generated headers.

## 1. Launch and loading

**Finding Exalt** — `client/src/hooker/ExaltFinder.ts` `find()` / `findAll()`, candidates must contain `RotMG Exalt.exe`:
1. `ROTMG_PATH`
2. `%LOCALAPPDATA%\RealmOfTheMadGod\Production`
3. `%USERPROFILE%\Documents\RealmOfTheMadGod\Production`
4. hard-coded standalone paths
5. hard-coded Steam libraries on C:/D:/E:, then Wine/Proton

Does **not** parse Steam `libraryfolders.vdf`. `GameHooker.resolveGamePath()` prefers configured path.

**Launching** — `client/src/dashboard/server/GameLauncher.ts`:
- `launchGame()` spawns exe, no args, cwd = install dir, detached.
- `launchGameWithCredentials()` passes `data:{...}` (platform Deca, Base64 identity/token, `env:4`, `serverName`) — optional.
- Optional Unity args (window size/pos, windowed, `-popupwindow`, `-nolog`).
- `ensureSteamAppIdFile()` writes `steam_appid.txt` from the Steam manifest so Steam doesn't replace the launched PID.

`instance-manager.cjs` (20 instances, window attach) and `direct-connect-link.cjs` (`multitool://`) are optional.

**Binaries:**

| Component | Role | RealmTool |
|---|---|---|
| `client/assets/winhttp.dll` | Side-loaded connect redirector (+ splash bypass) | Routing needed unless replaced |
| `client/assets/injector.exe` | `CreateRemoteThread` + `LoadLibraryA` into running Exalt | Optional if helper is side-loaded |
| `client/assets/realm-engine.dll` | IL2CPP runtime, overlay, diagnostics, Anti-AFK, more | Replaceable |
| `client/fast-loader/` | Splash-bypass DLL | Drop |

- `GameHooker.install()` copies `winhttp.dll` beside Exalt (backs up a different existing one); `index.ts` mirrors it into other detected installs.
- Redirector `client/winhttp-proxy/src/connect_hook.cpp`: MinHook on **`ws2_32!connect`**, redirects non-loopback IPv4 :2050 → `127.0.0.1:2050`, records destination in per-PID + legacy shared temp files.
- Big DLL injected on first `NEWTICK` by `DevServer.tryInjectDll()` — into **all** `RotMG Exalt.exe` PIDs.
- `version.dll` hijack is **historical**; README/patch docs are stale.

## 2. internal/ DLL and IPC

`DllMain` → `Run()`: resolve `GameAssembly.dll`, init IL2CPP, attach thread, hooks, IPC + unload threads.

Active hooks: `IDXGISwapChain::Present` + `ResizeBuffers` (Detours); game WndProc subclass via `SetWindowLongPtrW` (overlay input, keys, Anti-AFK routing). No retained feature uses an IL2CPP method detour. `dPresent()` does offset resolution, local-player discovery, HWID, camera/FPS, server selection, diagnostics, GUI. Anti-AFK init is coupled to DirectX window discovery (incidental).

**Main bridge** — `client/src/bridge/InternalBridge.ts` (Node pipe server) ↔ `IpcBridgeThread()` (DLL client):
- Pipe `\\.\pipe\lfg-dev-bridge`, protocol v3 (`bridge-v3`), 4-byte LE length + JSON.
- Heartbeat every 5 s both ways; 3 misses = disconnect.
- **No mutual auth / MAC** — "authenticated" means liveness only.
- Messages (`client/src/bridge/contract.ts`): `hello`, `heartbeat`, `heartbeatResp`, `setFeature`, `player`, `hotkeyEvent`, `unresolvedClasses`, `autoNexusStatus`, server-selection req/result.
- `BuildPlayer()` (`internal/src/core/ipc/IpcMessages.cpp`) publishes HP/maxHP/DEF/pos/etc. every 200 ms.
- Single connection; a new DLL replaces the old → not truly multi-instance.

**SafetyBridge** — `internal/src/core/ipc/SafetyBridge.cpp` → worker pipe `\\.\pipe\realm-engine-safety-v1` (`hello`, `bind`, `clock`, `health`). **Diagnostic only** (`NativeHealthObserver.trustedBasis = false`).

`check-bridge-contract.mjs` passed (18 DLL keys, 15 client-sendable, 3 DLL-only) — key agreement only.

`koffi` → `GetExtendedTcpTable` + `GetProcessTimes` to match proxy socket → PID + creation FILETIME; Anti-AFK checks this against DLL hello + bridge session token.

## 3. Native dependency per plugin

| Plugin | Mechanism | Native dependency |
|---|---|---|
| Anti-AFK | Stationary `MOVE` > 5 min → input pulse | **Yes:** process-bound Win32 pulse |
| Auto Drink | Worker; server stats/stock; sends `USEITEM` with client clock | Routing only |
| Auto Nexus | Worker `SafetyEngine` server HP / reported-impact; writes `ESCAPE` | Routing only (`SafetyEngine.native()` is empty) |
| Chat Filter | Prepended `TEXT` hook, `send=false` | Routing only |
| O3 Helper | Packet entities/phases; drops `ENEMYHIT` | Routing only |

Anti-AFK detail (`client/plugins/anti-afk.ts`, `internal/docs/anti-afk-native.md`): `getAntiAfkSession()` + `sendAntiAfkPulse()`; native `AntiAfk::RequestPulse()` posts private messages; `RouteWindowMessage()` forwards to the original WndProc as **left-button down/up 32 ms apart**; checks window ownership, physical button state, cancellation, stale tokens; excluded from replay. `AntiAfk.cpp/.h` ≈ 306 lines.

No plugin needs the overlay.

## 4. DLL-free?

Not with all five unchanged: removing `realm-engine.dll` kills Anti-AFK; removing `winhttp.dll` kills redirection. A DLL-free design (external redirect + external input broker) is conceivable but unvalidated; network keepalives don't prove the game's local idle check is satisfied.

**Smallest native surface:**
1. One `ws2_32!connect` hook.
2. One game-window subclass with Anti-AFK private-message routing + safe release/cancel.
3. Window discovery/lifecycle independent of `Present`.
4. Minimal IPC: `hello` (identity/capabilities), heartbeat/reply, replayable `antiAfkEnabled`, non-replayable `antiAfkPulse`.
5. Safe stop: cancel pending input, release any delivered button-down.

Drop: player stats, SafetyBridge, `autoNexusStatus`, server selection, IL2CPP headers, DXGI hooks, ImGui, projectile machinery. A single side-loaded helper DLL also removes `injector.exe`.

## 5. Patch maintenance, build, tests, size

Full DLL depends on generated IL2CPP headers, obfuscated names, runtime layouts (`RuntimeOffsets::EnsureAll()` with fallbacks). Workflow in `internal/docs/UPDATING_AFTER_GAME_PATCH.md` (regenerate 6 headers via Il2CppInspectorPro, offsets, aliases, XML, packet defs). `METADATA_REPAIR_7.0.md` is build-specific. **An IL2CPP-free helper avoids all header/offset maintenance**; wire format, XML, O3 constants and input acceptance still need checks.

Build: `internal/il2cpp-dll-injection.vcxproj` x64 MSVC C++20, PCH, `/EHa`, AVX2, falls back to v143 (v145 docs stale). Vendored Detours, MinHook, ImGui. Redirector/injector/fast-loader use C++17. `build-all.bat` stages binaries; `npm run build:native` is a stub for a missing Electron addon.

Tests: 9 runners `internal/tests/run-*.cmd` — standalone C++20 harnesses (`/W4 /WX`), no game needed (Anti-AFK, overlay input, safety bridge, player stats, Auto Nexus display, camera, server selection, world transitions, pool reader).

| Area | Files | Lines | Bytes |
|---|---:|---:|---:|
| `internal/src` excl. generated | 107 | 18,264 | 846 KB |
| Generated headers | 6 | 1,818,778 | 105 MB |
| Vendor | 31 | 68,471 | 3.6 MB |
| Native tests | 18 | 2,705 | 124 KB |
| `winhttp-proxy/src` | 10 | 933 | 36 KB |
| `AntiAfk.cpp/.h` | 2 | 306 | 12 KB |

Binaries: `realm-engine.dll` 2.0 MB, `winhttp.dll` 27 KB, injector 140 KB, fast loader 116 KB.

## 6. Recommendation

TypeScript plugin host + isolated network worker + **one small optional native helper** for routing and Anti-AFK. Narrow capability interface (not arbitrary feature keys). Single game process in v1 with PID+creation-time matching. Fix single-connection bridge ambiguity and legacy shared destination file before promising multi-instance.

Risks: routing readiness (3 s hook delay), input delivery when minimized/unresponsive, plaintext IPC trust (verify peer in replacement), protocol correctness (Auto Drink timing, O3 constants, collision HP), survival limits (local ESCAPE write ≠ server acceptance).
