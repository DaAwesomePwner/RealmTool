# When RotMG Exalt updates

For RealmTool's owner and the agents helping on patch day. A catalog refresh repairs game **data**; it cannot repair packet layouts, ciphers, routing hooks or changed gameplay rules.

## Quick triage

| Symptom | Likely cause | What to do |
|---|---|---|
| Game connects and plays; `[Data] Catalogs refreshed for build <b> (…)` appears | Automatic data refresh succeeded | No repair needed. Confirm `/an` reports `Collision HP on` and the new catalog build. |
| `[Data] Refresh failed: <reason>` repeats | Asset/XML format changed, or a file/path/validation error | Read the reason first; correct the game folder or file access if indicated. Format changes need a fix in `src/catalogs/`, regenerated catalogs and a release. Meanwhile stale catalogs leave Auto Nexus on the server-HP fallback and Auto Drink unavailable. |
| Cannot connect, disconnects after HELLO, or stays loading | Packet IDs, HELLO layout or RC4 keys may have changed; server/network failure is also possible | Check `[Server Messages]` lines around the failed connection, then use the HELLO diagnostics below. Confirm a protocol change before editing `data/packet-definitions.json`, `data/stat-types.json`, routing parsers or `src/protocol/constants.ts`; rebuild and release. Refreshing catalogs cannot fix this. |
| Game plays directly, with no RealmTool game session | Helper may not be loaded (for example, the launcher replaced `winhttp.dll`), the selected install may be wrong, or Exalt's connect path changed | Close Exalt, confirm the game folder, reinstall the helper and relaunch through the launcher. If still bypassed, investigate the hook; installed does not mean loaded. |
| Auto Drink drinks the wrong thing or nothing | Changed consumable/quickslot rules, stale metadata, settings or eligibility | Disable Auto Drink if behavior is wrong. Check catalog/build and plugin status first, then `src/catalogs/consumables.ts`, `src/auto-drink/` and `plugins/auto-drink/`; repair changed semantics and release. |
| Auto Nexus decisions look wrong even after refresh | Projectile, damage or stat semantics may have changed | Check `/an` mode/build and decision logs. Inspect `src/catalogs/safety.ts`, `src/safety/`, protocol definitions and `plugins/auto-nexus/`; matching build stamps do not validate damage semantics. Use server-HP-only only if the server HP protocol is still understood. |
| `/con` lists wrong/missing servers | Endpoint response changed or the retained/bundled list is stale | Check `[Server Switch]` logs; inspect `plugins/server-switch/directory.ts` and `data/servers.json`. Fix the endpoint/parser or update the fallback data from verified evidence. |

Server-HP fallback avoids using stale collision metadata; it is not a survival guarantee and cannot make a broken protocol safe.

## Update-day steps

### 1. Start with the log and the actual installation

Let the normal Deca/Steam launcher finish updating. In the desktop app, inspect the log panel and `%APPDATA%\RealmTool\logs\realmtool.log`. Disk records use `ISO-timestamp LEVEL [module] message`; rotation keeps `realmtool.log`, `.1` and `.2` with a 1 MiB threshold. For development `npm start`, also inspect the terminal.

Look for `[Proxy] Listening on 127.0.0.1:2050`, `[Helper] installed/updated/unchanged`, then `[Proxy] Game connected`, routing/transfer messages and any errors. A listening proxy or an installed DLL alone does not prove game traffic is passing through RealmTool. Read `[Data]`, `[auto-nexus]`, `[auto-drink]` and `[Server Switch]` messages around the same connection. The observe-only **Server Messages** built-in logs server system messages (`FAILURE`, `GLOBALNOTIFICATION`, `NOTIFICATION` strings and system-sender `TEXT`) plus idle times at disconnect. Check `[Server Messages]` around a failed connection for an explanation such as a rejected client version.

Confirm the selected folder contains the game the launcher actually updated. `node src/cli.ts find-game` lists detected installations; detection considers `ROTMG_PATH`, Deca folders and Steam libraries. Use the app's game-folder setting or `npm start -- --game-dir "C:\path\to\Production"` if necessary.

