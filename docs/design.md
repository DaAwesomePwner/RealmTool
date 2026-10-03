# RealmTool — Design Spec

**Status:** Draft v3 · 2026-10-03 (v2: Collision HP on by default and required to ship; Chat Filter ported from latest. v3: Anti-AFK deferred, helper is routing-only; server-authoritative hit model clarified)
**Repository:** private, `DaAwesomePwner/RealmTool`
**Source of ported code:** `DaAwesomePwner/realm-engine-client` (MIT, © Evergreen-Techworks; see `NOTICE`). Research was done at `9ab4f8f`. Each phase ports from the **then-current `main`**, so Chat Filter fixes such as `88a66b2` are included.
**Research inputs:** [`docs/research/`](research/) (four Codex read-only investigations of realm-engine-client)

## 1. Goal

RealmTool is a small, fast launcher and companion for Realm of the Mad God Exalt. It targets five plugins. The first release ships the four that need no code inside the game; **Anti-AFK is deferred** (Phase 4, optional, off the release gate):

| Plugin | What it does |
|---|---|
| **Server Switch** *(Phase 2 addition)* | `/con <server>` and `/goto <ip>` chat commands that move you to another server's Nexus through the proxy |
| **Anti-AFK** *(deferred)* | Prevents the game's idle disconnect with a single input pulse after >5 min without movement |
| **Auto Drink** | Drinks HP/MP potions from quickslots when *server-reported* HP/MP falls below a threshold |
| **Auto Nexus** | Sends ESCAPE when HP reaches the threshold (default 25%). It uses **Collision HP by default**: the game client's own collision reports (`PLAYERHIT`/`AOEACK`/`GROUNDDAMAGE`), assessed in the worker before the report is forwarded, with server-reported HP as the authoritative floor. Server-HP-only is an opt-out |
| **Chat Filter** | Hides spam, ads, blocked words and blocked senders, with optional temporary mutes |
| **O3 Helper** | Withholds hit reports on Oryx 3 while shielded, on coin guardians, and on Dammah while speaking |

It must be easy to add more plugins later, both built-in and user-supplied.

### Non-goals (v1)

- No in-game overlay, IL2CPP hooks, game-memory reads, or generated game headers.
- No account manager, credential storage, multi-boxing, wiki, packet lab, sprite rendering, or world inspectors.
- No server-switch UI (dropdown). The Server Switch plugin ships in Phase 2 with chat commands only (`/con`, `/goto`).
- No auto-updater.
- No security sandbox for user plugins (they are trusted code; documented as such).

### What "lightweight" means — measurable budgets

| Metric | Realm Engine today | RealmTool target |
|---|---|---|
| Installed size | 525 MiB (`win-unpacked`) | **≤ 120 MiB** with UI shell; **≤ 90 MiB** headless |
| Shipped game data | 77 MiB raw XML + atlases | **≤ 2 MiB** generated JSON catalogs |
| Native binaries | 2 MiB IL2CPP DLL + injector + redirector | **One** helper DLL ≤ 200 KiB, no injector |
| Dashboard source | ~37.5k lines HTML/CSS/JS | **≤ 3k lines** |
| Patch-day work | regenerate 1.8M lines of IL2CPP headers + offsets | packet defs + catalogs + O3 constants only |
| Backend startup to "listening" | full XML parse first | **< 1 s**, no XML parse at startup |

## 2. Architecture

