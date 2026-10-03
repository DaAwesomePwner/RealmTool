# Research: The Five Plugins and the Plugin Host (realm-engine-client)

> Source: Codex read-only investigation of `realm-engine-client` @ `9ab4f8f`, 2026-10-03.
> Tests were inspected and counted, not executed. Chat Filter changed during inspection; counts use the reread version.

**Headline:** copying the five plugin folders is insufficient. Auto Nexus and Auto Drink depend on **worker-owned** automation services; Anti-AFK needs a **native input bridge**. None of the five imports `client/packages/core` or `@realmengine/sdk`.

## 1. Inventory

| Plugin | Files / lines |
|---|---|
| Anti-AFK | `client/plugins/anti-afk.ts` 70 |
| Auto Drink | `auto-drink/index.ts` 155, `catalog.ts` 94, `settings.ts` 18 (= 267) |
| Auto Nexus | `auto-nexus.ts` 102, `auto-nexus/forecastTiming.ts` 6 (retired) |
| Chat Filter | `chat-filter.ts` 96, `engine.ts` 34, `normalize.ts` 53, `rules.ts` 60, `sender-state.ts` 72, `settings.ts` 132 (= 447) |
| O3 Helper | `o3-helper.ts` 355 |
| **Total** | 13 files / 1,247 lines (shared services excluded) |

All export `register(ctx)`. Auto Drink disables itself during registration (default off).

### Anti-AFK
- >5 min stationary → native input pulse. Resets on movement change, invalid position, bridge-session change, or observation gap >10 s.
- Setting: `antiAfk=true`.
- Consumes `MOVE`; resets on `MAPINFO`, `RECONNECT`, `clientConnected`, `clientDisconnected`.
- Emits DLL feature commands `antiAfkEnabled`, session-scoped `antiAfkPulse`. No packet injection.
- Imports: `ClientConnection`, `PluginContext`, `sendDllFeature`, `getAntiAfkSession`, `sendAntiAfkPulse`, `describeAntiAfkSession` (from `./api.js`); `AntiAfkDetector` (`client/src/util/antiAfk.ts`).
- `getProcessSession()` matches socket PID **and process start time**.

### Auto Drink
| Setting | Default |
|---|---|
| `enableHp`, `hpThresholdPct` | `true`, `50` |
| `enableMp`, `mpThresholdPct` | `false`, `50` |
| `drinkIntervalMs` | `400` (range 400–5000) |
| `inventoryFallback`, `healingOverTime` | `false`, `false` |
| `slotPriority`, `excludedItems` | `"1,2,3"`, `""` |
| `diagnostics`, hidden `strictSettingsVersion` | `false`, `1` |

Thresholds 0–95%. Cross-plugin warning when Auto Nexus threshold ≥ HP threshold.
- Adapter: settings, catalog (`fast-xml-parser`), diagnostics, status. Controller (`client/src/auto-drink/AutoDrinkController.ts`) in the worker owns decisions.
- Worker consumes server `MAPINFO`, `CREATESUCCESS`, `UPDATE`, `NEWTICK`, `RECONNECT`, `DEATH`, fatal `DAMAGE`; outgoing `MOVE`/`PONG`/`PLAYERSHOOT` for game time; `USEITEM`/`INVENTORYSWAP`/`INVDROP`/`ESCAPE` for reservations. Emits `USEITEM`.
- No predicted healing credited to Auto Nexus.

### Auto Nexus
| Setting | Default |
|---|---:|
| `ForceAutoNexusHealth` | `25` |
| `PreHitPrediction` ("Collision HP") | `false` |
| `ShowChatMessageOnNexus` | `true` |
| `EscapeRetryCount` | `4` |
| `EscapeRetryIntervalMs` | `400` |

- Adapter imports `DEFAULT_SAFETY_SETTINGS`/`SafetySettings` (`src/safety/SafetyTypes.ts`), `AutoNexusStatusOwner`/`StatusClient` (`src/status/AutoNexusStatus.ts`), `sendDllFeature` (only to disable retired DLL features).
- Commands `/an`, `/reset`, `/nexus`.
- `SafetyEngine.observe()` consumes `MAPINFO`, `CREATESUCCESS`, `UPDATE`, `NEWTICK`, `ENEMYSHOOT`, `DAMAGE`, `AOE`, `GOTO`, `RECONNECT`, `DEATH`, `PLAYERHIT`, `AOEACK`, `GROUNDDAMAGE`; final `MOVE` updates position. Emits `ESCAPE`.
- Closure: `PlayerData`/stat constants, HP validity, entity/projectile maps, tile damage, condition/DEF mitigation, `HealthPredictor`, `DamageLedger`, `EscapeAttemptCoordinator`, generations, monotonic scheduling, status. `GameDataLoader.getSafetyCatalog()` derives projectiles (objects.xml) and damage tiles (tiles.xml).

