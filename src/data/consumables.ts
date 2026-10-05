// Adapted from realm-engine-client client/src/auto-drink/AutoDrinkTypes.ts @ 88a66b2 (MIT, see NOTICE).
import { readFileSync } from 'node:fs';
import { readCatalogSourceSync, readGameFileStampsSync, sameGameFiles } from './catalogSource.ts';
import { join } from 'node:path';
import { resourcePaths } from '../app/resources.ts';
import { appDataDir } from '../config/store.ts';
import type { AutoDrinkItem } from '../auto-drink/AutoDrinkTypes.ts';
export type { AutoDrinkItem } from '../auto-drink/AutoDrinkTypes.ts';
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

export function loadConsumables(options: { appDataDir?: string; bundledPath?: string; gameBuild?: string; gameDir?: string } = {}): CatalogLoad {
  const bundled = options.bundledPath ?? join(resourcePaths().dataDir, 'catalogs/consumables.json');
  let first: CatalogLoad | undefined;
  for (const path of [join(options.appDataDir ?? appDataDir(), 'data', 'catalogs', 'consumables.json'), bundled]) {
    let result: CatalogLoad;
    try {
      const bytes = readFileSync(path);
      result = { ok: true, catalog: validateConsumablesCatalog(JSON.parse(bytes.toString('utf8'))), path };
      if (options.gameDir && path === join(options.appDataDir ?? appDataDir(), 'data', 'catalogs', 'consumables.json')) {
        const source = readCatalogSourceSync(join(options.appDataDir ?? appDataDir(), 'data', 'catalogs'));
        if (!source || source.gameBuild !== result.catalog.gameBuild
          || !sameGameFiles(source, readGameFileStampsSync(join(options.gameDir, 'RotMG Exalt_Data')))) {
          throw new Error('catalog source fingerprint is missing or stale; waiting for verified game data');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      result = { ok: false, reason: `${path}: ${error instanceof SyntaxError ? 'Invalid JSON: ' : ''}${String(error)}` };
    }
    first ??= result;
    if (!options.gameBuild || (result.ok && result.catalog.gameBuild === options.gameBuild)) return result;
  }
  return first ?? { ok: false, reason: 'consumables catalog not found' };
}
