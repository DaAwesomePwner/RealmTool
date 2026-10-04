# RealmTool handoff — Phase 2 complete (2026-10-03)

## Where things are

| Item | State |
|---|---|
| Repo | `github.com/DaAwesomePwner/RealmTool` (private) |
| `main` | **Phases 1 and 2 merged.** PR #1: pass-through proxy, routing helper DLL, launcher-based `npm start`. PR #2 (merge commit `998ea6d`): plugin host, profile store, Chat Filter, Server Switch, CLI wiring. 331 tests, Windows CI green |
| Live test | Passed on 2026-10-03: `npm start` → launcher → Play → Nexus, `/con` changed servers (`(transfer)` route), Nexus ad spam hidden, clean Ctrl+C shutdown, no profile written without a setting change |
| Next phase | **3a:** Auto Nexus (server HP) + Auto Drink as worker modules. Its plan is written when the phase starts (see "How to continue") |
| Design | `docs/design.md` (v4). Research in `docs/research/` |
| Process | `docs/process/codex-sdd/README.md`: how tasks are dispatched to Codex through Orchestra, contracts, gotchas |

### Phase 2 summary

| Task | What | Outcome |
|---|---|---|
| 1 | HELLO observable (read-only) | review clean |
| 2 | Plugin API types + SettingsStore | 1 fix round |
| 3 | Profile store (atomic, corruption-safe) | 1 fix round |
| 4 | Player identity tracker | review clean |
| 5 | Plugin host | 1 fix round |
| 6 | Chat Filter port (62/62 original tests) | review clean |
| 7 | Server Switch (`/con`, `/goto`, `/ip`) | 1 fix round (token-safe failure logs) |
| 8 | CLI wiring, `config-path`, README | review clean |
| — | Final whole-branch review (Codex `--effort high`) | 3 Important + 1 Minor fixed in one wave; 1 Minor parked |
| — | PR bot review | 1 fix (profile schema version); 1 finding not applicable (see rulings) |

## Decisions the user made (binding)

- **Implementation and review run on Codex agents** (save Claude usage), **up to 3 in parallel**. Claude is the controller only.
- **Delegate Codex agents through Orchestra** (`orchestra@local`), not by calling `codex-companion` directly (decided 2026-10-03, mid-Phase 2). Reviews stay on Codex too (`review --agent codex --allow-same-family`).
- **First release ships:** Auto Drink, Auto Nexus, Chat Filter, Server Switch. **Release gate:** Phases 1, 2, 3a, 3b, 5.
- **Auto Nexus uses Collision HP ON by default**, built from the client's PLAYERHIT/AOEACK/GROUNDDAMAGE reports in the worker, with server HP as the floor. It **must be wired before any release** (Phase 3b).
- **The server is authoritative for damage.** The user verified that omitting hit packets doesn't stop damage. Collision HP is an early warning, not prevention; suppressing reports after an escape is only for parity.
- **O3 Helper and Anti-AFK are post-release additions.** They are not release gates.
- **Server Switch** is chat commands only, with no UI. The access token is used in memory only and is never logged or saved. Exalt's own server label not updating is fine.
- **Launching:** never start `RotMG Exalt.exe` directly. `npm start` opens the **Deca RotMG Exalt Launcher** (the user's normal path), with Steam as a fallback.
- **Packet recording** is deferred until it's relevant (Phase 3b's safety event recorder).
- PRs merge with a merge commit.

## Phase 2 rulings

Carried from Tasks 1–5:

- Plugin "manifest" = fields of `definePlugin({ id, name, apiVersion, capabilities, register, settings })`. A separate `manifest.json` only arrives with Phase 6 user plugins.
- `PacketFactory.serialize()` throws `PacketSerializeError` (Phase 1 ruling). The plugin host forwards the original bytes, with a warning, when a modification can't be serialized.
- `SettingsStore`: the store-wide change listener is error-isolated, and `update()` still returns true.
- `ProfileStore`:
  - the write loop handles short writes;
  - an unreadable profile, or a failed corrupt-file backup, means defaults **plus saving disabled for that session**, so the original is never overwritten;
  - a pending save is kept until a write succeeds;
  - `ProfileFs` is injectable for tests.
- HELLO is posted with `sequence: 0, observeOnly: true` and is never a verdict.
- Plugin host (Task 5) deviations, all accepted by review:
  - start order: compute the interest, then subscribe;
  - each observer gets its own decoded copy of the packet, so observer mutations really are ignored (one extra decode per observer);
  - the drop check is `packet.send === false`;
  - button presses schedule a save;
  - `ProxyLike` is kept as the exact `Pick<ProxyHost, ...>`, with an `as unknown as ProxyLike` cast at the test-harness boundary.
