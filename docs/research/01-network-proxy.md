# Research: Network / Proxy Layer (realm-engine-client)

> Source: Codex read-only investigation of `realm-engine-client` @ `9ab4f8f`, 2026-10-03.
> Paths are relative to the realm-engine-client repo root. Line counts are physical LOC.
> Nothing here proves live-server or installed-game compatibility.

**Recommendation:** carry over the production worker transport, data-driven packet codec, reconnect routing, and worker-owned Auto Drink/Auto Nexus controllers. Build a smaller plugin API around them. `client/packages/core` and `client/packages/protocol` are a separate headless stack and are unnecessary for this MITM design.

## 1. Traffic interception and server routing

Connection path:

`Exalt → winhttp.dll connect hook → 127.0.0.1:2050 → network worker → real server`

- `client/src/hooker/GameHooker.ts` `GameHooker.install()` installs `client/assets/winhttp.dll` beside `RotMG Exalt.exe`.
- Redirect is in `client/winhttp-proxy/src/connect_hook.cpp`: `InstallConnectHook()` (MinHook on Winsock `connect`); `HookedConnect()` redirects IPv4, non-loopback, port-2050 connections to `127.0.0.1:2050` after recording the original IP. `dllmain.cpp` installs the hook after a 3 s delay.
- No hosts-file or server-list rewriting. `realm-engine.dll` (native features) is separate from the redirect DLL.
- `RecordOriginalTarget()` writes `%TEMP%\rotmg_proxy_target_<PID>.txt` (+ legacy shared `rotmg_proxy_target.txt`). `client/src/proxy/Proxy.ts` `readOriginalTargetForSocket()` maps the loopback source port → PID + process creation time via `readTcpProcessIdentity()` (koffi → `GetExtendedTcpTable`, `GetProcessTimes`) and reads the matching file.
- Fallback `State.conTargetAddress` = `54.241.208.233` ("USWest") **disagrees** with `client/data/servers.json` USWest `54.86.47.176`. Neither is verified current.
- Server selection (optional convenience): `client/src/core/CoreCommands.ts::attachCoreCommands()` (`/con`, `/ip`), `ServerSwitchService.refresh()` → `ServerListFetcher.fetchServerList()` (HELLO access token + official servers endpoint). `plugins/server-switch.ts` (dashboard adapter), `plugins/ip-connect.ts` (`/goto`). Both inject a loopback `RECONNECT` with empty key; optional native `syncServerSelection()`.

Transfers — `client/src/proxy/ReconnectHandler.ts`:
1. `onReconnect()` validates host/port/gameId/keyTime/key via `readReconnectRoute()`.
2. Saves real destination + key in connection state.
3. Patches host/port → loopback and key → state GUID.
4. Exalt reconnects locally, sends GUID in HELLO.
5. `Proxy.getState()` restores route; `onHello()` patches real key back into raw HELLO bytes and opens upstream.

Raw patching preserves unknown tails; empty host/zero port keeps current destination; malformed reconnects dropped. Same path for Nexus/realm/dungeon.

**Minimum to keep:** initial-target discovery + HELLO/RECONNECT handoff.

## 2. Worker ownership and packet semantics

- `client/src/proxy/NetworkHost.ts` starts one `worker_threads.Worker` serving many `Session`s. Live source: `client/src/proxy/network-worker.ts` (bundled to `dist/network-worker.cjs` by `scripts/build-prod.mjs`; `workerPath.ts` resolves source/compiled/ASAR).
- Worker owns listener, both sockets per session, framing, timers, four RC4 streams (`CLIENT_KEY`: decrypt-from-game / encrypt-to-server; `SERVER_KEY`: decrypt-from-server / encrypt-to-game). Keys hard-coded in worker, duplicated in `ClientConnection.ts` and protocol package.
- `RC4Cipher.cipher()` skips 4-byte length + 1-byte id (body from offset 5); state continues across frames; upstream ciphers reset on new upstream connection.
- `Frames.feed()` handles fragmentation/coalescing, rejects frames outside 5..1,048,576 bytes.
- Flow: `Session.receive → NetworkEvent(packet) → ClientConnection.remotePacket → Proxy hooks → forward command → Session.forward/write`. Messages carry connection id, sequence, generation; per-direction ordering; stale decisions rejected. Pending forwarding >8 MiB = uncertainty, >16 MiB = transport fault.