Read `build-guid=` in that folder's `RotMG Exalt_Data\boot.config`. This is the installed build stamp, not RealmTool's version or HELLO's `buildVersion`. Compare it with `gameBuild` in both catalogs under `%APPDATA%\RealmTool\data\catalogs\`; bundled defaults are `data/catalogs/consumables.json` and `safety.json`. Runtime loaders prefer the user override and reject invalid catalogs rather than silently trusting them.

### 2. Let refresh-data run, or force it

The app checks at proxy start, every 60 seconds while the proxy runs, and on each new game session. Data is stale when either catalog selected by the loaders is missing, invalid or for another build, or when the app-data catalogs' `source.json` fingerprint is missing or does not match the current files. The fingerprint records the game build plus size and modification time of `RotMG Exalt_Data/resources.assets` and `boot.config`; `src/data/catalogSource.ts` handles it. A matching **bundled** catalog needs no fingerprint.

Known-stale data is withdrawn from Auto Nexus/Auto Drink before refresh: Auto Nexus uses server HP only and reports `Collision HP FALLBACK` in game; Auto Drink is unavailable. Automatic refresh waits until both game files have been unchanged for 60 seconds. Until then, `[Data] Game files are still changing; waiting to refresh` is logged once per build; this is not a failure. Proxy start does not wait for a not-yet-quiet update; the 60-second poll picks it up. Manual refresh skips the quiet period.

