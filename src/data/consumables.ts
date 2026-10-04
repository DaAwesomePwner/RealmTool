// Adapted from realm-engine-client client/src/auto-drink/AutoDrinkTypes.ts @ 88a66b2 (MIT, see NOTICE).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDataDir } from '../config/store.ts';

export interface AutoDrinkItem {
  type: number;
  name: string;
  hp: number;
  mp: number;
  healingDurationMs: number;
  quickslot: boolean;
}
export interface ConsumablesCatalog {
  schemaVersion: 1;
  gameBuild: string;
  source: { objectsSha256: string };
  items: AutoDrinkItem[];
}
export type CatalogLoad = { ok: true; catalog: ConsumablesCatalog; path: string } | { ok: false; reason: string };

/** Shared JSON boundary validation; deliberately has no XML dependency. */
export function validateConsumableItems(items: unknown): AutoDrinkItem[] {
  if (!Array.isArray(items)) throw new TypeError('Auto Drink catalog items must be an array');
  const seen = new Set<number>();
  return items.map(item => {
    if (!item || !Number.isInteger(item.type) || item.type < 0 || item.type > 0x7fffffff || seen.has(item.type)
      || typeof item.name !== 'string' || typeof item.quickslot !== 'boolean'
      || ![item.hp, item.mp, item.healingDurationMs].every(v => Number.isFinite(v) && v >= 0)
      || item.healingDurationMs > 86_400_000 || (item.hp === 0 && item.mp === 0 && item.healingDurationMs === 0)) {
      throw new TypeError('Invalid or duplicate Auto Drink catalog item');
    }
    seen.add(item.type);
    return { type: item.type, name: item.name, hp: item.hp, mp: item.mp,
      healingDurationMs: item.healingDurationMs, quickslot: item.quickslot };
  });
}

export function validateConsumablesCatalog(value: unknown): ConsumablesCatalog {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid catalog envelope');
  const catalog = value as Partial<ConsumablesCatalog>;
  if (catalog.schemaVersion !== 1) throw new TypeError('Invalid schemaVersion (expected 1)');
  if (typeof catalog.gameBuild !== 'string' || !catalog.gameBuild.trim()) throw new TypeError('Missing or invalid gameBuild');
  if (!catalog.source || typeof catalog.source.objectsSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(catalog.source.objectsSha256)) {
    throw new TypeError('Invalid source.objectsSha256');
  }
  return { schemaVersion: 1, gameBuild: catalog.gameBuild,
    source: { objectsSha256: catalog.source.objectsSha256 }, items: validateConsumableItems(catalog.items) };
}

export function loadConsumables(options: { appDataDir?: string; bundledPath?: string } = {}): CatalogLoad {
  const appData = options.appDataDir ?? appDataDir();
  const bundled = options.bundledPath ?? fileURLToPath(new URL('../../data/catalogs/consumables.json', import.meta.url));
  const paths = [join(appData, 'data', 'catalogs', 'consumables.json'), bundled];
  for (const path of paths) {
    let json: string;
    try { json = readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, reason: `${path}: ${String(error)}` };
    }
    try { return { ok: true, catalog: validateConsumablesCatalog(JSON.parse(json)), path }; }
    catch (error) { return { ok: false, reason: `${path}: ${error instanceof SyntaxError ? 'Invalid JSON: ' : ''}${String(error)}` }; }
  }
  return { ok: false, reason: 'consumables catalog not found' };
}