### Chat Filter
| Keys | Defaults |
|---|---|
| `schemaVersion`, `enabled`, `blockedWordsEnabled` | `1`, `true`, `true` |
| `blockedWords`, `wordMatch` | `""`, `"contains"` |
| `advertising`, `trade`, `repetition` | `true`, `false`, `true` |
| `repeatCount`, `repeatWindowSeconds` | `3`, `20` |
| `autoMute`, `muteMinutes` | `false`, `10` |
| `publicChat`, `whispers` | `true`, `true` |
| `guildChat`, `partyChat`, `unknownChat` | `false` |
| `allowedSenders`, `blockedSenders`, `whitelist`, `blacklist` | `""` |
| `captureMessages` | `false` |
| transient preview fields | `previewMessage`, `previewSender="PreviewPlayer"`, `previewChannel="public"`, `selectedSender` |

Buttons: `testMessage`, `refreshStatus`, `clearMutes`, `unmuteSender`, `blockSender`, `allowSender`.
- Import graph is self-contained (adapter → engine/normalize/settings/sender-state/rules; sender-state → `node:crypto`). Externals: `PluginContext`, `ClientConnection`, `SettingDef` types only.
- Evaluation order: disabled/invalid → self/system/NPC exemptions → explicit blocks → explicit bypasses → channel scope → temp mutes → content rules → repetition.
- Lists capped 500 lines × 200 chars; sender match exact, case-insensitive; legacy regex lists not time-bounded.
- Two ad offenses in 60 s → optional 10 min mute. History per connection: ≤1,000 senders, 10 fingerprints/sender, 20 timestamps/fingerprint, SHA-256 fingerprints.
- 250 ms status publication timer; diagnostics keep ≤100 decisions; bodies need opt-in.
- **Best extraction candidate — nearly drop-in.**

### O3 Helper
Settings `enabled`, `ignoreShield`, `ignoreCoins`, `ignoreDammah` (all `true`); `status` text. Consumes `MAPINFO`, `CREATESUCCESS`, `UPDATE`, `NEWTICK`, `TEXT`, `ENEMYHIT`; `/o3` injects `TEXT`. Own entity IDs (Oryx 45363, guardians 8701–8703, Dammah 9635), shield stat 125, Dammah dialogue lines. **No dedicated tests.**

Known bugs (`client/plugins/o3-helper.ts:174` decision tree):
- No `SHOWEFFECT` active-coin handling → enabling coin filter blocks all three guardians.
- `canHit()` returns inside the `ignoreCoins` branch → default-on coin filtering bypasses the later Dammah check.

## 2. Current host

- `client/src/plugins/PluginManager.ts`: discovers top-level `.ts`/`.js` and dir `index.ts`/`index.js`; Auto Nexus first; `register(context)`.
- Enable/disable flips `context.enabled`; hooks check the flag; **disable does not unload**. Unload runs cleanup + `Proxy.unhookPlugin()`.
- Hooks mutate `packet.send` / `packet.modified`. No per-packet hold token (only connection `lagMode`). `Proxy.fireServerPacket()` forces `UPDATE.send=true`.
- `client/packages/core/src/decorators` (`PacketHook`, `Library`) belong to the headless host — unused by these plugins.
- `PluginContext.SettingDef` (`client/src/plugins/PluginContext.ts:35`): boolean, number, range, select, text, button; bounds/options; multiline/help; hidden/advanced; transient; conditional visibility; cross-setting warnings. Plugin-specific validation lives inside the host (should move into plugin definitions).
- `PluginConfigService`: profiles in `Documents/Realmengine/configs`; 800 ms debounced default-profile autosave; Auto Drink + Auto Nexus applied together through a validated worker publish/rollback boundary.
- UI: `app.js::appendPluginSettingsGrid()` renders controls from `SettingDef`, sends `updateSetting` over WebSocket.
- User plugins: `Documents/Realmengine/Plugins/*.mjs` (or `index.mjs`), chokidar 500 ms stability + 75 ms debounce; built-in reload via in-memory esbuild; user reload cache-busts only the entry URL. `UserPluginContext` cleanup runs on unload/reload only. `SDKBridge.install()` sets `globalThis.__realmengineSDK`. **No sandbox** — plain Node import in host process.

## 3. FORK.md guarantees → code

