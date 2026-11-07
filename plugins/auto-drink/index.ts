// Adapted from realm-engine-client client/plugins/auto-drink/index.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type PluginContext } from '../../src/plugins/api.ts';
import type { AutoDrinkStatus } from '../../src/auto-drink/AutoDrinkTypes.ts';
import { loadConsumables, type CatalogLoad } from '../../src/data/consumables.ts';
import { readGameBuild } from '../../src/game/gameBuild.ts';
import { SETTING_DEFS, migrate, validate, workerSettings } from './settings.ts';
import { validateConfig, type AutoDrinkEvent } from './messages.ts';

/** Configuration, verified JSON catalog and display only; decisions belong to the worker. */
export function register(ctx: PluginContext, loader: (options?: { gameBuild?: string; gameDir?: string }) => CatalogLoad = loadConsumables,
  buildReader: (gameDir: string) => string = readGameBuild): void {
  ctx.name = 'Auto Drink';
  ctx.category = 'automation';
  ctx.enabled = false;
  let disposed = false;
  let awaitingVerification = false;
  let lastMessageRetry = -Infinity;
  function readCatalog() {
    let gameBuild: string | undefined, buildError: unknown;
    try { if (ctx.gameDir) gameBuild = buildReader(ctx.gameDir); } catch (error) { buildError = error; }
    const catalog = loader({ gameBuild, gameDir: ctx.gameDir ?? undefined });
    return { catalog, loaded: catalogForInstalledBuild(catalog, ctx.gameDir, () => {
      if (buildError) throw buildError;
      return gameBuild!;
    }) };
  }
  let { catalog, loaded } = readCatalog();
  function logCatalog(): void {
    ctx.log(loaded.ok
      ? `Loaded ${loaded.catalog.items.length} verified restorative consumables (game build ${loaded.catalog.gameBuild}).`
      : `Consumables catalog unavailable: ${loaded.reason}`);
  }
  logCatalog();
  function config(enabled = ctx.enabled) {
    const values = Object.fromEntries(SETTING_DEFS.map(({ key }) => [key, ctx.getSetting(key)]));
    return validateConfig({ settings: workerSettings(values, enabled), items: loaded.ok ? loaded.catalog.items : [],
      gameBuild: catalog.ok ? catalog.catalog.gameBuild : null, gameDir: ctx.gameDir });
  }
  function sync(): void { if (!disposed) ctx.worker.configure(config()); }
  for (const { key, ...def } of SETTING_DEFS) {
    ctx.registerSetting(key, def, key === 'diagnostics' || key === 'strictSettingsVersion' ? undefined : sync);
  }
  let displayed: AutoDrinkStatus & { clientId: string | null } = {
    enabled: false, state: 'disabled', reason: 'Auto Drink is disabled', hp: null, maxHp: 0,
    slotId: null, itemType: null, lastAttemptAt: null, cooldownRemainingMs: 0, pending: false, epoch: 0, clientId: null,
  };
  let current = displayed;
  function publish(status: AutoDrinkStatus, clientId: string | null): void {
    current = { ...status, clientId };
    displayed = { ...current, reason: loaded.ok ? status.reason : `consumables catalog unavailable: ${loaded.reason}` };
    ctx.setData('status', displayed);
    ctx.broadcastData('status', displayed);
  }
  publish(displayed, null);
  function refreshCatalog(): boolean {
    if (awaitingVerification) return false;
    // A failed reload must not pin the invalidation placeholder for this lifetime.
    const retry = !loaded.ok ? readCatalog() : null;
    if (retry) catalog = retry.catalog;
    const next = retry?.loaded ?? catalogForInstalledBuild(catalog, ctx.gameDir, buildReader);
    if (next.ok === loaded.ok && (next.ok || (!loaded.ok && next.reason === loaded.reason))) return false;
    loaded = next;
    logCatalog();
    publish(current, current.clientId);
    return true;
  }
  ctx.onDataInvalidated(reason => {
    awaitingVerification = true;
    if (disposed || (!catalog.ok && catalog.reason === reason)) return;
    catalog = loaded = { ok: false, reason };
    sync();
    publish(current, current.clientId);
  });
  ctx.onDataRefreshed(() => {
    if (disposed) return;
    awaitingVerification = false;
    const { catalog: candidate, loaded: next } = readCatalog();
    if (!next.ok) throw new Error(next.reason);
    const previous = catalog, previousLoaded = loaded;
    catalog = candidate; loaded = next;
    try { sync(); } catch (error) { catalog = previous; loaded = previousLoaded; throw error; }
    logCatalog();
    publish(current, current.clientId);
  });
  ctx.on('clientConnected', () => {
    if (!disposed && refreshCatalog()) sync();
  });
  const diagnostics = new WeakMap<object, string>();
  const warnings = new WeakMap<object, Map<number, string>>();
  const generations = new WeakMap<object, number>();
  ctx.worker.onMessage((client, message) => {
    if (disposed || !message || typeof message !== 'object') return;
    if (!loaded.ok && !awaitingVerification && performance.now() - lastMessageRetry >= 15_000) {
      lastMessageRetry = performance.now();
      try { if (refreshCatalog()) sync(); } catch { /* Retry transient disk failures on a later message. */ }
    }
    const event = message as AutoDrinkEvent;
    if (event.type !== 'status' || !event.status || !Number.isInteger(event.generation)
      || event.generation < (generations.get(client) ?? 0)) return;
    generations.set(client, event.generation);
    const status = event.status;
    publish(status, client.clientId);
    const seen = warnings.get(client) ?? new Map<number, string>();
    warnings.set(client, seen);
    for (const exhausted of status.exhaustedSlots ?? []) {
      const episode = JSON.stringify([event.generation, status.epoch, exhausted.episode]);
      if (seen.get(exhausted.slotId) === episode) continue;
      seen.set(exhausted.slotId, episode);
      ctx.log(`[${client.clientId}] Warning: ${exhausted.reason}; waiting for stock to change.`);
    }
    if (!ctx.getSetting('diagnostics')) return;
    const signature = JSON.stringify([status.epoch, status.enabled, status.state, status.reason,
      status.slotId, status.itemType, status.lastAttemptAt, status.pending]);
    if (diagnostics.get(client) === signature) return;
    diagnostics.set(client, signature);
    ctx.log(`[${client.clientId}] ${status.state}: ${status.reason}; server HP ${status.hp ?? '?'}/${status.maxHp}; `
      + `slot ${status.slotId ?? 'none'}, item ${status.itemType ?? 'none'}, pending ${status.pending}`);
  });
  ctx.onEnabledChange(() => {
    if (disposed) return;
    // The host gates connection events while disabled; verify before enabling that session too.
    if (ctx.enabled) refreshCatalog();
    sync();
    if (displayed.enabled === ctx.enabled) return;
    publish({ ...current, enabled: ctx.enabled, state: ctx.enabled ? 'waiting' : 'disabled',
      reason: ctx.enabled ? 'Waiting for worker status' : 'Auto Drink is disabled' }, displayed.clientId);
  });
  ctx.registerCleanup(() => { disposed = true; ctx.worker.configure(config(false)); });
  sync();
}

function catalogForInstalledBuild(loaded: CatalogLoad, gameDir: string | null, buildReader: (gameDir: string) => string): CatalogLoad {
  if (!loaded.ok) return loaded;
  if (gameDir === null) return { ok: false, reason: 'installed game build unknown (game directory unavailable)' };
  let installed: string;
  try { installed = buildReader(gameDir); }
  catch (error) {
    return { ok: false, reason: `installed game build unknown (${error instanceof Error ? error.message : String(error)})` };
  }
  if (loaded.catalog.gameBuild !== installed) return { ok: false,
    reason: `catalog is for game build ${loaded.catalog.gameBuild} but the installed game is ${installed}; RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log` };
  return loaded;
}

export function createAutoDrinkPlugin(loader: (options?: { gameBuild?: string; gameDir?: string }) => CatalogLoad = loadConsumables, buildReader: (gameDir: string) => string = readGameBuild) {
  return definePlugin({ id: 'auto-drink', name: 'Auto Drink', apiVersion: 1, capabilities: ['packets', 'worker'],
    register: ctx => register(ctx, loader, buildReader), settings: { validate, migrate } });
}
export default createAutoDrinkPlugin();
