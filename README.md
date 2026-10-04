# RealmTool

A lightweight launcher and companion for Realm of the Mad God Exalt. Phase 3a adds worker-owned Auto Nexus and Auto Drink alongside Chat Filter and Server Switch.

RealmTool reuses selected, tested pieces of [realm-engine-client](https://github.com/DaAwesomePwner/realm-engine-client) (MIT). It drops the IL2CPP DLL, overlay, account manager, dashboard and 77 MiB of game assets.

**Status:** Phase 3a implementation; not releasable until Collision HP (Phase 3b) and the remaining release gates are complete.

## Usage

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

## Auto Nexus and Auto Drink (Phase 3a)

- **Auto Nexus:** on by default at 25% server HP. `/an [0-100]` shows or changes the threshold, `/nexus` requests a manual Nexus escape, and `/reset` explains that there is no estimated damage to reset in this phase. It uses the server HP threshold only until Collision HP (Phase 3b). **Don't rely on it yet.**
- **Auto Drink:** off by default; its settings are in the profile. Enable `auto-drink` with `"enabled": true` while RealmTool is stopped. The default HP threshold is 50%, with a minimum 400 ms interval between drinks. Profiles are applied once at startup; restart RealmTool after editing them.
- **Consumables catalog:** after a game update, run `npm run gen:catalogs` to regenerate `data/catalogs/consumables.json` from the installed game. For an explicit installation, use `npm run gen:catalogs -- --game-dir "C:\path\to\Production"`. Auto Drink only uses a valid catalog whose build stamp matches the installed game, checked at startup and on every new game connection while enabled (and again when enabled).

See the [Phase 3a handoff](docs/handoff/2026-10-04-phase3a-handoff.md) for validation status and the live smoke test.

| Document | What it covers |
|---|---|
| [docs/design.md](docs/design.md) | Goals, budgets, architecture, plugin model, phases, open decisions |
| [docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md](docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md) | Step-by-step plan for Phase 1 (pass-through proxy) |
| [docs/research/](docs/research/) | How realm-engine-client's network, native, plugin and shell layers work |