Refresh regenerates both catalogs from local `RotMG Exalt_Data\resources.assets` in a child process and writes `%APPDATA%\RealmTool\data\catalogs\`. After extraction, the child re-checks the build and both files' size/mtime. Any change fails with `game files changed during refresh; retrying later` and publishes nothing. `source.json` is published last. Success reloads Auto Nexus/Auto Drink live without dropping the connection. On the owner's machine this took about 16 seconds and produced catalogs byte-identical to the bundled catalogs for the same build.

Expected messages (module `Data`):

```text
[Data] Game files are still changing; waiting to refresh
[Data] Game build changed (<old> → <new>); refreshing catalogs…
[Data] Refreshing catalogs for build <b>…
[Data] Catalogs refreshed for build <b> (<n> items, <p> projectiles, <t> tiles, <ms> ms)
[Data] Refresh failed: <reason>
```

The unchanged-build refresh message covers fingerprint mismatches or manual refreshes. Failures emit at most one warning per five-minute failure window; automatic retries wait five minutes. Manual refresh bypasses that wait as well as the quiet period.

Use **Refresh game data** in the app's readiness area, `POST /api/refresh-data`, or `realmtool refresh-data [--game-dir <dir>] [--out-dir <dir>]` (development: `node src/cli.ts refresh-data`). The CLI defaults to `%APPDATA%\RealmTool\data\catalogs\` and prints one JSON result line. The developer command `npm run gen:catalogs` refreshes the **bundled** catalogs, not the app-data overrides; `tools/gen-catalogs.ts` and `tools/catalogs/*.ts` are thin CLI/re-export wrappers around `src/catalogs/`.

### 3. Separate a data break from a protocol or helper break

**Data/extractor:** ordinary connections work, but refresh fails. The extractor currently supports Unity SerializedFile v22, little endian, TextAssets with XML declarations and `<Objects>`/`<GroundTypes>` roots. Errors such as `Unsupported Unity SerializedFile version`, `Unsupported Unity SerializedFile endianness`, `Truncated or invalid Unity SerializedFile`, or `Missing Objects or GroundTypes XML TextAssets` point to `src/catalogs/unityText.ts` and `src/catalogs/generate.ts`. XML root/field errors lead to `src/catalogs/consumables.ts` or `safety.ts`; JSON schema/duplicate/range errors lead to `src/data/consumables.ts` or `safety.ts`. File-not-found or access errors do not establish a format change. Repair the actual extractor/rule incompatibility, exercise it against the updated assets, regenerate both catalogs and ship the fix. A successful parse alone does not prove that renamed or newly introduced effects were interpreted correctly.

**Protocol/routing:** these worker errors narrow the search:

| Log text | Interpretation / next inspection |
|---|---|
| `Expected HELLO as the first game packet, got …` | The initial ID no longer identifies HELLO, or the initial exchange changed. |
| `Could not decode the game's HELLO; packet definitions may be out of date for this game build` | HELLO schema or decrypted body is incompatible; inspect layout and cipher keys. |
| `No destination for this connection: the helper recorded no server and no fallback server is configured` | Routing has no usable destination; inspect helper/target resolution before blaming catalogs. |
| `reset the connection N ms after HELLO …; not retrying`, `did not answer HELLO within …`, or `never answered HELLO` | Upstream rejection/silence; investigate server availability as well as protocol compatibility. This alone does not identify a changed key. |
| `Game connection error (…)` / `Server connection error (…)` | The named socket failed (e.g. `read ECONNRESET`). A game-side reset with the game still running usually means the client gave up; a server-side reset after it answered usually means the server dropped an unresponsive client. |

Each connection also logs these info lines (`[Proxy] <id>: …`), with keys and tokens reduced to lengths:

| Log text | What it tells you |
|---|---|
| `RECONNECT "<name>" to <server>, gameId …, keyTime …` | Where the server sent the game, e.g. a dungeon or the Nexus. |
| `HELLO gameId …, keyTime …, build "<client version>" …; restored a N-byte key from a RECONNECT X ms old` | The game's login. `(MISMATCH)` means the HELLO doesn't match its RECONNECT. |
| `Game sent ESCAPE (Nexus request)` | The game asked for the Nexus itself. Auto Nexus logs its own escapes as `AUTO NEXUS — …`. |
| `AUTO NEXUS — …; pending loss N from M reports: …` | The collision reports the estimate subtracted from server HP: source (`player-hit`, `ground`, `aoe`, `server-damage`), remaining damage, raw damage when known, and how old each was. `assumed` entries are fallbacks of at least 200 for hits RealmTool couldn't identify (reason in brackets, e.g. `missing-shot`); several of those with full server HP point at a false trigger. |
| `Session summary after …` | Frames and bytes in each direction, when the server first answered after HELLO, when each side last sent, packets held for a plugin, data the game or server hadn't taken, and the server's first packets. `server→proxy` data with little `proxy→game` delivery points at RealmTool; matching counts with the game silent point at the game. |

`PacketFactory` preserves unknown IDs as raw packets. Known packets whose required fields cannot be read also fall back to raw bytes; trailing unread bytes are retained. A non-quiet factory warns `Failed to parse <name> (id=<id>): …`, but the **network worker uses a quiet factory**. Do not expect a warning for every undecodable frame, or treat a quiet log as compatibility evidence. Initial HELLO must decode for routing to proceed. Transfer-only failures also warrant checking RECONNECT parsing and HELLO key restoration in `src/routing/`.

**Helper:** `native/helper` side-loads as `winhttp.dll` beside `RotMG Exalt.exe`. It hooks `ws2_32!connect` and redirects only non-loopback IPv4 port-2050 connections; it records the original destination in a PID-specific temp file. A different connect API, IPv6, a changed port, or a changed DLL-loading path would require native investigation and possibly a release. Failure to write the target file also makes this hook connect directly. Native hook failures use `OutputDebugStringA`, not RealmTool's file log.

Close Exalt before reinstalling: use the app's helper action or `node src/cli.ts install-helper --game-dir "C:\path\to\Production"`, then launch normally. `npm run verify:helper` checks the built DLL's PE/x64 format, marker, forwarder string and size budget; it **does not** prove the DLL was loaded or that the live hook works.

### 4. Repair protocol definitions from evidence

The prior source of truth was Realm Engine's `client/data/packet-definitions.json` and stat schema, ported in RealmTool commit `9aed5eb` alongside the codec and RC4 constants. Port headers identify source revision `9ab4f8f`. [Network research](research/01-network-proxy.md) describes that project's canonical definitions, `gen:packets` generation and `check:packets` structural/drift checks, and records the production worker's directional RC4 keys.

**Drift-check gap:** this checkout has no standalone drift-check script or npm command. The reference to `scripts/check-packet-drift.mjs` in `PacketFactory.ts` is inherited; the earlier design wording did not correspond to a shipped local script. Local `src/protocol/__tests__/schema.test.ts` checks known IDs and round trips, and runs under `npm run check`. Upstream checks are source-project tooling, not RealmTool commands; passing them would not prove new-game compatibility either.

The inspected history/research does **not** document how the original IDs and keys were extracted from Exalt. Do not invent an extraction command or assume the old source revision matches the new client. Obtain verified definitions/keys for the new build, recording their provenance, then compare:

1. Update `data/packet-definitions.json` by **direction and ID** (IDs can be reused across directions), including changed field layouts and nested objects. Update `data/stat-types.json` when stat IDs or string-vs-numeric encoding changes.
2. Put changed directional RC4 keys only in `src/protocol/constants.ts`. Preserve worker ownership of sockets/ciphers.
3. For HELLO/RECONNECT layout changes, update `src/routing/helloKey.ts`, `reconnectRoute.ts` and `Router.ts` as needed; their byte-level parsing/rewriting is separate from the JSON schema.
4. Update meaningful protocol/routing fixtures and tests to the verified wire layout, then run the checks below. Do not merely change expected IDs until old fixtures pass.

For consumable or projectile rule changes, review the corresponding extractor and worker logic as well as JSON validation. For server-list problems, `plugins/server-switch/directory.ts` fetches the official `/account/servers` endpoint using the HELLO token; on failure it retains the last known list, initially seeded from `data/servers.json`. `/con` without an argument shows the known names. Do not diagnose this by logging the request URL, which contains the access token.

### 5. Rebuild, ship and verify

From the developer checkout, on Windows with the project's build dependencies (including VS 2022 C++ x64 tools for the helper):

```sh
npm run gen:catalogs -- --game-dir "C:\path\to\Production"
npm run check
npm run build:app
npm run verify:helper
```

`npm run gen:catalogs` without arguments uses the default local Deca Production folder. Review the generated changes to both bundled catalogs. `build:app` builds the helper, fetches the bundled Node runtime, builds the backend/UI and runs Tauri packaging. The installer is `src-tauri/target/release/bundle/nsis/RealmTool_<version>_x64-setup.exe`. Ship the rebuilt installer after verification; a bundled-data change alone cannot fix a bad extractor in an already installed app.

Verify through the normal launcher with the updated installation:

1. Confirm a RealmTool game session and an upstream route, then a normal transfer (for example, Nexus to Realm). Check for new HELLO/routing errors.
2. Confirm the refreshed catalog build matches `boot.config`. With Auto Nexus enabled and Collision HP enabled, `/an` should report **`Collision HP on`** and **`catalog game build <new-build>`**. An explicit `PreHitPrediction: false` setting correctly reports off; fallback needs investigation.
3. If Auto Drink is enabled, verify the intended quickslot item and observed use in a controlled situation. Check Auto Nexus decision logs against server HP and expected damage without relying on a valuable character to test survival.
4. Check `/con` names and a transfer if server-list/routing code changed. Record what was checked live separately from automated test results. Catalog freshness and test success do not establish live damage accuracy.

## What never to do

- Do not bypass the Deca launcher or start `RotMG Exalt.exe` directly. Use the normal Deca/Steam launcher and Play flow.
- Do not hard-code game-server IPs into routing code to make a broken helper appear fixed. Repair destination discovery; keep server-directory fallback data in `data/servers.json`.
- Do not duplicate RC4 keys; their only home is `src/protocol/constants.ts`.
- Never log the access token, a complete HELLO payload, or token-bearing server-list URLs/errors.
- Do not relabel stale catalogs with the new build stamp or remove validation to silence fallback.