| Guarantee | Implementation |
|---|---|
| Server-HP-only default; 25% | `SafetyTypes.DEFAULT_SAFETY_SETTINGS`, `safetySettings()`; `SafetyEngine.serverHpAtThreshold`, `check()`, gate in `request()` |
| 0% requires explicit server zero | `applyStatus()` validation; zero branches in `check()` |
| Collision HP opt-in; retired controls ignored | `PreHitPrediction` registration; `prepareAutoNexusProfile()`; normalization (V2, BurstGuard/InstantNexus false) |
| No duplicate projectile charge | `SafetyEngine.observe(DAMAGE)` + `HealthPredictor.impact()` |
| Mode change retires debt, keeps lifecycle | `SafetyEngine.configure()` |
| ESCAPE before plugins/UI | `network-worker.ts::Session.receive()` calls engine first; `SafetyEngine.request()` → `writeInitial()` before callback |
| Exactly four reports suppressed | `AutoEscapeReportGuard.REPORTS` |
| Automatic-only, connection-latched | `activate()`; only new connection generation replaces guard |
| Cipher correctness | Entry suppression after decryption; `Session.write()` rechecks before output RC4 |
| 4 retries × 400 ms | `EscapeAttemptCoordinator.advance()` — initial + up to 4, no catch-up bursts |
| Server-authorized transfer | Worker validates RECONNECT; telemetry: local write / server transfer / Nexus MAPINFO |
| Stalled-delivery bound | `Session.tick()`, `stalledDanger()`, `deliveryStalled()` |

## 4. Tests worth porting (static case counts, `client/src/**/__tests__/*.test.ts`)

| Area | Files (cases) |
|---|---|
| plugins | `antiAfk` 47, `autoDrinkCatalog` 58, `autoDrinkPlugin` 32, `autoDrinkSettings` 99, `autoNexusSettings` 55, `chatFilter` 62, `pluginLifecycleCleanup` 2 |
| bridge | `antiAfkReplay` 7 |
| auto-drink | `AutoDrinkController` 64 |
| proxy | `autoDrinkWorker` 19, `autoEscapeReportGuard` 29, `chatVisibility` 1, `networkWorker` 46, `networkWorkerConnect` 4 |
| safety | `strictHp` 22, `hpPrediction` 56, `playerDamage` 14, `safetyLifecycle` 53, `hpReplay` 3 |
| safety diagnostics (likely drop) | `nativeHealthObserver` 12, `safetyTelemetry` 50, `safetyEventRecorder` 9, `safetyRecordingStore` 3 |
| status/dashboard (UI-coupled; rewrite) | `AutoNexus*` 47, `AutoDrink*` 35, `PacketCaptureDashboard` 5, `PluginConfigService.seed` 19, `packetCaptureDemand` 11 |
| other | `prepareGameDataCache` 4, `sdkBridge` 7, `forecastTiming` 1 (retired) |

No O3 Helper tests exist.

## 5. Proposed API (Codex design sketch)

```ts
type Dispose = () => void;
type Verdict =
  | { kind: "pass" }
  | { kind: "drop"; reason?: string }
  | { kind: "modify"; data: Record<string, unknown> };

interface RealmToolContext {
  readonly pluginId: string;
  readonly enabled: boolean;
  onEnabledChange(fn: (enabled: boolean) => void): Dispose;
  registerCleanup(fn: Dispose): void;
  on(event: "clientConnected" | "clientDisconnected", fn: (client: ClientRef) => void): Dispose;
  hookPacket(name: string, fn: (client: ClientRef, packet: PacketView) => Verdict | void,
             options?: { direction?: "client" | "server"; prepend?: boolean }): Dispose;
  hookCommand(name: string, fn: (client: ClientRef, command: string, args: string[]) => void): Dispose;
  state: { player(c: ClientRef): Readonly<PlayerSnapshot> | null; /* ... */ };
  settings: { register<T>(key: string, schema: SettingDef<T>, changed?: (v: T) => void): void;
              get<T>(key: string): T; update<T>(key: string, value: T): boolean; };
  timers: { now(): number; after(ms: number, fn: () => void): Dispose; every(ms: number, fn: () => void): Dispose; };
  log(message: string): void;
  sendNotification(client: ClientRef, sender: string, text: string): void;
  publish(key: string, value: unknown): void;
  safety: SafetyService; consumables: AutoDrinkService; input: SessionInputService;
}
```

Keep: settings schema, scoped subscriptions, connection identity, typed state, notifications, catalog contracts, cancellable timers; move profile migration/validation into plugin definitions. Drop: decorator host, broad SDK namespaces (walking/combat/trade/vault/Discord), retired Dodge/forecast APIs, global mutable SDK bridge, SDK `Date.now()` timing. A real untrusted-plugin sandbox would need process isolation; don't present the `.mjs` loader as one.