| Operation | Behavior |
|---|---|
| Pass | Original decrypted `rawBytes` re-encrypted |
| Drop | `packet.send = false`; main replies `data: null` |
| Modify | Edit `packet.data`, `modified = true` → reserialize |
| Raw patch | Replace `rawBytes`, `modified = false` |
| Hold | `lagMode` stores decisions; flush/drop later |
| Inject | `sendToClient()` / `sendToServer()` → worker `inject` (bypasses hooks) |

Exception: `Proxy.fireServerPacket()` forces `UPDATE.send = true` after hooks.

**ESCAPE priority path:** `SafetyEngine` → `EscapeAttemptCoordinator` → `Session.write(..., 'escape')` directly in the worker, before logging/UI and without waiting for main-thread decisions. Shares upstream socket + RC4; can't overtake bytes already queued to TCP. `AutoEscapeReportGuard` suppresses outgoing `PLAYERHIT`, `AOEACK`, `GROUNDDAMAGE`, `MOVE` after accepted automatic escape until connection replaced; manual ESCAPE alone doesn't arm it.

## 3. Protocol

Two codecs:
- **Production MITM:** `client/src/packets/{PacketFactory,PacketReader,PacketWriter,Packet}.ts` — direction+id lookup, schema-driven decode, preserves unread trailing bytes, unknown packets pass through raw.
- **Headless:** `client/packages/protocol/src` (used by `packages/core`) — not a MITM replacement; lacks USEITEM/ENEMYHIT typed classes. **Drop.**

`client/data/packet-definitions.json` is canonical. `gen:packets` generates `src/packets/packetDefinitions.generated.ts`, `statTypes.generated.ts`, `packetStatus.generated.ts`, `packetLabNameOnly.generated.ts`, `packages/protocol/src/generated/packet-map.ts`. `check:packets` validates formatting/names/aliases/directions (172 shared defs, 14 protocol-only, 8 orphans, 3 aliases, 5 direction divergences; IDs 215/217 shared across directions). Passing ≠ game compatibility.

### Packets needed by retained features

| Consumer | Reads / observes | Writes / suppresses |
|---|---|---|
| Routing | C→S `HELLO` 74; S→C `RECONNECT` 45 | Patches both; optional RECONNECT inject |
| Anti-AFK | C→S `MOVE` 62; S→C `MAPINFO` 92, `RECONNECT` 45 | Native input pulse (no packet inject) |
| Auto Drink | S→C `MAPINFO` 92, `CREATESUCCESS` 101, `UPDATE` 42, `NEWTICK` 10, `DAMAGE` 75, `DEATH` 46, `RECONNECT` 45; C→S `MOVE` 62, `PONG` 31, `PLAYERSHOOT` 30, `USEITEM` 13, `INVENTORYSWAP` 55, `INVDROP` 19, `ESCAPE` 105 | Injects `USEITEM`; arbitrates injected swaps on reserved slots |
| Auto Nexus | above + S→C `GOTO` 18, `ENEMYSHOOT` 35, `AOE` 64; C→S `MOVE` 62, `PLAYERHIT` 90, `AOEACK` 89, `GROUNDDAMAGE` 103, `ESCAPE` 105 | Injects ESCAPE; suppresses 4 report types |
| Chat Filter | S→C `TEXT` 44 | Drops TEXT |
| O3 Helper | S→C `MAPINFO` 92, `CREATESUCCESS` 101, `UPDATE` 42, `NEWTICK` 10, `TEXT` 44; C→S `ENEMYHIT` 25 | Drops ENEMYHIT |
| Commands/feedback | C→S `PLAYERTEXT` 9 | Consumes commands; injects S→C `TEXT` 44 |

Projectile/AOE/report decoding only needed for optional Collision HP + diagnostics.

## 4. Minimum game state

Auto Drink (`client/src/auto-drink/AutoDrinkController.ts` `applyStatus()`): owner objectId, map, position, tick/freshness; HP/maxHP (stats 1/0), MP/maxMP (4/3); condition masks 29, 95; quickslot types 116–118 + `stackCount`; inventory 12–19, backpack 131–146, capacity 130, legacy backpack flag 75; reservations, stock revisions, cooldowns, ambiguous-op backoff. `ClientGameClock` derives time from accepted MOVE/PONG/PLAYERSHOOT (USEITEM timestamps must not be wall-clock). No predicted healing.