- Errors from plugin code handling credential packets (`CREDENTIAL_PACKETS = {HELLO}`) are logged with **details withheld**. `describeError()` formats unknown thrown values.

Tasks 6–8, the final review and the PR:

- `/ip` replies `Connected to <host>:<port>` (the plan's text), not Realm Engine's `<name>: <address>`; RealmTool has no server name for a routed address.
- Server-list refresh failures log only controlled text (HTTP status, "no servers", a fixed timeout phrase, or the error's class name), never a fetch error's message. The global "token never logged" rule overrode the plan's `split(accessToken)` redaction, which missed URL-encoded tokens.
- A plugin whose `register()` or settings migration fails is disabled for good: its cleanups run at once, later registrations from its context are ignored, and dispatch skips it. Other plugins keep loading.
- The worker's handshake-retry HELLO (which carries the token) is held in clearable session state and released on the first server data and on close/fault.
- A profile with `schemaVersion` above 1 is left untouched: defaults, saving disabled for the session. A missing `schemaVersion` loads as 1; any other value takes the corrupt-file path.
- **Parked for Phase 6:** the `inject` capability isn't enforced on `client.sendToClient`/`sendToServer`. Enforcing it needs per-plugin client facades. Built-in plugins are trusted.
- **Not applicable (PR bot):** "no hard-coded game-server IPs" (AGENTS.md) is about routing (design §3, the USWest fallback). The bundled `data/servers.json` is the Server Switch fallback that design §5's Phase 2 row specifies. The user chose to keep it.

## Environment setup on a new workstation

1. Clone `DaAwesomePwner/RealmTool` (work from `main`, then branch per task).
2. Node ≥ 22.18 (the original machine used 26.x). Run `npm install` from a normal shell; the Codex sandbox has no registry access. **Check that `koffi` loads** (`node -e "require('koffi')"`). Without it, RealmTool can't match a game connection to the server the helper recorded. Since PR #3, `npm start` checks this first. It stops before installing the helper or opening the launcher, with `RealmTool can't load its native module (koffi): run "npm install" in <repo> and try again`. The exception is when `--fallback` names a server; then it warns and routes new connections there. Before PR #3, it only warned, and the game hung on the Nexus loading screen ("No destination…").
3. **Helper DLL:** `native/helper/bin/winhttp.dll` is git-ignored. Build it with VS 2022 C++ x64 tools (`npm run build:helper && npm run verify:helper`), or, in a new worktree, copy it from a checkout that has a build when `native/` is unchanged. `npm start` refuses to run without it.
4. Clone `DaAwesomePwner/realm-engine-client` next to it (`../realm-engine-client`) for ports. If that checkout is on another branch or has local edits, add a detached worktree at the commit you port from instead of touching it.
5. Claude Code with the `superpowers`, OpenAI `codex` and `orchestra@local` plugins; Codex CLI installed and logged in. On Windows, set `ORCHESTRA_CODEX_BIN` to the real `codex.exe` (see the process README).
6. `npm run check` should be green before you start.

## How to continue

1. Read `docs/process/codex-sdd/README.md`.
2. Phase 3a: write its plan against the current code (`superpowers:writing-plans`), porting from realm-engine-client's current `main` per design §5 and §3. Commit the plan on the phase branch.
3. Execute it with `superpowers:subagent-driven-development`, dispatching Codex implementers and reviewers through Orchestra, up to 3 in parallel.
4. Final whole-branch review on Codex (`--tier hard`), one fix wave, a scoped re-review, then push, open the PR (base `main`) and hand the user the live smoke test.

## Machine state (original workstation, after the Phase 2 live test)

- The game folder `%LOCALAPPDATA%\RealmOfTheMadGod\Production` has **RealmTool's helper installed** as `winhttp.dll` (no foreign `winhttp.dll` was present to back up). `node src/cli.ts uninstall-helper`, with the game closed, removes it.
- A third-party `version.dll` ("RealmStock MultiTool") was moved out to `%LOCALAPPDATA%\RealmOfTheMadGod\version.dll.multitool-removed` at the user's request.
- No RealmTool profile exists yet (`%APPDATA%\RealmTool\profiles\default.json` is created on the first run that changes a setting).
- The user is building a separate companion app that passively captures port-2050 traffic. It worked alongside Realm Engine and should work alongside RealmTool too (same network layout).

## Roadmap

- **3a:** Auto Nexus (server HP) + Auto Drink as worker modules.
- **3b:** Collision HP, default ON, release-required.
- **5:** UI shell (Tauri 2 planned; decide before starting) + installer.
- **6:** user plugins, Realm Engine profile import, `refresh-data`, `inject` capability enforcement.
- **Post-release:** 3c O3 Helper (port + live test, with its two known bugs fixed) and 4 Anti-AFK (try an out-of-process PostMessage click first).
