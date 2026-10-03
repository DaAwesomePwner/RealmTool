# RealmTool

A lightweight launcher and companion for Realm of the Mad God Exalt. Phase 1 provides a pass-through proxy; plugins are planned for later phases.

RealmTool reuses selected, tested pieces of [realm-engine-client](https://github.com/DaAwesomePwner/realm-engine-client) (MIT). It drops the IL2CPP DLL, overlay, account manager, dashboard and 77 MiB of game assets.

**Status:** Phase 1 pass-through proxy. No plugins yet.

## Phase 1 usage

Requires Windows, Node ≥ 22.18, and Visual Studio 2022 C++ x64 tools to build the helper.

```sh
npm install
npm run build:helper
npm run verify:helper
npm start
```

`npm start` starts the proxy on port 2050, installs the helper into the detected game folder, and launches Exalt. If detection fails, pass `--game-dir` with the Exalt Production folder: `npm start -- --game-dir "C:\path\to\Production"`.

Press Ctrl+C to stop the proxy. The helper stays installed until you remove it. Close Exalt, then run `node src/cli.ts uninstall-helper` to remove RealmTool's helper and restore the original `winhttp.dll` if one was backed up. Pass the same `--game-dir` when using an explicit game folder.

Do not run Realm Engine against the same game installation at the same time.

| Document | What it covers |
|---|---|
| [docs/design.md](docs/design.md) | Goals, budgets, architecture, plugin model, phases, open decisions |
| [docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md](docs/superpowers/plans/2026-10-03-phase1-passthrough-proxy.md) | Step-by-step plan for Phase 1 (pass-through proxy) |
| [docs/research/](docs/research/) | How realm-engine-client's network, native, plugin and shell layers work |
