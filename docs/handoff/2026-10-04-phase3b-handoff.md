# RealmTool handoff — Phase 3b (2026-10-04)

## Phase state

Phase 3b completes the functional release gates: Auto Nexus Collision HP runs in the network worker and is ON by default for new, empty and Phase 3a profiles. Phase 5 UI shell and installer are still required before any release. The live smoke test below remains pending; no live game session was used for this task.

The worker assesses PLAYERHIT, AOEACK and GROUNDDAMAGE before forwarding. Server HP remains authoritative; estimated HP subtracts remaining assessed loss. Normal ESCAPE and server-authorized RECONNECT, bounded retries, and Auto Drink's generation disarm remain unchanged. Client report suppression does not prevent server-calculated damage, and Collision HP estimates are not survival guarantees.

The real-worker integration suite loads both modules and both facades, uses loopback sockets and real RC4, and reads the bundled build stamp into a temporary game directory. New cases cover a 500 ms PLAYERHIT hook stall (independent server-thread timestamps and hit counts), DAMAGE before/after the report, stalled versus dropped ENEMYSHOOT behind an earlier verdict, explicit OFF, missing-catalog fallback with Auto Drink still working, and Collision HP escape disarming Auto Drink. The tests inject an isolated catalog loader into the real facade; they do not depend on a user's AppData overrides.

Validation (coordinator, outside the sandbox, 2026-10-04): `npx tsc --noEmit` passed; `npx vitest run` passed **1075 tests in 49 files**; the realtime integration file passed 16/16 on three consecutive runs. Each task was verified the same way before merge and approved by an independent Codex review (T5 and T7 after one fix round each). A batch-order host test that could fail under load (built-in module status interleaving) was made robust on the phase branch.

## Catalog regeneration after a game update

With RealmTool stopped, run from the repository root:

```sh
npm run gen:catalogs
```

The default source is `%LOCALAPPDATA%\RealmOfTheMadGod\Production`. For another installation:

```sh
npm run gen:catalogs -- --game-dir "C:\path\to\Production"
```

The generator reads Objects and Ground XML TextAssets from `RotMG Exalt_Data/resources.assets` and the Unity `build-guid` from `RotMG Exalt_Data/boot.config`. It validates and stages both outputs before renaming them: `data/catalogs/consumables.json` and compact `data/catalogs/safety.json`. Review printed counts, sizes and build stamps, run `npm run check`, and restart RealmTool. Safety must remain at most 1 MiB and the two catalogs together at most 2 MiB. Runtime loading uses JSON only.

An AppData override under `%APPDATA%/RealmTool/data/catalogs/` takes precedence over the bundled file; only a missing override falls through. If a stale or invalid override caused fallback, replace it with the regenerated catalog or remove that override while RealmTool is stopped. Never edit the build stamp to bypass validation.

A missing, invalid, unknown-build or mismatched safety catalog suspends prediction and supplies no stale metadata to the engine. Auto Nexus keeps working on server HP only, preserving the saved `PreHitPrediction` value. It warns in the load log and displays once per new game connection:

`Collision HP FALLBACK: server HP only (<reason>). Run npm run gen:catalogs and restart RealmTool.`

`/an` and decision notifications identify `Collision HP fallback (server HP only)` and its reason. Build checks run at startup, on connections while enabled, and on enable. A later matching build check restores prediction; changing catalog files requires a restart. Auto Drink validates its own consumables catalog independently. Same-GUID updates remain undetected. This task does not regenerate the bundled catalogs or verify the current installed game build.

## Live smoke test (user, after merge)

Record actual results here; all steps are currently **not run**.

1. `npm start`, Play, realm. `/an` shows "Collision HP on" and catalog ready with the current build.
2. `/an 99`, then take one hit: `AUTO NEXUS` with "estimated HP" in the text, sent before the server HP update would have crossed. `/an 25` restores the threshold.
3. With RealmTool stopped, set `PreHitPrediction: false` in `plugins.auto-nexus.settings` in the profile. `/an` shows "Collision HP off", and the Phase 3a behavior is unchanged. Restore the setting.
4. Normal play near the 25% threshold (a few hits from low-tier enemies): no early escapes at high HP.
5. Ctrl+C. The profile has `PreHitPrediction` only if it was changed.
6. Optional fallback check: with RealmTool stopped, rename `data/catalogs/safety.json`, start, connect. Ensure there is no usable AppData safety override for this check. Chat shows the `Collision HP FALLBACK` notice and `/an` says fallback. Stop RealmTool, restore the file, and restart.

## Rulings made during Phase 3b

1. **R1 — Default ON:** implemented for new, empty and Phase 3a profiles; explicit false stays OFF, with no migration flag. *Cost:* none.
2. **R2 — Server-HP fallback (user decision, 2026-10-04):** replaces the proposed degraded-ON behavior. Invalid or unavailable build-matched metadata suspends prediction, preserves the saved setting, and exposes effective `on` / `off` / `fallback` mode. Warning, per-connection notice, fresh `/an` status and decision text make fallback visible. Entering/leaving fallback retires debt but keeps the HP anchor. *Cost:* after updates, server-HP reactions may arrive later until regeneration and restart.
3. **R3 — Positive remaining loss:** stalled delivery requires remaining assessed loss greater than zero, not entry count; dropped frames are excluded. This intentionally differs from REC. *Cost:* divergence pinned by regression tests.
4. **R4 — Monotonic unresolved serial:** occurrence numbers never restart within an epoch, including after the 12 s correspondence window. *Cost:* none expected.
5. **R5 — Zero threshold:** both modes require explicit server HP zero and known positive maxHP (stat 0). *Cost:* none.
6. **R6 — SERVERPLAYERSHOOT untracked:** parity retained; unmatched reports use the assumed loss path, `max(200, valid raw damage)`. *Cost:* those hits remain assumed rather than mitigated estimates.
7. **R7 — No DamageLedger:** HealthPredictor is the only debt engine; nullable `lastHp` remains the server anchor. No native forecast or telemetry was added. *Cost:* none.
8. **R8 — Compact bounded catalog:** hex-prefixed and decimal types, identical duplicate collapse, conflicting duplicate rejection. Bounds: types 0–65535, projectile IDs 0–255, lifetime 0–10^9 ms, effect duration 0–10^6 seconds, damage and maxHealthDamage 0–10^6. *Cost:* future out-of-range game values fail generation visibly.
9. **R9 — FIFO AoE queue:** parity retained with pruning beyond 10 s; known areas still require age at most `max(1000, 2 * reactionMs)`. *Cost:* none expected; regression covered.
10. **R10 — New upstream generation:** surviving client reports are freshly assessed at final preparation in the new epoch, with old per-session associations cleared. *Cost:* none expected.
11. **R11 — Toggle before final write:** held reports are freshly assessed in the current mode. Intentional mode changes retire old debt while keeping server HP, its age and escape lifecycle. *Cost:* prior prediction debt is deliberately retired (REC behavior).
12. **R12 — Same-GUID updates:** remain undetected; source SHA-256 hashes are diagnostic only. *Cost:* metadata changes without a new build GUID need manual regeneration.

**Post-review delivery identity change:** `preparePredictionWrite(packet, now, observationId)` returns `number | null`, the delivery ID to pass to `reportDelivered`. A report with an original observation uses that ID; injected/renamed/pre-connect reports without one receive a synthetic negative ID. The worker associates that returned ID with the preparation token and reports the write outcome once. This lets an injected report reconcile from its actual accepted write instead of leaving unwritten debt, while generation/mode changes reassess surviving reports (R10/R11).
