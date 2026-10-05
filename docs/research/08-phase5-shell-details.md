# Research: Phase 5 UI shell and packaging (RealmTool @ phase3b)

> Source: Codex read-only investigation of RealmTool `phase3b/collision-hp` @ `bc45f8f`, 2026-10-04. Sizes are logical file sizes; remote Node sizes are HTTP Content-Length observations.

Read-only investigation of `phase3b/collision-hp`. No files changed. Source inspection and an in-memory esbuild check completed; no packaged application, helper build, or live game test was run. Filesystem measurements below are live observations, not source-line assertions.

## 1. Backend lifecycle

`start` currently performs these steps:

1. Parse CLI options and resolve the game directory. An explicit `--game-dir` must contain `RotMG Exalt.exe`; otherwise discovery checks `ROTMG_PATH`, LocalAppData Production, Documents Production, then Steam roots and additional libraries. (`src/cli.ts:51`, `src/cli.ts:84`, `src/game/exaltFinder.ts:34`)
2. Preflight Koffi/TCP-owner lookup. Failure aborts before changing the game folder unless a public-IP fallback was supplied. Remove stale helper target files. (`src/cli.ts:124`)
3. Load protocol JSON, create `ProxyHost`, create `ProfileStore` and `PluginHost`, apply the startup profile, and subscribe to proxy events. (`src/cli.ts:139`)
4. Register SIGINT/SIGTERM and unexpected-worker-exit handlers, then await proxy listening. **The proxy starts before helper installation.** (`src/cli.ts:161`)
5. Install the helper. Identical DLLs remain unchanged; an existing RealmTool helper is updated; a foreign DLL is renamed to `winhttp.dll.realmtool-backup`. Installation stages the replacement and attempts backup restoration on failure. (`src/game/helperInstaller.ts:98`)
6. Unless `--no-launch`, discover and open the launcher. An explicit launcher or `ROTMG_LAUNCHER` takes precedence, followed by Deca registry/common paths and Steam app manifests. Deca is spawned detached; Steam opens a URI through Explorer. The user clicks Play. Missing discovery merely warns; an actual launch error ends the run. (`src/cli.ts:192`, `src/game/gameLauncher.ts:93`)
7. Wait for a signal, launch failure, or unexpected worker exit. Finally stop plugins, flush pending profile writes, stop the worker, and remove signal handlers. Worker shutdown closes sessions and its listener, with termination after two seconds if necessary. (`src/cli.ts:214`, `src/plugins/host.ts:194`, `src/transport/host.ts:122`)

**Shutdown does not uninstall the helper or stop the launcher/game.** `uninstall-helper` is a separate command: it removes only a marked RealmTool DLL, restores a backup where present, and leaves a foreign DLL alone. (`src/cli.ts:255`, `src/game/helperInstaller.ts:145`)

For the sidecar, extract an application controller exposing discovery/preflight, proxy start/stop, launch, helper inspection/install/uninstall, and final shutdown independently. The low-level functions already exist; `runProxy()` retains the host instances locally and resolves only when the CLI session ends. There is no stdin control protocol. Add explicit graceful shutdown and parent-death handling instead of relying solely on console signals. Recreate `PluginHost` on restart: its `stop()` removes subscriptions and cleanup handlers but does not clear its plugin registry, making repeated `start()` on the same instance unsuitable. (`src/cli.ts:93`, `src/plugins/host.ts:174`, `src/plugins/host.ts:194`, `src/plugins/host.ts:275`)

Discovery and helper operations also contain synchronous work—registry queries and an installer lock wait—so the UI needs an operation state and should avoid blocking its API event loop on these operations. (`src/game/gameLauncher.ts:34`, `src/game/helperInstaller.ts:48`)

## 2. Plugin host surfaces

### Schema, validation and persistence

