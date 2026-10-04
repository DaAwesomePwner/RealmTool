// Adapted from realm-engine-client client/plugins/auto-drink/index.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type PluginContext } from '../../src/plugins/api.ts';
import type { AutoDrinkStatus } from '../../src/auto-drink/AutoDrinkTypes.ts';
import { loadConsumables, type CatalogLoad } from '../../src/data/consumables.ts';
import { readGameBuild } from '../../src/game/gameBuild.ts';
import { SETTING_DEFS, migrate, validate, workerSettings } from './settings.ts';
import { validateConfig, type AutoDrinkEvent } from './messages.ts';

/** Configuration, verified JSON catalog and display only; decisions belong to the worker. */
export function register(ctx: PluginContext, loader: () => CatalogLoad = loadConsumables,
  buildReader: (gameDir: string) => string = readGameBuild): void {
  ctx.name = 'Auto Drink';
  ctx.category = 'automation';
  ctx.enabled = false;
  let disposed = false;
  const loaded = catalogForInstalledBuild(loader(), ctx.gameDir, buildReader);
  const items = loaded.ok ? loaded.catalog.items : [];
  ctx.log(loaded.ok
    ? `Loaded ${items.length} verified restorative consumables (game build ${loaded.catalog.gameBuild}).`
    : `Consumables catalog unavailable: ${loaded.reason}`);
  function config(enabled = ctx.enabled) {
    const values = Object.fromEntries(SETTING_DEFS.map(({ key }) => [key, ctx.getSetting(key)]));
    return validateConfig({ settings: workerSettings(values, enabled), items });
  }
  function sync(): void { if (!disposed) ctx.worker.configure(config()); }
  for (const { key, ...def } of SETTING_DEFS) {
    ctx.registerSetting(key, def, key === 'diagnostics' || key === 'strictSettingsVersion' ? undefined : sync);
  }
  let displayed: AutoDrinkStatus & { clientId: string | null } = {
    enabled: false, state: 'disabled', reason: 'Auto Drink is disabled', hp: null, maxHp: 0,
    slotId: null, itemType: null, lastAttemptAt: null, cooldownRemainingMs: 0, pending: false, epoch: 0, clientId: null,
  };
  function publish(status: AutoDrinkStatus, clientId: string | null): void {
    displayed = { ...status, clientId };
    ctx.setData('status', displayed);
    ctx.broadcastData('status', displayed);
  }
  publish(displayed, null);
  const diagnostics = new WeakMap<object, string>();
  const generations = new WeakMap<object, number>();
  ctx.worker.onMessage((client, message) => {
    if (disposed || !message || typeof message !== 'object') return;
    const event = message as AutoDrinkEvent;
    if (event.type !== 'status' || !event.status || !Number.isInteger(event.generation)
      || event.generation < (generations.get(client) ?? 0)) return;
    generations.set(client, event.generation);
    const status = event.status;
    publish(status, client.clientId);
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
    sync();
    if (displayed.enabled === ctx.enabled) return;
    publish({ ...displayed, enabled: ctx.enabled, state: ctx.enabled ? 'waiting' : 'disabled',
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
    reason: `catalog is for game build ${loaded.catalog.gameBuild} but the installed game is ${installed}; run npm run gen:catalogs` };
  return loaded;
}

export function createAutoDrinkPlugin(loader: () => CatalogLoad = loadConsumables, buildReader: (gameDir: string) => string = readGameBuild) {
  return definePlugin({ id: 'auto-drink', name: 'Auto Drink', apiVersion: 1, capabilities: ['packets', 'worker'],
    register: ctx => register(ctx, loader, buildReader), settings: { validate, migrate } });
}
export default createAutoDrinkPlugin();
