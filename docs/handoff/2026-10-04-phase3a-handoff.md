# RealmTool handoff — Phase 3a (2026-10-04)

## Phase state

Phase 3a adds Auto Nexus and Auto Drink to the existing Chat Filter and Server Switch plugin host. Their time-critical decisions run in the network worker, with Auto Nexus at priority 0 and Auto Drink at priority 10. The main thread owns profile configuration, commands and display messages.

Auto Nexus defaults to 25% server HP, uses normal ESCAPE and server-authorized RECONNECT, and retries up to four times at 400 ms intervals. Only a RECONNECT accepted by the final game writer confirms a transfer. Auto Drink defaults off, uses verified consumables and accepted game-clock samples, and is disarmed by escape for that TCP generation. The profile is applied once at startup; edit it with RealmTool stopped.

Collision HP is absent: no `PreHitPrediction` setting is offered or saved. **Phase 3a is not releasable. Don't rely on Auto Nexus yet.** Phase 3b must implement and wire Collision HP before any release; the UI/installer and other release gates in [the design](../design.md) also remain required.

The eight Task 8 integration cases use both real worker modules and both plugin facades, loopback game/server sockets and real RC4. An independent fake-server thread verifies ESCAPE and its first retry arrive during a 500 ms main-thread plugin stall. Other cases cover default retries, accepted versus dropped transfers, priority/disarm, decoded potion use, own-use stock acknowledgement, and one startup configuration batch.

Validation after the final review fixes: `npx.cmd tsc --noEmit` passed; `npx.cmd vitest run --configLoader native` passed **832 tests in 42 files**. The eight realtime integration cases also passed three consecutive focused runs. The native loader is required by the worker sandbox. Auto Drink regressions cover catalog build changes and failure status, plus held, dropped, malformed and accepted RECONNECTs. The live smoke test remains the user's task; this integration work does not launch the game or the application proxy against a live server.

## Catalog regeneration after a game update

With RealmTool stopped, run from the repository root:

```sh
npm run gen:catalogs
```

The default source is `%LOCALAPPDATA%\RealmOfTheMadGod\Production`. For another installation:

```sh
npm run gen:catalogs -- --game-dir "C:\path\to\Production"
```

The generator reads Objects XML TextAssets from `RotMG Exalt_Data/resources.assets` and the Unity `build-guid` from `RotMG Exalt_Data/boot.config`, then writes `data/catalogs/consumables.json`. Review the printed item count, size and build stamp, run `npm run check`, and restart RealmTool. Runtime loading validates JSON and checks the installed build at startup and on every new game connection while Auto Drink is enabled, as well as when enabling it (the host gates connection events for disabled plugins). A missing, invalid, unknown-build or mismatched catalog supplies no consumables and its failure reason stays visible in status. When the installed build matches the loaded catalog again, verified consumables are restored. Do not edit its build stamp to bypass this check.

The bundled catalog is stamped `15a3ce058fe946c792c23558bdb10e2c`. The integration fixture reads that stamp dynamically into a temporary game directory, so it exercises the real build check without depending on the workstation's installation. This task does not regenerate the bundled catalog or validate the current live game build.

## Live smoke test (user)

1. `npm start`, Play, log in, and stand in a realm.
2. `/an` shows the threshold and "prediction off — server HP threshold only". `/an 99` then take any damage: you're sent to the Nexus with an `AUTO NEXUS` chat line. `/an 25` restores it.
3. `/nexus` sends you to the Nexus (`MANUAL NEXUS`).
4. Enable Auto Drink in the profile (RealmTool stopped), put HP potions in a quickslot, take damage below 50%: a potion is used once, and not more often than every 400 ms.
5. Ctrl+C. The profile has `auto-nexus` and `auto-drink` entries and no `PreHitPrediction`.