`SettingDef` supports `number`, `boolean`, `range`, `select`, `text`, and `button`; labels/current values; help; multiline/rows/maxLength; min/max/step; select options; `hidden`, `advanced`, `transient`, `visibleWhen`, and cross-setting `warnWhen`. (`src/plugins/api.ts:10`)

Plugins register settings during `register(ctx)`. Generic validation checks types, finite numeric bounds, select membership, and text length; **step is presentation metadata, not enforced quantization**. A plugin's custom validator replaces generic validation. Auto Nexus/Drink clamp numeric settings; Chat Filter validates integers, list sizes, options and legacy regex syntax. Migration is plugin-owned. Buttons invoke callbacks with `true`; buttons and transient values are excluded from persistence. (`src/plugins/settings.ts:5`, `src/plugins/settings.ts:61`, `src/plugins/settings.ts:84`, `plugins/auto-nexus/settings.ts:20`, `plugins/auto-drink/settings.ts:26`, `plugins/chat-filter/settings.ts:89`)

The runtime `SettingsStore.definitions()` already returns definitions with current values, but `PluginHost.context()` exposes the narrower `PluginContext` interface, which has no schema enumeration method. Add a supported serializable plugin snapshot/schema API rather than accessing internal fields from HTTP handlers. (`src/plugins/settings.ts:53`, `src/plugins/host.ts:210`, `src/plugins/api.ts:69`)

### Data and enable/disable

- `setData(key,value)` stores a value in the plugin's in-memory map; `PluginHost.data(id)` exposes that map. It does not broadcast automatically.
- `broadcastData(type,data)` invokes optional `PluginHostOptions.onData(pluginId,type,data)`. The CLI supplies no callback, so broadcasts currently have no UI consumer.
- `ctx.log()` emits an info record tagged with the plugin name through the shared logger.
- Assigning `host.context(id).enabled` is the existing programmatic toggle. It invokes `onEnabledChange` listeners even for the same value and schedules persistence. Failed plugins cannot be enabled. Ordinary hooks, commands and connection callbacks are gated by enabled state; worker status messages continue while disabled.

There is no HTTP enable/disable endpoint, structured plugin-error inventory, or generic setting-change broadcast yet. (`src/plugins/host.ts:74`, `src/plugins/host.ts:123`, `src/plugins/host.ts:215`, `src/plugins/host.ts:256`, `src/plugins/host.ts:374`, `src/plugins/host.ts:400`, `src/cli.ts:150`)

### Complete current plugin inventory

Four plugins are statically registered. Anti-AFK and O3 Helper are deferred and have no current settings/data implementation. (`plugins/index.ts:1`, `docs/design.md:163`)

**Auto Nexus** — enabled by default through the host default:

| Key | Type / default | UI metadata |
|---|---|---|
| `PreHitPrediction` | boolean / true | Label: Collision HP |
| `ForceAutoNexusHealth` | range / 25 | 0–100, step 1; zero means confirmed server zero only |
| `ShowChatMessageOnNexus` | boolean / true | Advanced |
| `EscapeRetryCount` | range / 4 | Advanced; 0–10, step 1 |
| `EscapeRetryIntervalMs` | range / 400 | Advanced; 100–2000, step 50 |

**Published data keys: none.** It consumes worker `status` and `decision` events into a private per-client WeakMap and uses them for `/an`, logs and notifications. Events already include `catalog` and `collisionHp: on/off/fallback`; publishing a sanitized status snapshot is new work. (`plugins/auto-nexus/settings.ts:4`, `plugins/auto-nexus/index.ts:70`, `plugins/auto-nexus/messages.ts:12`)

**Auto Drink** — plugin defaults disabled:

| Key | Type / default | UI metadata |
|---|---|---|
| `enableHp` | boolean / true | Drink HP restoratives |
| `hpThresholdPct` | range / 50 | 0–95, step 5; warning when Auto Nexus threshold is at/above it |
| `drinkIntervalMs` | number / 400 | 400–5000, step 50 |
| `enableMp` | boolean / false | Advanced |
| `mpThresholdPct` | range / 50 | Advanced; 0–95, step 5 |
| `inventoryFallback` | boolean / false | Advanced |
| `healingOverTime` | boolean / false | Advanced |
| `slotPriority` | text / `1,2,3` | Advanced; each quickslot exactly once |
| `excludedItems` | text / empty | Advanced; decimal or hexadecimal item IDs |
| `diagnostics` | boolean / false | Advanced |
| `strictSettingsVersion` | number / 1 | Hidden; min/max 1 |

Stores **`status`** and broadcasts **`status`**. Fields are `enabled`, `state`, `reason`, `hp`, `maxHp`, `slotId`, `itemType`, `lastAttemptAt`, `cooldownRemainingMs`, `pending`, `epoch`, plus `clientId`. Catalog failure replaces the displayed reason. (`plugins/auto-drink/settings.ts:5`, `plugins/auto-drink/index.ts:14`, `plugins/auto-drink/index.ts:33`, `src/auto-drink/AutoDrinkTypes.ts:25`)

**Chat Filter** — host toggle and its own `enabled` setting are separate gates:

- Hidden number: `schemaVersion=1`.
- Booleans: `enabled=true`, `blockedWordsEnabled=true`, `advertising=true`, `trade=false`, `repetition=true`, `autoMute=false`, `publicChat=true`, `whispers=true`, `guildChat=false`, `partyChat=false`, `unknownChat=false`, `captureMessages=false`.
- Multiline text, initially empty: `blockedWords`, `allowedSenders`, `blockedSenders`, `whitelist`, `blacklist`; maximum 500 lines of 200 characters, overall 100,500 characters.
- Select: `wordMatch=contains`, options `contains/whole`.
- Numbers: `repeatCount=3` (2–20), `repeatWindowSeconds=20` (1–120), `muteMinutes=10` (1–120; visible when `autoMute=true`).
- Transient inputs: `previewMessage=''` (multiline, 2,000 characters), `previewSender=PreviewPlayer` (100), `previewChannel=public` (`public/whisper/guild/party/unknown`), `selectedSender=''` (100).
- Buttons: `testMessage`, `refreshStatus`, `clearMutes`, `unmuteSender`, `blockSender`, `allowSender`.
- Advanced: `whitelist`, `blacklist`, `repeatCount`, `repeatWindowSeconds`, `unknownChat`, `captureMessages`.

Stores **`status`**, broadcasts **`chatFilterStatus`**. Fields: `counts`, `recent`, `preview`, `actionResult`, `conflicts`, `mutes`. Recent entries are bounded to 100; message bodies are optional and truncated to 2,000 characters. Packet-driven publication is coalesced for 250 ms. (`plugins/chat-filter/settings.ts:5`, `plugins/chat-filter/settings.ts:36`, `plugins/chat-filter/index.ts:20`, `plugins/chat-filter/index.ts:47`, `plugins/chat-filter/index.ts:89`)

**Server Switch:** no registered settings and no published data keys; only its host enable toggle and `/con`, `/goto`, `/ip` commands. Preserve the explicit design exclusion of a server-selection dropdown. (`plugins/server-switch/index.ts:23`, `docs/design.md:27`)

## 3. Config, profiles and logs

Implemented persistence is `%APPDATA%\RealmTool\profiles\<name>.json`, falling back to the user's Roaming AppData path when APPDATA is absent. `ProfileStore` accepts a name, but the CLI always constructs the default store. There is no implemented app `config.json`, active-profile pointer, profile list/switch service, or saved game/launcher selection. These remain design requirements. (`src/config/store.ts:18`, `src/config/store.ts:107`, `src/cli.ts:150`, `docs/design.md:104`)