```
┌──────────────┐  ws2_32!connect hook   ┌───────────────────────────── Node backend ─────────────────────────────┐
│ RotMG Exalt  │──── 127.0.0.1:2050 ───▶│  Network worker (worker_threads)          Main thread                  │
│  + helper    │                        │  ─────────────────────────────           ──────────────────            │
│  winhttp.dll │◀── named pipe ────────▶│  sockets · RC4 · framing · ordering       ProxyHost (worker client)    │
│ (routing     │   (later, optional)    │  Router (HELLO/RECONNECT handoff)         PluginHost + 5 plugins       │
│  only)       │                        │  Interest-gated forwarding                Config/profile store         │
└──────────────┘                        │  Worker modules: Auto Nexus, Auto Drink   Helper bridge (pipe server)  │
                                        │                                           Local API (HTTP+WS) for UI   │
                                        └────────────────────────────────────────────────────────────────────────┘
                                                                     ▲
                                                                     │ localhost HTTP/WS
                                                          ┌──────────┴──────────┐
                                                          │ UI shell (Phase 5)  │
                                                          │ Tauri 2 + WebView2  │
                                                          └─────────────────────┘
```

### 2.1 Components

1. **Helper DLL (`native/helper`)** — side-loaded as `winhttp.dll` next to `RotMG Exalt.exe`, forwarding all real winhttp exports. It does two things only:
   - **Routing:** MinHook on `ws2_32!connect`; redirects non-loopback IPv4 port-2050 connections to `127.0.0.1:2050` and records the original IP in `%TEMP%\realmtool_target_<PID>.txt`. (Ported from `client/winhttp-proxy`, minus splash bypass, IL2CPP and the legacy shared file.)
   - **Anti-AFK input (Phase 4, deferred):** the helper is **routing-only** until Phase 4. Try the no-injection route first: RealmTool's own process finds the game window by PID and posts a left-button down/up pair 32 ms apart (koffi `PostMessageW`), the same messages Realm Engine's DLL routes to the original WndProc. Only if live testing shows the game ignores out-of-process messages does the helper gain an `EnumWindows` + WndProc subclass, with the same safety checks as `internal/src/.../AntiAfk.cpp`.
   - Talks to the backend over `\\.\pipe\realmtool-helper` with 4-byte LE length + JSON: `hello` (pid, process creation FILETIME, protocol version, capabilities), `heartbeat`/`heartbeatResp`, `antiAfkEnabled` (replayable), `antiAfkPulse` (session-bound, non-replayable).
   - Builds with plain `cl.exe` (no MSBuild solution, no vcxproj), MinHook vendored.
2. **Network worker** — one `worker_threads.Worker` that owns every socket, all four RC4 streams, framing, per-direction ordering and connection generations. New relative to Realm Engine:
   - **Routing lives in the worker** (`Router`): HELLO key restore and RECONNECT rewrite happen at the final writer, so *any* RECONNECT to the game (server-sent or plugin-injected) is rewritten in one place. Route tokens are bounded (≤ 64) and expire (120 s) — fixing the unbounded `Proxy.states` map.
   - **Interest-gated forwarding:** the main thread declares which packets it needs to *decide on* (verdict) or merely *see* (observe). Everything else is forwarded by the worker without a main-thread round trip. Ordering is still preserved per direction.
   - **Worker modules:** a small, explicit hook surface (`suppressEntry`, `observe`, `allowWrite`, `written`, `connectionChanged`, `tick`, `command`, `close`) through which time-critical plugins (Auto Nexus, Auto Drink) run *beside the sockets*, before any main-thread work. This replaces Realm Engine's hard-wired `SafetyEngine`/`AutoDrinkController` calls inside `network-worker.ts`.
3. **Main thread** — `ProxyHost` (typed worker client), `PluginHost`, config/profile store, helper bridge (pipe server + PID/creation-time session identity via koffi), and a small local HTTP+WebSocket API for the UI.
4. **UI shell (Phase 5)** — Tauri 2 window + tray using WebView2, with the Node backend as a sidecar. It renders plugin toggles and settings from each plugin's settings schema, plus a launch button, readiness indicators, a bounded log and profile selection. The backend is fully usable headless (CLI) before the shell exists.

### 2.2 Plugin model (the extensibility story)

Every plugin is a folder with a manifest and one or two entry points:

