# Research: Electron Shell, UI, Persistence, Build (realm-engine-client)

> Source: Codex read-only investigation of `realm-engine-client` @ `9ab4f8f`, 2026-10-03.
> Sizes are logical file sizes (KiB/MiB). No builds were run and runtime memory/startup was not measured.

## 1. Process model

| Component | Responsibility |
|---|---|
| Electron main (`client/electron/main.cjs`) | Frameless 1280×820 window, single-instance (Electron lock + Windows named-pipe lock), backend supervision, crash reporting, Steam auth, launcher credential import, multi-instance hosting, `multitool://` links |
| Renderer | Plain HTML/CSS/JS dashboard (`contextIsolation: true`, `nodeIntegration: false`, `preload.cjs` exposes `electronAPI`) |
| Backend process | Proxy orchestration, plugin host, config, HTTP/WebSocket dashboard (port **4440**), game launch, DLL bridge. Dev: `tsx src/index.ts --dev`; packaged: `utilityProcess.fork(dist/app.cjs)` with `child_process.fork` fallback. `devMode` always true. |
| Backend worker thread | Sockets, crypto/framing, Auto Nexus safety engine, Auto Drink controller (`postMessage` from `NetworkHost.ts`) |
| Injected DLL | Native features; `client/src/bridge/InternalBridge.ts` length-prefixed JSON over a named pipe |

UI ↔ backend is HTTP + WebSocket (not Electron IPC); `ws-message-types.js` holds generated message names.

Shell bloat: `instance-manager.cjs` (20 hosted instances), `window-host-bridge.cjs` (native addon / PowerShell window attach), `services/updater.cjs` (disabled by `fork-policy.cjs` but shipped), redundant `electron/loading.html`.

## 2. UI

`client/src/dashboard/public` → `dist/public`: 21 files, **10.46 MiB**; HTML/CSS/JS = 37,562 lines.

| File | KiB | Lines |
|---|---:|---:|
| `app.js` | 613.7 | 14,663 |
| `style.css` | 289.2 | 12,893 |
| `index.html` | 118.4 | 1,856 |
| `api-docs-tab.html` | 364.8 | 4,240 |
| `js/translations.js` | 118.9 | 1,726 |
| `eam-assets.json` (+ .gz) | 3,549 / 2,122 | – |
| `renders.png` | 3,137.8 | – |

Panels: Home, Plugins, Accounts, Internal, Logs, API, Objects, Tilemap, Game Wiki, Nearby Players, Packet Lab, Multibox, Mem Helper, Settings. Production builds hide dev features rather than removing them; EAM catalogs always load at startup.

**Keep:** 5 plugin toggles + schema-driven settings + hotkeys; launch button + exe selection + readiness (connection/DLL/backend); bounded log with actionable plugin errors; profile select/import/export; small plugin views (Chat Filter preview, automation status).
**Remove:** accounts/inventories/portraits, wiki, API iframe, packet lab, world inspectors, multibox, memory tuning, and their assets/services.

The five plugin bundles are ~67 KiB — savings come from removing infrastructure.

## 3. Persistence

| State | Location |
|---|---|
| Bundled defaults | `client/data/config.json` (`rotmgPath: null`, `lastPluginConfigId: "default"`, `singleClientOnly: true`) |
| Packaged config | `app.getPath('userData')/realm-engine/config.json` |
| Plugin profiles | `%USERPROFILE%/Documents/Realmengine/configs/*.json` |
| Accounts | `Documents/Realmengine/_accounts.json` (+ `Accounts/<id>.json`) — **plain-text passwords/secrets** |
| Extracted metadata | `Documents/Realmengine/data/` |
| User plugins | `Documents/Realmengine/Plugins/` |
| UI prefs | renderer `localStorage` |

- `client/src/util/clientConfigStore.ts`: shallow merge defaults + overlay; BOM-tolerant; atomic writes (temp, fsync, rename); preserves corrupt originals.
- `client/src/dashboard/server/PluginConfigService.ts` profile shape:
  ```json
  { "id": "default", "name": "default", "createdAt": 0, "updatedAt": 0,
    "plugins": [ { "id": "anti-afk", "enabled": true, "hotkey": "", "settings": { "antiAfk": true } } ] }
  ```
  800 ms debounced autosave on default profile; startup always loads `default`; profile writes are **not** atomic; migrates `admin-autododge` → `anti-afk`; per-plugin validation for Auto Drink, Auto Nexus, Chat Filter; optional `plugin-defaults.json` seed.

