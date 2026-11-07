# RealmTool

A lightweight launcher and companion for Realm of the Mad God Exalt, with a desktop UI for Auto Nexus, Auto Drink, Chat Filter and Server Switch.

RealmTool reuses selected, tested pieces of [realm-engine-client](https://github.com/DaAwesomePwner/realm-engine-client) (MIT). It drops the IL2CPP DLL, overlay, account manager, dashboard and 77 MiB of game assets.

**Status:** Phase 5 UI shell and installer implemented. The installed app measures 95.65 MiB against the 120 MiB budget. Live game smoke testing remains pending; see the [Phase 5 handoff](docs/handoff/2026-10-04-phase5-handoff.md) for validation and remaining checks.

## Install and first run

Run `RealmTool_0.1.0_x64-setup.exe` from `src-tauri/target/release/bundle/nsis/`. It installs for the current Windows user without an admin prompt. Node is bundled; WebView2 is shared with Windows and its bootstrapper needs internet if the runtime is missing. This installer is unsigned.

Close Exalt before starting RealmTool from the Start menu. The app automatically starts the proxy and installs or updates the helper in the selected game folder, backing up a foreign `winhttp.dll`. Check the game folder and readiness bar; if detection failed, enter the Exalt Production folder and click Start proxy. Click Launch to open your launcher, then Play as usual.

The readiness bar shows proxy/helper state, open and connected sessions, the active profile and any operation in progress. A connected session means an upstream connection exists; it does not prove that the helper is loaded in the game.

- Plugin cards offer enable toggles, settings, an Advanced disclosure and status. Invalid edits show the backend message; accepted values may be clamped by the plugin's validator.
- The log panel has a level filter and pauses autoscroll when you scroll up. It retains up to 1,000 records.
- Profiles can be created, selected and deleted. Switching restarts the proxy and disconnects a connected game after confirmation.
- Closing the window hides it to the tray while the proxy runs (with a notice on the first hide); otherwise it quits. Tray → Show reopens it; Tray → Quit shuts down the backend. The game and launcher survive quitting, although the proxy connection closes.
- Quitting leaves the helper installed. Close Exalt and stop the proxy before using Uninstall helper. Windows Settings uninstall also removes the helper and restores a backed-up `winhttp.dll`.

Local files live under `%APPDATA%\RealmTool`: `config.json` holds the game folder, launcher and active profile; `profiles\<name>.json` holds plugin settings; `logs\realmtool.log` rotates at 1 MiB with three files total (`realmtool.log`, `.1`, `.2`). Edit files only while RealmTool is stopped.

## CLI development usage

Requires Windows, Node ≥ 22.18, and Visual Studio 2022 C++ x64 tools to build the helper.

```sh
npm install
npm run build:helper
npm run verify:helper
npm start
```

`npm start` starts the proxy on port 2050, installs the helper into the detected game folder, and opens the RotMG Exalt Launcher (Deca, or Steam if that's how you installed it). Click Play as usual; RealmTool routes the game automatically. If game-folder detection fails, pass `--game-dir` with the Exalt Production folder: `npm start -- --game-dir "C:\path\to\Production"`.

Use `--launcher "C:\path\to\RotMG Exalt Launcher.exe"` to choose an explicit launcher, or `--no-launch` to open your launcher yourself: `npm start -- --no-launch`. Auto-detection prefers Deca, then falls back to Steam. If neither is found, RealmTool stays ready while you start the game the way you normally do.

Press Ctrl+C to stop the proxy. The helper stays installed until you remove it. Close Exalt, then run `node src/cli.ts uninstall-helper` to remove RealmTool's helper and restore the original `winhttp.dll` if one was backed up. Pass the same `--game-dir` when using an explicit game folder.

Do not run Realm Engine against the same game installation at the same time.

## Plugins (Phase 2)

- **Anti-AFK:** off by default. When enabled, posts one left click to the session's game window after 5 minutes without activity (configurable from 1–15 minutes) to prevent idle disconnects. The click shoots toward your cursor and is skipped while the cursor is over the game's buttons or panels outside the central safe box. It automates input without injection.
- **Chat Filter:** on by default. Its settings live in the profile. Edit them with RealmTool stopped, because RealmTool saves its own state on exit. `node src/cli.ts config-path` prints the profile location.
- **Server Switch:** `/con <server>` (names like `USWest`, abbreviations like `usw`, or an IPv4), `/goto <ip>[:port]`, `/ip`. Exalt's own server label doesn't change.

The profile is created on the first run that changes a setting. If it does not exist yet, create the folder and file at the location printed by `node src/cli.ts config-path`. Edit it only with RealmTool stopped. For example, this profile disables Server Switch and leaves Chat Filter at its defaults:

```json
{
  "schemaVersion": 1,
  "plugins": {
    "server-switch": { "enabled": false, "settings": {} }
  }
}
```

## Auto Nexus and Auto Drink (Phase 3b)

- **Auto Nexus:** on by default at 25%, with **Collision HP on by default**, including existing profiles without `PreHitPrediction`. It estimates HP from client collision reports in the network worker, with server HP authoritative. `/an [0-100]` shows or changes the threshold, `/nexus` requests a manual Nexus escape, and `/reset` explains that pending loss reconciles from server evidence and cannot be erased by command.
- **Opt out:** with RealmTool stopped, set `"PreHitPrediction": false` in `plugins.auto-nexus.settings` in the profile. Restart RealmTool; `/an` shows `Collision HP off` and Auto Nexus uses server HP only. Set it to `true` or remove the key to restore the default.
- **Auto Drink:** off by default; its settings are in the profile. Enable `auto-drink` with `"enabled": true` while RealmTool is stopped. The default HP threshold is 50%, with a minimum 400 ms interval between drinks. Profiles are applied once at startup; restart RealmTool after editing them.
- **Catalogs:** missing, invalid or stale catalogs trigger automatic refresh of Auto Drink and Collision HP data; app-data catalogs also require a matching file fingerprint. Automatic refresh waits for 60 seconds of unchanged game files. The app's **Refresh game data** button can request a manual refresh; developers use `npm run gen:catalogs` to update the bundled catalogs.
- **Safety catalog fallback:** known-stale data is withdrawn before refresh: Auto Nexus uses server HP only and reports `Collision HP FALLBACK`; Auto Drink is unavailable. Successful refresh reloads the catalogs live without dropping the connection.

Collision HP values are estimates. The server calculates damage independently of client reports; Collision HP and report suppression provide no survival guarantee.

See the [Phase 3b handoff](docs/handoff/2026-10-04-phase3b-handoff.md) for validation status, rulings and the live smoke test.

## When the game updates

RealmTool checks catalogs at proxy start, every 60 seconds while the proxy runs, and on each new game session. Either selected catalog being missing, invalid or for another build makes data stale. App-data catalogs also need a matching `source.json` fingerprint (build plus size/mtime of `resources.assets` and `boot.config`); matching bundled catalogs need no fingerprint. Automatic refresh waits until both files are unchanged for 60 seconds, logging `[Data] Game files are still changing; waiting to refresh` once per build without failing or delaying proxy start. The child re-checks those files and the build after extraction; changes fail with `game files changed during refresh; retrying later` and publish nothing. `source.json` is published last.

Use **Refresh game data** in the readiness area, `POST /api/refresh-data`, or `realmtool refresh-data [--game-dir <dir>] [--out-dir <dir>]` (dev: `node src/cli.ts refresh-data`) for a manual refresh. The CLI defaults to `%APPDATA%\RealmTool\data\catalogs\` and prints one JSON result line. Manual refresh skips the quiet period and the five-minute automatic retry wait; failures log at most one warning per five-minute window. Refresh took about 16 seconds on the owner's machine, producing catalogs byte-identical to bundled catalogs for the same build.

Check `[Data]` refresh results and `[Server Messages]` lines around a failed connection. Follow the [patch-day checklist](docs/patch-day.md) for exact log messages and to distinguish data changes from fixes that need a new release.

| Document | What it covers |
|---|---|
| [docs/design.md](docs/design.md) | Goals, budgets, architecture, plugin model, phases, open decisions |
| [docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md](docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md) | Step-by-step plan for Phase 1 (pass-through proxy) |
| [docs/research/](docs/research/) | How realm-engine-client's network, native, plugin and shell layers work |
