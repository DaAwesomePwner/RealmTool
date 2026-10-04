# Phase 5 handoff — UI shell and installer

The desktop app combines a Tauri 2 window and tray, a supervised Node sidecar, an authenticated loopback API, schema-driven plugin cards, readiness, profiles and bounded logs. Four built-ins ship: Chat Filter, Server Switch, Auto Nexus and Auto Drink. Live game verification remains pending. No real game or launcher was opened by the integration work.

## Rulings and outcomes

U1–U5 were approved by the user as written on 2026-10-04.

| Ruling | Outcome |
|---|---|
| U1 | Pin Node 24 LTS, currently 24.21.0. Bundled runtime; approximately 6 MiB less headroom than Node 22, with a longer support life. |
| U2 | Profile switching saves selection and restarts plugins and proxy. The UI confirms a connected-game disconnect; this is not a live transactional switch. |
| U3 | Starting the proxy installs/updates the helper and backs up a foreign `winhttp.dll`. Quitting leaves it installed. Explicit helper uninstall and Windows uninstall restore the backup. Realm Engine remains blocked on that game install until the helper is removed. `serve` auto-starts the proxy without opening a launcher. |
| U4 | WebView2 uses `downloadBootstrapper`. Shared runtime is outside the installed-size budget; a machine without it needs internet during installation. |
| U5 | Per-user `currentUser` installation under `%LOCALAPPDATA%`, without elevation; each Windows user installs separately. |
| P1 | Rust spawns the sidecar; no JS process capability or shell plugin. The Job Object uses kill-on-close plus silent breakaway so the game and launcher survive RealmTool quitting. Suspended spawn closes the spawn/assign race. |
| P2 | As implemented: closing hides to tray while the proxy runs, otherwise quits. First hide displays a one-time notice. Tray offers Show and Quit. Quit requests `/api/shutdown`, waits up to 3 seconds, then Job Object cleanup kills the sidecar if necessary. |
| P3 | As implemented: stdout contains one `REALMTOOL_READY {"port":N}` line; other stdout and all stderr are piped and drained (never shown) by the shell. A null stderr crashes Koffi-loaded Node on exit. Logs go to memory/file. Stdin EOF or authenticated shutdown ends the sidecar. |
| P4 | UI installed-size budget is ≤ 120 MiB, measured 95.65 MiB. Headless ≤ 90 MiB is dropped for v1 because no supported Node fits; the development CLI remains available. |
| P5 | Generic schema-driven settings and status only. Plugin settings follow each plugin's validator: clamping counts as acceptance, with the stored value shown. Unknown/hidden keys and disabled-plugin buttons are rejected. |
| P6 | Memory ring: 1,000 records. Disk: `%APPDATA%\RealmTool\logs\realmtool.log`, rotating at 1 MiB with three files total. A throwing sink is detached with one warning. |

HTTP bearer authentication has one exception: CORS preflight (`OPTIONS`) has no bearer credential, but still requires the exact Host and an allowlisted Origin, returns only CORS headers and never reaches a route. WebSocket access uses a single-use, 30-second ticket from an authenticated POST. Listeners bind only to `127.0.0.1`; the API uses an ephemeral port, and the game proxy uses 2050. The per-launch token is removed from the sidecar environment before child processes can inherit it.

## Validation