Profile writes are debounced 800 ms and use a same-directory temporary file, complete-write loop, fsync, close, then rename. Failed writes retain pending state for retry. Invalid files are renamed to `.corrupt-<timestamp>`; unreadable/future-version files and failed corrupt backups disable saving for the session. Unknown plugin entries survive snapshots. (`src/config/store.ts:27`, `src/config/store.ts:117`, `src/config/store.ts:150`, `src/plugins/host.ts:342`)

The logger supports console output and `addSink()`, but has no stored history, file writer, rotation or bounds. A bounded UI ring buffer and rotating file sink must be implemented; keep sink work isolated so a slow or throwing consumer cannot disrupt the host. (`src/util/log.ts:12`)

Handoff ruling **3a-5 explicitly excludes live profile switching and cross-module rollback**. Startup batches configs, but the worker applies modules sequentially and logs individual rejection; this is not a transaction. (`docs/handoff/2026-10-04-phase3a-handoff.md:49`, `src/transport/worker.ts:21`)

A live switch needs: validate/migrate the complete target profile before side effects; capture the old state; suppress intermediate callbacks/publications/saves; apply settings and worker configs with revisioned acknowledgement and rollback semantics; flush the old store; commit the active-profile pointer and selected store only after success. Profile names also need validation/path containment—the current constructor directly joins the supplied name. A simpler first-release option is profile selection applied through an explicit backend restart, clearly communicating any game disconnection. Neither workflow exists today.

## 4. Readiness signals

| UI state | Existing evidence | Missing work |
|---|---|---|
| Proxy listening | `start()` resolves with the port; `listening`, `fault`, `exit` events | Retained application-state snapshot and restart policy |
| Helper installed | Install result and `isRealmToolHelper(path)` marker check | Read-only inspection including absent/foreign/version mismatch/backup; installed must not imply loaded |
| Helper active | No heartbeat/pipe implementation in current helper; DLL starts its hook after a three-second delay | Do not display authenticated DLL readiness; show installation and observed connection separately |
| Game connection | `session`, `routed`, upstream `connected`, `closed` events | Track session count/generation and distinguish accepted local socket from upstream connection or in-game readiness |
| Plugin failure | Load failures disable the plugin; callbacks/config rejections log errors | Structured error state; failed plugins are omitted from `loaded()` and `context()` |
| Auto Drink | Published status, catalog reason and worker state | Structured catalog metadata, freshness/disconnection invalidation |
| Auto Nexus | Worker protection state, eligibility, HP age, stream age, attempt phase, catalog and Collision HP mode | Publish status/data and invalidate stale/disconnected samples |

Sources: `src/transport/host.ts:19`, `src/game/helperInstaller.ts:89`, `native/helper/src/dllmain.cpp:12`, `src/plugins/host.ts:206`, `src/plugins/host.ts:270`, `plugins/auto-drink/index.ts:33`, `plugins/auto-nexus/messages.ts:12`, `src/safety/SafetyTypes.ts:94`.