Auto Nexus: authoritative server HP/maxHP, identity, map safety, lifecycle generations, escape attempts. Collision HP adds defense, conditions, object-type maps, projectile catalog, tiles, pending-impact reconciliation. **Do not use `PlayerData.effectiveMaxHealth`** — use server stat 0.

Anti-AFK: `AntiAfkDetector` (5 min stationary MOVE, resets on gaps/map change, requires socket↔native process identity); `InternalBridge` pipe `\\.\pipe\lfg-dev-bridge`; native `AntiAfk::RequestPulse()` / `RouteWindowMessage()` → mouse down/up via window proc. **Requires a native input bridge.**

O3 Helper: own small set — Oryx 45363, guardians 8701–8703, Dammah 9635, shield stat 125, selected Dammah TEXT lines. Known source issues:
- `SHOWEFFECT` 11 has no decoded fields → all tracked guardians blocked (no active-coin exception).
- `canHit()` returns from coin branch before the Dammah check → `ignoreCoins=true` bypasses Dammah for non-coin targets.

## 5. Size and dependencies

| Piece | Files / LOC |
|---|---|
| Redirect/install | `client/winhttp-proxy/src/connect_hook.cpp` 115; `dllmain.cpp` 42; `client/src/hooker/GameHooker.ts` 170 |
| Transport | `client/src/proxy/network-worker.ts` 607; `NetworkHost.ts` 44; `NetworkProtocol.ts` 50 |
| Main-thread proxy | `Proxy.ts` 420; `ClientConnection.ts` 539 |
| Transfers | `ReconnectHandler.ts` 228; `reconnectRoute.ts` 35; `client/src/state/State.ts` 53 |
| Codec | `PacketFactory` 426, `PacketReader` 131, `PacketWriter` 124, `Packet` 56; `src/crypto/RC4Cipher.ts` 78 |
| Canonical/checks | `packet-definitions.json` 2,859; generator 287, check 167 |
| Server conveniences | `ServerSwitchService.ts` 217; `ServerListFetcher.ts` 52; plugins 17/141 |
| Anti-AFK | plugin 70; detector 56; TCP identity 141; `InternalBridge.ts` 511; native `AntiAfk.cpp` 273 |
| Auto Drink | plugin 155; catalog 94; controller 318; clock 67 |
| Auto Nexus | plugin 102; `SafetyEngine.ts` 527; coordinator 203; report guard 34; predictor 188 |
| Chat Filter / O3 | `chat-filter.ts` 96 + helpers; `o3-helper.ts` 355 |
| Broad infra (mostly drop) | StateManager 361; PlayerData 291; GameWorldState 1,042; ProjectileTracker 153; PartyRosterState 165; PluginContext 668; PluginManager 662 |

Deps: transport = Node built-ins only. Retained features add `koffi` (Windows TCP/process identity) and `fast-xml-parser` (consumable metadata). `ws` = dashboard, `sharp` = sprites, `electron-updater` = updates — outside network core. Headless core adds `reflect-metadata` — not needed.

Removal candidates: legacy main-thread sockets/ciphers, lag-switch, headless account/trade/vault, party tracking, broad world/projectile dashboard tracking, server-switch/ip-connect UI, sprite processing, unrelated native features. Collision HP removal is a **scope decision**.

## 6. Recommended modules

1. `transport-worker` — sockets, bounded framing, 4 ciphers, ordered decisions, generations, final writer.
2. `protocol` — production codec, canonical schema, stat types, generated artifacts + drift checks.
3. `routing` — original-target identity, HELLO patching, reconnect handoff, bounded route-token storage.
4. `session-state` — authoritative player/map/stock snapshots with freshness; collision state separate.
5. `automation` — worker-owned Auto Drink, Auto Nexus, escape arbitration, suppression policy.
6. `plugin-host` — small `register(ctx)` with subscriptions, packet decisions, validated settings, commands, inject, cleanup.
7. `native-adapter` — redirect + process-scoped Anti-AFK input; optional health diagnostics.

Main-thread hooks must never gate automatic ESCAPE. Don't route every packet through every layer when no plugin subscribed.

Risks: packet id/layout drift; duplicated RC4 keys (consolidate to one versioned source); stat interpretation drift; stale routing fallback; reconnect-token lifetime (current GUID map in `Proxy` has **no expiry**); native compatibility.