```
plugins/chat-filter/
  manifest.json      { "id": "chat-filter", "name": "Chat Filter", "apiVersion": 1,
                       "main": "index.ts", "worker": null,
                       "capabilities": ["packets", "commands", "notifications"] }
  index.ts           export default definePlugin({ register(ctx) { ... } })
plugins/auto-nexus/
  manifest.json      { ..., "main": "index.ts", "worker": "worker.ts", "capabilities": ["worker", "packets", "commands"] }
  index.ts           settings, status, commands  (main thread)
  worker.ts          export default defineWorkerModule({ ... })  (runs in the network worker)
```

- **Standard plugins** (`main` only) run on the main thread through `register(ctx)`. They can hook packets with verdicts (pass/drop/modify), observe packets, register chat commands, inject packets, send in-game notifications, declare a typed settings schema, publish status for the UI, and use monotonic timers. Chat Filter, O3 Helper and (later) Anti-AFK are standard plugins.
- **Realtime plugins** also ship a `worker` module that is **bundled into the network worker at build time** (built-in only; user plugins can't add worker code). The `main` half and the `worker` half talk over a typed per-plugin message channel. Auto Nexus and Auto Drink are realtime plugins. Worker modules run in a fixed priority order (Auto Nexus = 0, Auto Drink = 10), so ESCAPE is always written before anything else sees the packet.
- **Capabilities** in the manifest gate what the context exposes (e.g. only plugins declaring `input` get `ctx.input.pulse()`), which keeps future plugins honest and makes reviews easy.
- **User plugins** (Phase 6) are `.mjs` folders with the same manifest in `%APPDATA%\RealmTool\plugins\`, loaded at startup; hot reload is dev-only. They are trusted code with no sandbox, and the docs say so.
- Settings migration/validation lives **in each plugin's definition** (`settings.migrate`, `settings.validate`), not in host `if (pluginId === …)` branches.

### 2.3 Data

- `data/packet-definitions.json` + `data/stat-types.json` — canonical, copied from Realm Engine, with a drift check script.
- `data/catalogs/consumables.json` (Auto Drink) and `data/catalogs/safety.json` (Auto Nexus Collision HP: projectiles + damaging tiles) are **generated** by `tools/gen-catalogs.ts` from the game's `objects.xml`/`tiles.xml`. Each records the game build it came from. The runtime never parses XML. `realmtool refresh-data` regenerates from the local install.
- O3 constants (Oryx 45363, guardians 8701–8703, Dammah 9635, shield stat 125) move into `plugins/o3-helper/constants.ts`, with a patch-day checklist entry.

### 2.4 Persistence

One directory: `%APPDATA%\RealmTool\`

```
config.json            app config (game dir, launch options, active profile, schemaVersion)
profiles/<name>.json   { schemaVersion, plugins: { <id>: { enabled, settings } } }
plugins/               user plugins (Phase 6)
data/                  refreshed catalogs (override bundled)
logs/realmtool.log     rotating, bounded
```

All writes are atomic (temp file → fsync → rename) and keep a `.corrupt-<ts>` copy if parsing fails. A one-time importer (Phase 6) reads `Documents/Realmengine/configs/*.json` for the five plugins only. It never imports accounts or credentials.

## 3. Behavior that must be preserved (from FORK.md)

These are acceptance criteria for the Auto Nexus / Auto Drink port (Phase 3), each pinned by ported tests:

1. **RealmTool deliberately diverges from FORK.md here:** Collision HP (saved key `PreHitPrediction`) is **ON by default**, for new profiles and for imported profiles that never set it. An explicit OFF from an imported profile is respected. New/reset threshold is **25%**. ON = latest server HP minus assessed loss from client collision reports, checked synchronously on report receipt, before forwarding. OFF = server HP threshold only. 0% requires an explicit server-reported zero in both modes.
2. Server DAMAGE never double-charges a reported projectile; changing Collision HP retires estimated debt but keeps server HP and escape lifecycle.
3. The stalled-delivery fail-safe applies only while a reported impact is pending, and excludes plugin-dropped packets.
4. **ESCAPE is written by the worker before plugins, observers or UI see the packet**, and stays responsive when the main thread is blocked.
5. Escapes use normal ESCAPE + server-authorized RECONNECT only. Retries are bounded (default **4 × 400 ms**): initial write plus up to four retries, no catch-up bursts.
6. After an accepted **automatic** ESCAPE, the worker suppresses exactly `PLAYERHIT`, `AOEACK`, `GROUNDDAMAGE`, `MOVE` on that TCP connection. It checks at entry (after decryption, consuming input RC4) and again at the final writer (before output RC4). Only a new TCP connection releases it. A manual ESCAPE alone does not arm it. *(Kept for parity with Realm Engine's tested behavior. It is **not** a survival mechanism: the server calculates hits itself whether or not reports arrive. The user verified this on 2026-10-03 by omitting outbound hit packets.)*

**Hit model (verified 2026-10-03).** The server is authoritative for damage: it calculates bullet hits itself, and the client's `PLAYERHIT`/`AOEACK`/`GROUNDDAMAGE` reports are redundant to it. Collision HP still works because the client's local collision check fires at about the same moment the server registers the hit. That is well before the HP drop arrives in a server stat update, and that gap is what Collision HP closes. Server HP stays the authoritative floor in both modes. **Open check for Phase 2:** O3 Helper works by withholding `ENEMYHIT`. Confirm in game that the server honors withheld enemy-hit reports during the shield and Dammah phases, since it may also calculate those itself.
7. Auto Drink uses server stats 0/1/3/4 (never `effectiveMaxHealth`), awards no predicted healing, derives USEITEM time from accepted MOVE/PONG/PLAYERSHOOT, and is disarmed by an escape for that TCP generation.

Known Realm Engine defects to **fix** during the port, each with a regression test:

- O3 Helper: `canHit()` returns inside the `ignoreCoins` branch, skipping the Dammah check.
- O3 Helper: with no `SHOWEFFECT` decoding, coin filtering blocks all three guardians (there is no active-coin exception). Decide in Phase 2 whether to decode SHOWEFFECT or document the limitation.
- Routing: hard-coded USWest fallback IP disagrees with `servers.json`. RealmTool has **no** hard-coded fallback; it uses an explicit `fallbackServer` config or fails the session with a clear message.
- Routing: reconnect-state map never expires (fixed by the bounded/TTL Router).
- Profiles: writes aren't atomic (fixed by the store).

## 4. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22.18 (dev machine has 26.x) | Native TypeScript type-stripping: no `tsx`, and the worker runs from `.ts` in dev |
| Language | TypeScript 5.9, `erasableSyntaxOnly`, `.ts` import specifiers | Runs unmodified under Node type-stripping; esbuild bundles for release |
| Tests | Vitest | Same as Realm Engine; the existing tests port over |
| Native interop | `koffi` (win32-x64 only in the package) | TCP-owner → PID + creation time, as Realm Engine does today |
| Native build | MSVC `cl.exe` x64, C++17, vendored MinHook | Same as `winhttp-proxy/build.bat`; no vcxproj |
| Bundling | esbuild (backend + worker + plugins) | Already used upstream |
| UI shell | **Tauri 2** (decision point at Phase 5; minimal Electron is the fallback) | WebView2 instead of bundled Chromium |
| Dependencies (runtime) | `koffi`, `ws` | Nothing else. No sharp, no fast-xml-parser at runtime (catalog generator only), no electron-updater |

## 5. Phases

Each phase ends with working, tested software. **Release gate:** Phases 1, 2, 3a, 3b and 5 (Phase 4 / Anti-AFK is optional). Never ship Auto Nexus without Collision HP. Detailed plans live in `docs/superpowers/plans/`. Only Phase 1 is written in full now; each later plan is written when its phase starts, against the real code produced by the phases before it.

| # | Phase | Deliverable | Key risks |
|---|---|---|---|
| 1 | **Pass-through proxy** | `node src/cli.ts start` installs the helper, launches Exalt, and proxies all traffic through the worker with HELLO/RECONNECT routing. You can play normally, change realms, and enter dungeons. | Routing parity; helper load timing (3 s hook delay) |
| 2 | **Plugin host + Chat Filter + O3 Helper + Server Switch** | Plugin API v1, manifest loader, config/profile store, commands, notifications; two standard plugins ported with tests (O3 bugs fixed). The plugin API lets a plugin observe the game's HELLO. **Server Switch** (small addition, chat commands only): `/con <server>` and `/goto <ip>[:port]`. The server list comes from the official endpoint using the access token from the observed HELLO, falling back to bundled `servers.json`. The token is **held in memory only, never logged or persisted**. A switch injects one RECONNECT to the game (server IP, port 2050, name Nexus, gameId -2, empty key). The worker's Router rewrites it like any other RECONNECT, so the game reconnects through the proxy to the chosen server. Exalt's own server label not updating is accepted (cosmetic). Chat Filter is ported from latest `main` with its current rules and tests, not rewritten | API shape — it must survive Phases 3–6 unchanged |
| 3a | **Realtime plugins: Auto Nexus (server HP) + Auto Drink** | Worker-module API; SafetyEngine, escape coordinator, report guard and AutoDrinkController ported; consumables catalog; FORK.md guarantees pinned by ported tests. Auto Nexus runs server-HP-only in this step | Safety-critical; must port, not rewrite |
| 3b | **Auto Nexus Collision HP (default ON)** | HealthPredictor/DamageLedger ported; safety catalog (projectiles, armor-pierce, multi-hit, damaging tiles) generated; collision assessment on PLAYERHIT/AOEACK/GROUNDDAMAGE receipt in the worker; stalled-delivery fail-safe; default flipped to ON; ported hpPrediction/playerDamage/strictHp/safetyLifecycle tests plus a default-ON regression test. **Required before any release** | Catalog freshness per game build; uncalibrated AoE/ground and %-HP damage (documented assumption: max(200, raw) per unknown hit) |
| 4 | **Anti-AFK (deferred, optional)** | First attempt: out-of-process `PostMessageW` click to the game window found by PID (no injection). Fallback only if needed: helper v2 with a WndProc subclass + pipe. Then the Anti-AFK plugin | Does the game accept out-of-process input? Needs live validation |
| 5 | **UI shell + packaging** | Tauri 2 app: plugin cards with schema-rendered settings, launch, readiness, log, profiles; installer; size budget verified | Sidecar lifecycle; WebView2 availability |
| 6 | **User plugins + polish** | `.mjs` user plugins, plugin dev guide + example, Realm Engine profile importer, `refresh-data`, patch-day checklist | — |

## 6. Decisions made (with defaults) — confirm or override

1. **Shell = Tauri 2** (Rust toolchain needed for Phase 5 only). Alternative: minimal Electron (bigger, but zero new toolchain). The backend is headless-first, so this can change before Phase 5 at no cost.
2. ~~Collision HP optional~~ **Decided 2026-10-03:** Collision HP is ported as-is and **ON by default**. Server-HP-only is the opt-out. It runs entirely in the worker from the game's own collision reports, so it needs no injected code. It must be wired and smoke-tested (Phase 3b) before any release.
3. **One game client at a time** in v1. The worker already supports many sessions; the native bridge and session identity are built PID-aware so multi-client can be enabled later.
4. **RealmTool and Realm Engine can't run against the same game install at the same time.** Both side-load `winhttp.dll`. The installer backs up a foreign `winhttp.dll` and restores it on uninstall.
5. **Port with provenance, not git-fork.** RealmTool is a fresh repo; ported files carry a header comment naming their source path, and `NOTICE` keeps the MIT attribution.