Validation (coordinator, outside the sandbox, 2026-10-04, final branch state):
- `npx tsc --noEmit` and `npx tsc --noEmit -p ui` pass, and `npx vitest run` passes **1306 tests in 69 files**.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml` passes **11/11**, including on a checkout without `dist/`. The bundle resources live in `src-tauri/tauri.bundle.conf.json`, which only `tools/build-app.ts` passes to `tauri build --config`.
- The final installer was rebuilt with the stderr fix: `RealmTool_0.1.0_x64-setup.exe` 24.10 MiB, measured installed at **100,300,681 bytes (95.65 MiB)**. The silent uninstall removed the directory and the leftover install-location key.
- `node tools/smoke-package.ts` passed on the port-busy path (the user's Realm Engine holds 2050), with a clean exit code 0. The full path (running proxy, four built-ins) needs 2050 free; run it with Realm Engine closed.
- Every task was implemented by a Codex agent, verified by the coordinator and approved by an independent Codex review. Review fix rounds: T2, T5, T7, T8 (twice) and T9 (twice).

**Helper install targets (final whole-branch review fix):** `config.json` records `helperDirs`, every folder RealmTool installs its helper into. Every install path (desktop controller, CLI `start`, CLI `install-helper`) saves the target, plus `gameDir` on a first run, **before** modifying the game folder, and refuses if it can't save. The uninstaller's `uninstall-helper --quiet` restores every recorded folder and never a discovered one. Config writes re-read `config.json` immediately before the atomic write, and `helperDirs` changes only through add/remove operations. The tiny window between re-read and rename is an accepted residual.

**Exit crash found and fixed during validation:** a Node process whose stderr is a null handle crashes with 0xC0000409 on exit once Koffi is loaded (reproduced with a bare `require('koffi')` on Node 24.21.0 and 26.7.0). The shell now pipes and drains the sidecar's stderr, a Rust test with a Koffi-loading stub pins exit code 0, and the package smoke mirrors the shell's stdio.

Coordinator-measured build facts (not remeasured by the documentation worker):

- helper DLL 153,600 bytes;
- pinned Node 24.21.0 `node.exe` 93,580,104 bytes;
- installer `RealmTool_0.1.0_x64-setup.exe` 24.09 MiB;
- **installed 100,300,390 bytes (95.65 MiB)** against the 120 MiB budget;
- top files: node.exe 93.6 MB, realmtool-shell.exe 3.3 MB, koffi.node 1.6 MB, main.mjs.map 0.58 MB, safety.json 0.37 MB;
- silent uninstall removed the directory, and the user's `winhttp.dll` was unchanged;
- under the pinned Node 24, the bundled `selftest` passed, Koffi loaded, and `serve` printed READY.

The measurement gate refuses to run if RealmTool is already installed (T9 fix). The private installer is unsigned. User plugins, profile import and `refresh-data` remain Phase 6; O3 Helper and Anti-AFK remain post-release additions. There is no auto-updater.

The T10 integration test uses a real controller, PluginHost with built-ins, network worker, API and fake upstream. It isolates APPDATA, LOCALAPPDATA, ROTMG_PATH and temporary routing files; discovery is injected, and helper installation targets only the fake game. The injected host factory selects an ephemeral loopback port. Fake clients use the API-reported port, and shutdown is verified by rebinding the actual port used before shutdown. Coverage includes auth rejection, connected-session WebSocket state, Collision HP worker data and profile restart/flush. Three consecutive runs passed with `--configLoader native` (865 ms, 853 ms, 859 ms), and backend TypeScript checking passed again. UI TypeScript checking passed in the initial validation. The user's Realm Engine listener on 2050 was left untouched; integration tests neither connect to nor probe that port.

After T9, run `node tools/smoke-package.ts` from the built checkout. Before spawning, it checks port 2050 with a bind-and-close. When free, it requires a running proxy within 10 seconds and four nonfailed built-ins. When busy, it warns that it is checking the API only, requires a failed proxy with an address-in-use error and an empty plugin list. Both paths start the pinned runtime and bundled `serve`, verify READY, immediately assert that `/api/state` selects the temporary fake game before polling, request shutdown and check a clean process exit. The script sets temporary APPDATA, LOCALAPPDATA and ROTMG_PATH and never launches a game. The T10 checkout had no `dist/runtime/node.exe` or `dist/app/backend/main.mjs`, so both package smoke paths remain coordinator-run.

The initial `npm.cmd run check` passed both typechecks but could not start Vitest's default config loader: esbuild reported `Cannot read directory "../../../../..": Access is denied.` The integration runs use `--configLoader native`. The initial `git diff --check` passed. No product code was changed, and no full-suite result is claimed.

## Live smoke test (user, after merge)

0. Close Exalt. The app installs the helper into the game folder when it starts the proxy (U3). Close Realm Engine; it holds port 2050.
1. Run the installer from `src-tauri/target/release/bundle/nsis/`. No admin prompt.
2. Start RealmTool from the Start menu. The readiness bar shows the proxy running, the helper installed and the profile `default`.
3. Click Launch, Play, and enter a realm. Sessions show connected. Auto Nexus status shows `Collision HP on` with the catalog build.
4. Toggle Collision HP off in the card. `/an` in game says off. Toggle it back on.
5. Create profile `test`, switch to it (confirm the disconnect prompt), and reconnect. Settings show the new profile.
6. Close the window → it hides to the tray. Tray → Quit → the process is gone (Task Manager), and port 2050 is free.
7. Uninstall from Windows Settings → the helper is removed, and Realm Engine's `winhttp.dll` is restored if it was backed up.
