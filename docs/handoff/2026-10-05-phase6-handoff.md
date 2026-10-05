# Phase 6 handoff — refresh-data, patch-day checklist, Server Messages

## Scope (user rulings, 2026-10-04)

- **In:** `refresh-data` (needed before the next game update), the patch-day checklist, and a Server Messages diagnostic to settle how the AFK disconnect works.
- **Deferred:** user plugins, until RealmTool is shared.
- **Dropped:** the Realm Engine profile importer.

## Phase 5 live smoke (user, 2026-10-04)

The user installed `RealmTool_0.1.0_x64-setup.exe` and keeps it as their daily tool (Realm Engine retired). Verified in game: install without elevation, launcher opened from the app, normal Nexus → realm transfer, Auto Nexus at 99% fired on a **predicted** hit (server HP 840/840, estimated 819; write 1.3 ms) and reconnected to the Nexus, manual `/nexus` sent. No warnings or errors in the log. Not exercised: Auto Drink (disabled in the profile), the Collision HP toggle, profile switching and tray Quit.

**AFK data point:** the session closed 20 m 04 s after the last recorded action (`/nexus`), logged as `closed by game`. Before Server Messages existed, nothing showed whether the server sent a warning first.

## What shipped

| Piece | Outcome |
|---|---|
| `refresh-data` | Generator moved to `src/catalogs/` (`tools/` keeps thin wrappers). The sidecar checks the game build and a `source.json` fingerprint (size/mtime of `resources.assets` and `boot.config`) at proxy start, every 60 s and on each game session. After a 60 s quiet period it regenerates both catalogs into `%APPDATA%\RealmTool\data\catalogs\` in a child process. A worker thread inside the child keeps it responsive to parent loss, and a parent-pipe gate stops it before publication if the sidecar dies. It verifies the reload against the loaders and fingerprint, then hands the catalogs to Auto Nexus and Auto Drink live through the new additive `onDataRefreshed`/`onDataInvalidated` plugin hooks. Known-stale data is withdrawn first (Collision HP FALLBACK, server HP floor). Manual: UI **Refresh game data**, `POST /api/refresh-data`, CLI `refresh-data`. Shutdown cancels a running refresh. `fast-xml-parser` is now a runtime dependency (bundled). |
| Patch-day checklist | `docs/patch-day.md`: triage table, update-day steps, rebuild/ship/verify, never-do rules. `design.md` and README updated. |
| Server Messages | Observe-only built-in (fifth plugin). It logs `FAILURE`, `GLOBALNOTIFICATION`, `NOTIFICATION` strings and system-sender `TEXT` (name empty or `*…`, or objectId < 0 without a recipient). At disconnect it logs how long ago the player last moved, shot, used an item and chatted. Player chat, whispers, guild/party chat and HELLO are never logged. |

## Validation

- Coordinator, outside the sandbox: `npm run check` passes (**1376 tests, 73 files**), plus both typechecks.
- Real `refresh-data` runs against the installed game, into temp folders only:
  - 16–17 s each; output byte-identical to the bundled catalogs for build `15a3ce058fe946c792c23558bdb10e2c`.
  - The parent-pipe run published all three files.
  - Closing the parent's pipe after 5 s made the child exit 1 ("Refresh parent disconnected") and publish nothing.
- Reviews (Codex, independent):
  - Server Messages: approved after one coordinator-requested fix round (system-TEXT rule, bounded NOTIFICATION scan).
  - Patch-day docs: approved after one reconcile round.
  - `refresh-data`: approved on round 2. Round 1 (hard tier) found three majors, all fixed:
    - a stat failure skipped invalidation;
    - the refresh child could outlive a forced shutdown, because the shell's Job Object allows breakaway;
    - success was declared without verifying the reload.

  Before review, the coordinator also required the fingerprint and quiet period: a refresh in the middle of a launcher update could otherwise label old data with the new build, permanently.

## Not yet verified live

- An actual game update end to end: launcher update → quiet period → automatic refresh → `Collision HP on` with the new build, without reconnecting.
- The desktop shell's real forced-termination path during a refresh.
- The AFK experiment. Stand idle somewhere safe until disconnected, then read the `[Server Messages]` lines and the session-end idle line for that session in `%APPDATA%\RealmTool\logs\realmtool.log`.

## Known gap

Nothing in this repo or its research records how packet IDs and RC4 keys were originally extracted from Exalt (`docs/patch-day.md` §4). If an update changes them, new verified values must come from outside this repo.
