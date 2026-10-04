# RealmTool handoff — Phase 2 in progress (2026-10-03)

## Where things are

| Item | State |
|---|---|
| Repo | `github.com/DaAwesomePwner/RealmTool` (private) |
| `main` | Phase 1 merged (PR #1): pass-through proxy, routing helper DLL, launcher-based `npm start`, 137 tests, Windows CI green |
| Working branch | **`phase2/plugin-host`** (pushed). Continue here |
| Phase 2 plan | `docs/superpowers/plans/2026-10-03-phase2-plugin-host.md` (8 tasks) |
| Design | `docs/design.md` (v4). Research in `docs/research/` (05 = Phase 2 port details) |
| Process | `docs/process/codex-sdd/README.md`: how tasks are dispatched to Codex, contracts, gotchas |

### Phase 2 task status

| Task | What | Status |
|---|---|---|
| 1 | HELLO observable (read-only) | ✅ complete, review clean |
| 2 | Plugin API types + SettingsStore | ✅ complete (1 fix round) |
| 3 | Profile store (atomic, corruption-safe) | ✅ complete (1 fix round) |
| 4 | Player identity tracker | ✅ complete, review clean |
| 5 | Plugin host | ✅ complete (1 fix round), 200 tests on the branch |
| 6 | Port Chat Filter (+62 tests) | ⏳ not started. Can run in parallel with 7 |
| 7 | Server Switch plugin (`/con`, `/goto`, `/ip`) | ⏳ not started. Can run in parallel with 6 |
| 8 | CLI wiring, `config-path`, README | ⏳ after 6 and 7 |
| — | Final whole-branch review (Codex `--effort high`), fix wave, PR, live smoke test | ⏳ |

T6 and T7 both append to `plugins/index.ts`. The controller merges the list as Chat Filter first, then Server Switch.

## Decisions the user made (binding)

- **Implementation and review run on Codex agents** (save Claude usage), **up to 3 in parallel**. Claude is the controller only.
- **First release ships:** Auto Drink, Auto Nexus, Chat Filter, Server Switch. **Release gate:** Phases 1, 2, 3a, 3b, 5.
- **Auto Nexus uses Collision HP ON by default**, built from the client's PLAYERHIT/AOEACK/GROUNDDAMAGE reports in the worker, with server HP as the floor. It **must be wired before any release** (Phase 3b).
- **The server is authoritative for damage.** The user verified that omitting hit packets doesn't stop damage. Collision HP is an early warning, not prevention; suppressing reports after an escape is only for parity.
- **O3 Helper and Anti-AFK are post-release additions.** They are not release gates.
- **Server Switch** is chat commands only, with no UI. The access token is used in memory only and is never logged or saved. Exalt's own server label not updating is fine.
- **Launching:** never start `RotMG Exalt.exe` directly. `npm start` opens the **Deca RotMG Exalt Launcher** (the user's normal path), with Steam as a fallback.
- **Packet recording** is deferred until it's relevant (Phase 3b's safety event recorder).
- PRs merge with a merge commit.

## Phase 2 rulings so far

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

## Environment setup on a new workstation

1. Clone `DaAwesomePwner/RealmTool` and check out `phase2/plugin-host`.
2. Node ≥ 22.18 (the original machine used 26.x). Run `npm install` from a normal shell; the Codex sandbox has no registry access.
3. Clone `DaAwesomePwner/realm-engine-client` next to it (`../realm-engine-client`). **Tasks 6 and 7 port from it at commit `88a66b2`** (`git checkout 88a66b2` in a separate worktree if `main` has moved).
4. Claude Code with the `superpowers` and OpenAI `codex` plugins; Codex CLI installed and logged in.
5. Optional, for the helper DLL: VS 2022 C++ x64 tools, then `npm run build:helper && npm run verify:helper`.
6. `npm run check` should be green before you start.

## How to continue

1. Read `docs/process/codex-sdd/README.md` and the Phase 2 plan.
2. Create a fresh SDD workspace (`scripts/sdd-workspace PLAN`). Start the ledger with the task table above, marking Tasks 1–4 (and 5, if complete) as done.
3. Run Tasks 6 and 7 in parallel lanes (worktrees + `node_modules` junctions), then Task 8.
4. Final whole-branch review on Codex `--effort high`, one fix wave, a scoped re-review, then push and open the PR (base `main`).
5. Hand the user the live smoke test: `npm start` → launcher → Play. Check `/con usw`, `/goto <ip>`, `/ip`, that ad spam is hidden, and `config-path`.

## Machine state left behind (original workstation)

- The game folder `%LOCALAPPDATA%\RealmOfTheMadGod\Production` has Realm Engine's original `winhttp.dll` restored, and RealmTool's helper uninstalled.
- A third-party `version.dll` ("RealmStock MultiTool") was moved out to `%LOCALAPPDATA%\RealmOfTheMadGod\version.dll.multitool-removed` at the user's request.
- The user is building a separate companion app that passively captures port-2050 traffic. It worked alongside Realm Engine and should work alongside RealmTool too (same network layout).

## After Phase 2 (roadmap)

- **3a:** Auto Nexus (server HP) + Auto Drink as worker modules.
- **3b:** Collision HP, default ON, release-required.
- **5:** UI shell (Tauri 2 planned; decide before starting) + installer.
- **6:** user plugins, Realm Engine profile import, `refresh-data`.
- **Post-release:** 3c O3 Helper (port + live test, with its two known bugs fixed) and 4 Anti-AFK (try an out-of-process PostMessage click first).