Catalogs prefer `%APPDATA%\RealmTool\data\catalogs\` overrides, then bundled files. An invalid existing override fails closed instead of silently using the bundled file. Both plugins compare catalog build against `RotMG Exalt_Data/boot.config`'s build GUID. Their loaded catalog object is retained; refresh rechecks the installed build rather than rereading catalog files. Auto Nexus fallback preserves the saved Collision HP setting and uses server HP. (`src/data/consumables.ts:45`, `src/data/safety.ts:80`, `src/game/gameBuild.ts:20`, `plugins/auto-nexus/index.ts:18`, `plugins/auto-drink/index.ts:16`)

## 5. Packaging blockers and bundle feasibility

**Bundling is feasible, but compiling alone does not produce a runnable package.** An esbuild in-memory build using `bundle:true`, `platform:node`, `format:esm`, `target:node22`, `external:['koffi']`, minification and `write:false` succeeded without warnings:

| Entry | Output bytes | Input modules |
|---|---:|---:|
| `src/cli.ts` | 82,285 | 41 |
| `src/transport/worker.ts` | 77,127 | 36 |

These bundles were not written or executed. The output still contains the development-relative URLs, including `./worker.ts`, `../../data/...`, and `../../native/helper/bin/winhttp.dll`.

Required packaging changes:

- Supply a packaged `worker.mjs` URL through the existing `workerUrl` option, or choose development/production worker paths explicitly. (`src/transport/host.ts:43`, `src/transport/host.ts:76`)
- Introduce a resource-root resolver for protocol JSON, servers, both catalogs and the helper DLL. Moving all code into one bundle changes every `import.meta.url` base. Server Switch reads its JSON during module initialization, so path initialization cannot happen only after importing the current plugin registry. (`src/protocol/schema.ts:9`, `plugins/server-switch/index.ts:12`, `plugins/server-switch/index.ts:68`, `src/data/safety.ts:81`, `src/game/helperInstaller.ts:11`)
- Built-ins use static imports, not a manifest/dynamic filesystem loader. Their main halves can live in the backend bundle, and worker halves are already a static registry. Separate built-in plugin bundles are optional. User `.mjs` loading remains Phase 6. (`plugins/index.ts:1`, `src/transport/workerModules.ts:1`, `docs/design.md:95`)
- Keep Koffi external with its JS loader/package metadata/license and `build/koffi/win32_x64/koffi.node`. It uses runtime filesystem lookup and dynamic native loading. The application loads it through `createRequire(import.meta.url)`, then calls `GetExtendedTcpTable`, `OpenProcess`, `GetProcessTimes`, and `CloseHandle` from Windows system DLLs. There is no separate native app-config loader in the inspected code. (`src/routing/tcpProcessIdentity.ts:83`, `node_modules/koffi/index.js:465`)
- Koffi 2.16.3 currently includes 18 native variants: Darwin arm64/x64; FreeBSD arm64/ia32/x64; Linux arm64/armhf/ia32/loong64/riscv64d/x64; musl arm64/x64; OpenBSD ia32/x64; Windows arm64/ia32/x64. Package only the matching Windows x64 runtime files.
- Build and ship the helper; `native/helper/bin` is absent here. Its build requires MSVC x64 and uses the static CRT (`/MT`). Replace developer-only recovery text such as “npm install” and “npm run build:helper” with packaged-app repair guidance. (`native/helper/build.cmd:5`, `native/helper/build.cmd:22`, `src/cli.ts:130`, `src/game/helperInstaller.ts:99`)
- esbuild 0.28.2 is installed transitively through Vite/Vitest, but is not a direct declared build dependency. Pin it directly for release tooling. The package currently has no backend/UI packaging script and no `ws` runtime dependency. (`package-lock.json:1113`, `package-lock.json:1544`, `package.json:10`)
- Add Tauri/Rust project configuration, frontend, sidecar supervision, resource staging, installer and clean-machine verification. Tauri sidecars use `externalBin` and target-triple-specific filenames; prefer Rust-owned spawning with narrowly scoped commands. [Tauri sidecar documentation](https://v2.tauri.app/develop/sidecar/)

Keep Windows system DLLs external to the application. Keep catalogs as packaged resources plus writable AppData overrides. Development tools, tests, raw XML tooling and non-Windows Koffi binaries do not belong in the installed runtime.

## 6. Sizes and the 120 MiB budget

Logical file sizes measured in this checkout:

| Component | Bytes | MiB |
|---|---:|---:|
| Entire `node_modules/koffi` | 28,750,096 | 27.4182 |
| Koffi `build/koffi/win32_x64` directory | 1,615,365 | 1.5405 |
| Its `koffi.node` alone | 1,612,288 | 1.5376 |
| All `data/` | 443,224 | 0.4227 |
| Both measured minified bundles | 159,412 | 0.1520 |
| `native/helper/bin` | Absent | Unmeasured |
| Installed Node 26.7.0, `C:\Program Files\nodejs\node.exe` | 103,173,960 | 98.3944 |

Koffi's loader, package JSON and license add approximately 0.022 MiB to its Windows x64 directory. Data comprises packet definitions 63,352 bytes, stat types 3,433, servers 554, consumables 9,773 and safety 366,112.

Local `node --help` exposes both **`--build-sea`** and **`--experimental-sea-config`**. SEA is an option, not a size reduction that removes Node itself. It also needs deliberate handling of worker code, native addons and assets. The current online documentation describes VFS support introduced in 26.9.0, which is newer than the installed 26.7.0; do not assume that feature exists locally. [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html)

Illustrative installed footprint using the brief's **estimated** 5–15 MiB shell, a conservative **estimated** 1–2 MiB allowance for backend/API/UI code, trimmed Koffi, current data, and the design's 200 KiB helper ceiling:

**98.39 + (5–15) + (1–2) + 1.56 + 0.42 + 0.20 ≈ 107–118 MiB.**

Thus **Node 26 can plausibly meet 120 MiB**, but the upper estimate leaves little margin. Full Koffi already brings Node plus Koffi to 125.81 MiB before the shell. Node 26 also cannot meet the separate 90 MiB headless target. (`docs/design.md:35`)

For comparison, read-only HTTP HEAD requests to official download binaries returned:

- [Node 22.23.3 Windows x64](https://nodejs.org/dist/v22.23.3/win-x64/node.exe): 86,973,768 bytes, **82.9446 MiB**; about **15.45 MiB smaller** than local Node 26. Same illustrative app estimate: **91–102 MiB**.
- [Node 24.21.0 Windows x64](https://nodejs.org/dist/v24.21.0/win-x64/node.exe): 93,580,104 bytes, **89.2449 MiB**; about **9.15 MiB smaller**. Same estimate: **98–109 MiB**.

These two figures are remote Content-Length observations, not downloaded or compatibility-tested binaries. Pin and test the chosen runtime with Koffi, worker startup and packaged paths.

The estimate assumes shared/system WebView2. A bundled fixed WebView2 runtime would invalidate it; Tauri documents substantial additional payload for fixed/offline distributions. Use the shared runtime with bootstrapper handling and document whether the size budget excludes shared prerequisites. Measure installed files, not the compressed installer. [Tauri Windows distribution documentation](https://v2.tauri.app/distribute/windows-installer/)

## 7. Local HTTP/WebSocket API security

Existing constraints are useful but do not constitute API authentication:

- Proxy host and worker enforce `127.0.0.1`; retain that restriction for a separate UI API listener. (`src/transport/host.ts:63`, `src/transport/worker.ts:35`)
- Game access tokens are used only in memory for server discovery. Fetch errors use controlled diagnostics rather than potentially token-bearing URLs/messages. HELLO plugin error paths withhold details. Preserve these rules for API responses, logs and crash reports. (`plugins/server-switch/directory.ts:91`, `src/plugins/host.ts:420`, `docs/design.md:160`)
- Safety decisions remain in the network worker; UI requests change configuration, not packet-time decisions. (`AGENTS.md:6`)

Recommended design, requiring implementation:

1. Let the Rust shell generate a cryptographically random per-launch bearer token and spawn the sidecar on an ephemeral loopback API port. Pass the token through a private child environment or inherited channel, and expose it only to the trusted webview through a narrow Rust command. Avoid argv, URLs, persistent storage and logs. If using an environment variable, remove it before spawning the game launcher so it is not inherited by unrelated child processes.
2. Require authentication on every sensitive HTTP operation and status/log subscription. Never reuse the game's access token. Validate methods, request schemas, plugin IDs, setting keys, profile names and launch targets; expose no arbitrary shell execution, file access or packet injection endpoints.
3. Check Host against the bound loopback authority and validate Origin against the exact packaged webview origin. Allow only explicitly configured development origins in development builds. Reject wildcard, reflected, arbitrary localhost and `null` origins. Authenticate requests even if Origin is absent; CORS alone is not authorization.
4. Allow only required HTTP methods and headers, including Authorization; require JSON for mutations and have no state-changing GET endpoints. Apply origin checks before mutations, not merely when writing CORS response headers.
5. Validate Origin on WebSocket upgrade independently of HTTP CORS. Browser WebSocket construction accepts URL and subprotocols, not an arbitrary Authorization header. Use an authenticated one-use upgrade ticket, or an initial authentication frame with a short timeout and no data/commands before authentication; do not put the long-lived bearer in a query string. Bound unauthenticated connections, frame sizes, queues and send rates. [WebSocket interface specification](https://websockets.spec.whatwg.org/)
6. Publish explicit JSON snapshots/events, never raw contexts, packet buffers or HELLO contents. Render logs and chat previews as text. Keep captured chat bodies transient and out of file logs. Add CSP and keep Tauri capabilities narrow.

These measures protect against other browser pages driving the backend; they do not create a security boundary against a compromised same-user native process.

## Risks and recommendations for the Phase 5 plan

- Build a clean-machine packaging spike first: pin Node, trim Koffi, resolve all resource paths, ship the helper, and verify installed size and WebView2 handling.
- Extract lifecycle control before wiring buttons; preserve independent launch, proxy stop and helper uninstall behavior.
- Add supported plugin schema/state/error APIs, publish Auto Nexus status, and invalidate stale readiness after disconnect or worker exit.
- Explicitly choose restart-based profile selection or implement acknowledged batch application/rollback; the current module batch is not transactional.
- Add bounded logs and an authenticated loopback API before exposing controls in the webview.
- Preserve the outstanding live Collision HP smoke-test gate; successful bundling does not validate gameplay or protection behavior. (`docs/handoff/2026-10-04-phase3b-handoff.md:5`)

## Evidence

- AGENTS.md:4-10 — Direct TypeScript execution, worker ownership, provenance and helper-build constraints.
- docs/design.md:31-40 — Installed size, catalog, helper, UI and startup budgets.
- docs/design.md:64-95 — Component boundaries, schema-driven shell and deferred user-plugin model.
- docs/design.md:104-116 — Intended app config, profile, catalog and rotating-log persistence.
- docs/design.md:140-174 — Release stack, Phase 5 scope, deferred plugins and helper coexistence rule.
- src/cli.ts:84-120 — Game directory selection and signal-based shutdown dependency.
- src/cli.ts:124-223 — Native preflight, startup ordering, helper installation, launcher behavior and shutdown without uninstall.
- src/cli.ts:255-272 — Separate helper commands and CLI process exit behavior.
- src/game/exaltFinder.ts:34-59 — Game installation discovery order and validation.
- src/game/gameLauncher.ts:34-117 — Registry and Steam discovery, explicit launcher selection and detached launching.
- src/game/helperInstaller.ts:6-19 — Helper resource path, backup names and result types.
- src/game/helperInstaller.ts:48-84 — Synchronous installer lock acquisition and wait.
- src/game/helperInstaller.ts:89-162 — Helper marker detection, safe backup/install and separate uninstall.
- src/plugins/api.ts:10-28 — Full SettingDef metadata.
- src/plugins/api.ts:60-111 — Worker channel, mutable enabled state, context API and plugin-owned validation/migration.
- src/plugins/settings.ts:5-24 — Generic validation and absence of numeric step quantization.
- src/plugins/settings.ts:42-102 — Schema enumeration, accepted updates, callbacks and persistable values.
- src/plugins/host.ts:74-137 — Enable callbacks, settings updates, data storage, broadcasts and plugin logging.
- src/plugins/host.ts:174-216 — Startup profile application, stop behavior and available host accessors.
- src/plugins/host.ts:256-348 — Broadcast sink, persistence, load errors, startup migration and snapshots.
- src/plugins/host.ts:374-405 — Enabled gating for connection events and continuing worker-message delivery.
- src/plugins/host.ts:420-478 — Credential-packet diagnostic suppression.
- plugins/index.ts:1-8 — Four statically imported built-in plugins.
- plugins/auto-nexus/settings.ts:4-38 — Complete Auto Nexus settings, defaults, metadata, validation and migration.
- plugins/auto-nexus/index.ts:18-57 — Catalog loading, fallback and configuration synchronization.
- plugins/auto-nexus/index.ts:70-108 — Private status cache and freshness checks; no UI data publication.
- plugins/auto-nexus/messages.ts:12-15 — Worker status/decision payloads with catalog and Collision HP mode.
- plugins/auto-drink/settings.ts:5-73 — Complete Auto Drink settings, defaults, validation and list parsing.
- plugins/auto-drink/index.ts:14-84 — Default-disabled behavior, catalog verification, status storage and broadcasts.
- src/auto-drink/AutoDrinkTypes.ts:25-37 — Auto Drink status fields.
- plugins/chat-filter/settings.ts:5-70 — Complete Chat Filter settings, labels, advanced/hidden/transient metadata.
- plugins/chat-filter/settings.ts:89-120 — Chat Filter validation and migration.
- plugins/chat-filter/index.ts:20-96 — Published status, action buttons, bounded recent messages and publication timing.
- plugins/server-switch/index.ts:12-68 — Eager server JSON load, chat commands and no settings/data registration.
- plugins/server-switch/directory.ts:84-114 — In-memory token use and controlled server-refresh diagnostics.
- src/config/store.ts:18-49 — AppData root and atomic JSON write implementation.
- src/config/store.ts:107-167 — Named profile path, default/debounce, corrupt/future-file handling and retryable saves.
- src/util/log.ts:12-41 — Console logger and synchronous sinks; no built-in history/file rotation.
- docs/handoff/2026-10-04-phase3a-handoff.md:49 — Ruling 3a-5 excludes live profile transactions and rollback.
- src/transport/host.ts:19-43 — Existing readiness events and configurable worker URL.
- src/transport/host.ts:59-94 — Loopback worker initialization and development worker.ts URL.
- src/transport/host.ts:113-130 — Config dispatch and bounded worker shutdown.
- src/transport/worker.ts:21-38 — Sequential per-module configuration and enforced loopback binding.
- src/transport/worker.ts:55-80 — Listening notification and session shutdown.
- src/transport/workerModules.ts:1-6 — Static built-in worker modules and priority order.
- src/safety/SafetyTypes.ts:94-114 — Protection, eligibility, HP and freshness status fields.
- src/data/consumables.ts:45-59 — AppData catalog override, bundled resource URL and failure behavior.
- src/data/safety.ts:80-93 — Safety catalog override, resource URL and validation failure behavior.
- src/protocol/schema.ts:9-15 — Protocol data resolved relative to import.meta.url.
- src/game/gameBuild.ts:8-34 — Installed game build GUID loading from boot.config.
- src/routing/tcpProcessIdentity.ts:67-114 — Koffi preflight, createRequire loading and four Win32 FFI calls.
- node_modules/koffi/package.json:3-35 — Installed Koffi version and loader metadata.
- node_modules/koffi/index.js:450-501 — Platform/architecture detection and runtime native-binary lookup.
- package.json:7-29 — Node minimum, existing scripts and runtime/development dependencies.
- package-lock.json:1113-1124 — Installed esbuild 0.28.2 metadata.
- package-lock.json:1538-1549 — Vite's transitive esbuild dependency.
- native/helper/build.cmd:5-28 — MSVC x64 requirements, static CRT and DLL output path.
- native/helper/src/dllmain.cpp:9-32 — Helper marker, delayed hook initialization and debug-only failure reporting.
- docs/handoff/2026-10-04-phase3b-handoff.md:5 — Phase 5 and live smoke-test release work remains.