**Recommendation:** one RealmTool app-data dir, versioned profile schemas, atomic writes everywhere, import only retained plugins' settings, never auto-import credentials.

## 4. Game data

`client/data`: 28 files, 77.23 MiB.

| Data | Size | Needed? |
|---|---:|---|
| `objects.xml` | 30.87 MiB | Source for safety/projectile + consumable catalogs |
| `tiles.xml` | 2.86 MiB | Damaging-ground metadata (safety engine) |
| `images/*.png` | ~37 MiB | No |
| `spritesheet.xml` | 4.51 MiB | No |
| `enchantments.xml` | 0.93 MiB | No |
| Packet/stat definitions | ~68 KiB | Yes |
| `servers.json` | small | If keeping server selection |

Per plugin:
- **Anti-AFK:** protocol/session identity + DLL bridge; no catalogs.
- **Auto Nexus:** `client/src/game-data/GameDataLoader.ts` (~line 552) exports projectile lifetime, multi-hit, armor-pierce, %-HP damage, conditions, tile damage to the worker.
- **Auto Drink:** `client/plugins/auto-drink/catalog.ts` reparses raw object XML for consumability, heal/mana effects, Healing duration, quickslot eligibility.
- **Chat Filter:** none.
- **O3 Helper:** hard-coded object types 45363, 8701–8703, 9635 (patch-sensitive).

`gameVersion.txt` = 6.9.0.1.0. Extraction: `client/scripts/download-rotmg-xml-cli.ts` (local → CDN → mirrors) and `client/src/game-data/prepareGameDataCache.ts` at startup.

**Recommendation:** generate compact, build-identified safety + potion catalogs (JSON); keep extraction as a separate refresh step; don't ship images/raw XML in steady state.

## 5. Build and distribution weight

`client/scripts/build-prod.mjs`: clean → MSBuild game DLL + injector → esbuild backend (min CJS) → worker bundle → plugins as ESM → copy public. `koffi`, `sharp`, `electron` external. `javascript-obfuscator` unused. `build-native.mjs` (node-gyp Electron addon) currently stubs. `electron-builder.json`: NSIS + portable, ASAR + unpacked deps.

| Component (`release/main/win-unpacked`) | MiB |
|---|---:|
| Total | 524.72 |
| Main exe | 204.01 |
| Locales | 45.40 |
| Packaged data | 77.16 |
| Packaged UI | 10.46 |
| Unpacked Koffi | 82.10 |
| Sharp + `@img` | 19.05 |
| `app.asar` | 2.87 |

Backend bundle 750 KiB, worker 100 KiB. CI (`ci.yml`, `downstream-checks.yml`) never builds the full DLL or packaged app.

## 6. Startup / memory drivers to avoid

- Full synchronous XML parse before readiness (`GameDataLoader`, parsed-tree handoff held up to 120 s; Auto Drink reparses).
- Asset extraction (Sharp atlas processing) coupled to startup.
- Eager EAM catalogs in the renderer.
- Huge decoded images (`renders.png` ≈ 54.6 MiB RGBA; atlases 128 MiB each).
- `DevServer.ts` is 3,053 lines.
- 2 Hz player/status broadcasts, plugin dir watching, packet history.
- Portable self-extraction.

Koffi is used by `client/src/native/tcpProcessIdentity.ts` — trim its distribution (only win32-x64 binary) or replace those calls.

## 7. Shell recommendation (Codex)

| Option | Pros | Cons |
|---|---|---|
| Minimal Electron | Easiest migration | Chromium + Node footprint stays |
| **Tauri 2 + Node sidecar** | WebView2; keeps TS backend; compact shell | Rust toolchain; sidecar lifecycle; still ships Node |
| Node + browser UI | Least shell code | Needs a browser; weak lifecycle/tray |
| Native tray app | Smallest | Much more UI/native work |

Codex pick: **Tauri 2 + small TS/Vite UI + bundled Node backend**, keeping the worker thread and Node named-pipe DLL bridge. Memory savings are a hypothesis until measured.

Extensibility: keep `register(context)`/settings/lifecycle/cleanup from `client/src/plugins/PluginManager.ts`; add a per-plugin manifest (id, apiVersion, settings schema, capabilities); hot reload dev-only; timing-critical code stays in the worker.
