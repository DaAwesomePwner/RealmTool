// Adapted from realm-engine-client client/plugins/auto-nexus.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { loadSafetyCatalog, type SafetyCatalogLoad } from '../../src/data/safety.ts';
import { readGameBuild } from '../../src/game/gameBuild.ts';
import { log } from '../../src/util/log.ts';
import type { SafetyCatalogState } from '../../src/safety/SafetyCatalog.ts';
import { safetySettings } from '../../src/safety/SafetyTypes.ts';
import { SETTING_DEFS, migrate, validate } from './settings.ts';
import type { AutoNexusConfig, AutoNexusEvent } from './messages.ts';

const ZERO_SUFFIX = ' (proactive escapes suppressed; confirmed server zero only; manual Nexus available)';
const ROUTING = 'routing: normal ESCAPE; server-authorized transfer; automatic escape report suppression policy: after accepted local AUTO escape until new connection; manual ESCAPE alone unaffected';

export function register(ctx: PluginContext, loader: () => SafetyCatalogLoad = loadSafetyCatalog,
  buildReader: (gameDir: string) => string = readGameBuild): void {
  ctx.name = 'Auto Nexus'; ctx.category = 'combat';
  let disposed = false;
  const catalog = loader();
  let loaded = catalogForInstalledBuild(catalog, ctx.gameDir, buildReader);
  const catalogState = (): SafetyCatalogState => loaded.ok
    ? { state: 'ready', gameBuild: loaded.catalog.gameBuild, projectiles: loaded.catalog.projectiles.length, tiles: loaded.catalog.tiles.length }
    : { state: 'fallback', reason: loaded.reason };
  function logCatalog(): void {
    if (loaded.ok) ctx.log(`Safety catalog ready (game build ${loaded.catalog.gameBuild}).`);
    else log.warn('auto-nexus', `Collision HP FALLBACK: server HP only (${loaded.reason}). Run npm run gen:catalogs and restart RealmTool.`);
  }
  logCatalog();
  function refreshCatalog(): boolean {
    const next = catalogForInstalledBuild(catalog, ctx.gameDir, buildReader);
    if (next.ok === loaded.ok && (next.ok || (!loaded.ok && next.reason === loaded.reason))) return false;
    loaded = next;
    logCatalog();
    return true;
  }
  const configuration = (enabled = ctx.enabled): AutoNexusConfig => ({ settings: safetySettings({ enabled,
    preHitPrediction: ctx.getSetting('PreHitPrediction'),
    thresholdPct: ctx.getSetting('ForceAutoNexusHealth'), notification: ctx.getSetting('ShowChatMessageOnNexus'),
    retryCount: ctx.getSetting('EscapeRetryCount'), retryMs: ctx.getSetting('EscapeRetryIntervalMs'),
  }), catalog: loaded.ok ? loaded.catalog : null, catalogState: catalogState() });
  const sync = () => { if (!disposed) ctx.worker.configure(configuration()); };
  for (const { key, ...def } of SETTING_DEFS) ctx.registerSetting(key, def, () => {
    sync();
    if (key === 'PreHitPrediction') ctx.log(modeText(ctx.getSetting('PreHitPrediction') ? (loaded.ok ? 'on' : 'fallback') : 'off', catalogState()));
    if (key === 'ForceAutoNexusHealth') {
      const t = ctx.getSetting<number>(key);
      ctx.log(`Nexus threshold set to ${t}%${t === 0 ? ZERO_SUFFIX : ''}`);
    }
  });
  sync();
  ctx.on('clientConnected', () => { if (!disposed && refreshCatalog()) sync(); });
  ctx.onEnabledChange(() => {
    if (disposed) return;
    // Connection hooks are gated while disabled, so enabling must recheck the build.
    if (ctx.enabled) refreshCatalog();
    sync();
  });
  ctx.registerCleanup(() => { disposed = true; ctx.worker.configure(configuration(false)); });
  const notified = new WeakSet<ClientConnection>();
  function notifyFallback(client: ClientConnection, event: AutoNexusEvent): void {
    // Worker statuses can arrive during login, before chat is visible. Wait for
    // CREATESUCCESS to set a positive player objectId in this lifecycle before sending or marking notified.
    // Check the current catalog too: a queued fallback event must not notify after recovery.
    if (!(event.status.objectId > 0) || !ctx.enabled || !ctx.getSetting('PreHitPrediction') || loaded.ok || event.collisionHp !== 'fallback' || notified.has(client)) return;
    notified.add(client);
    ctx.sendNotification(client, 'AutoNexus', `Collision HP FALLBACK: server HP only (${loaded.reason}). Run npm run gen:catalogs and restart RealmTool.`);
  }

  // Worker timestamps use the process-wide monotonic clock, not wall time.
  // Generation notifications are ordered on this session's worker channel.
  const views = new WeakMap<ClientConnection, { generation: number; sample?: Extract<AutoNexusEvent, { type: 'status' }> }>();
  ctx.worker.onMessage((client, message) => {
    if (disposed || !message || typeof message !== 'object' || !('type' in message)) return;
    const event = message as AutoNexusEvent;
    if (event.type === 'status') {
      if (!Number.isInteger(event.generation) || event.generation < 0) return;
      const current = views.get(client);
      if (current && event.generation < current.generation) return;
      views.set(client, { generation: event.generation, sample: event });
      notifyFallback(client, event);
    } else if (event.type === 'decision') {
      const { decision, writeDelayMs } = event;
      const current = views.get(client);
      if (!Number.isInteger(decision.connectionGeneration) || decision.connectionGeneration < (current?.generation ?? 0)) return;
      notifyFallback(client, event);
      if (!current || decision.connectionGeneration > current.generation) views.set(client, { generation: decision.connectionGeneration });
      const label = decision.origin === 'manual' ? 'MANUAL NEXUS' : 'AUTO NEXUS';
      const t = ctx.getSetting<number>('ForceAutoNexusHealth');
      const text = `Server HP ${decision.confirmedHp ?? '?'}/${decision.maxHp}${event.collisionHp === 'on' ? `; estimated HP ${decision.lowerHp ?? '?'}` : ''}; threshold ${t}%; ${decision.reason}; ${modeText(event.collisionHp, event.catalog)}; local write attempt ${writeDelayMs.toFixed(3)}ms (not server acceptance)`;
      ctx.log(`${label} — ${text}`);
      if (ctx.getSetting<boolean>('ShowChatMessageOnNexus')) ctx.sendNotification(client, label, text);
    }
  });
  ctx.hookCommand('an', (client, _command, args) => {
    if (args.length) {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0 || value > 100) { ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [0-100]'); return; }
      ctx.updateSetting('ForceAutoNexusHealth', value);
    }
    const view = views.get(client);
    const sample = view?.sample;
    const age = sample ? performance.now() - sample.sampledAt : NaN;
    const fresh = sample && sample.generation === view?.generation && Number.isFinite(age) && age >= 0 && age <= 2000;
    if (sample && !fresh) view!.sample = undefined; // A stale sample cannot revive after a clock anomaly.
    const status = fresh ? sample.status : undefined;
    const t = ctx.getSetting<number>('ForceAutoNexusHealth');
    ctx.sendNotification(client, 'AutoNexus', `Threshold ${t}%${t === 0 ? ZERO_SUFFIX : ''}; `
      + (status ? `worker ${status.enabled ? 'enabled' : 'disabled'}; automatic ${status.automaticEligible ? 'eligible' : 'not eligible'}; protection ${status.protectionState}; ${modeText(sample!.collisionHp, sample!.catalog)}; ${sample!.catalog.state === 'ready' ? `catalog game build ${sample!.catalog.gameBuild}` : `catalog fallback: ${sample!.catalog.reason}`}; pending damage ${status.prediction?.pendingDamage ?? 0}, count ${status.prediction?.pendingCount ?? 0}; assumed count ${status.prediction?.assumedCount ?? 0}; attempt ${status.attemptOrigin === 'manual' ? 'MANUAL NEXUS' : status.attemptOrigin} ${status.attemptPhase}; `
        : 'Worker status unavailable / awaiting current worker; ') + ROUTING);
  });
  ctx.hookCommand('reset', client => ctx.sendNotification(client, 'AutoNexus', 'Pending loss reconciles from server evidence and cannot be erased by command.'));
  ctx.hookCommand('nexus', client => ctx.worker.send(client, { type: 'escape' }));
  ctx.log('Loaded — Collision HP on by default (server HP is the floor); server-HP-only is an opt-out; 25% default until saved settings apply; isolated network safety lane; automatic escape report suppression policy: after accepted local AUTO escape until new connection; manual ESCAPE alone unaffected');
}

export default definePlugin({ id: 'auto-nexus', name: 'Auto Nexus', apiVersion: 1,
  capabilities: ['packets', 'commands', 'notifications', 'worker'], register, settings: { validate, migrate } });

function modeText(mode: AutoNexusEvent['collisionHp'], catalog: SafetyCatalogState): string {
  return mode === 'fallback'
    ? `Collision HP fallback (server HP only): ${catalog.state === 'fallback' ? catalog.reason : 'catalog unavailable'}`
    : `Collision HP ${mode}`;
}

function catalogForInstalledBuild(loaded: SafetyCatalogLoad, gameDir: string | null,
  buildReader: (gameDir: string) => string): SafetyCatalogLoad {
  if (!loaded.ok) return loaded;
  if (gameDir === null) return { ok: false, reason: 'installed game build unknown (game directory unavailable)' };
  let installed: string;
  try { installed = buildReader(gameDir); }
  catch (error) {
    return { ok: false, reason: `installed game build unknown (${error instanceof Error ? error.message : String(error)})` };
  }
  if (loaded.catalog.gameBuild !== installed) return { ok: false,
    reason: `catalog is for game build ${loaded.catalog.gameBuild} but the installed game is ${installed}; run npm run gen:catalogs` };
  return loaded;
}
