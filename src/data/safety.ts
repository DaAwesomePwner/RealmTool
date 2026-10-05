import { readFileSync } from 'node:fs';
import { readCatalogSourceSync, readGameFileStampsSync, sameGameFiles } from './catalogSource.ts';
import { join } from 'node:path';
import { resourcePaths } from '../app/resources.ts';
import { appDataDir } from '../config/store.ts';
import { PROJECTILE_FLAGS, SAFETY_CATALOG_LIMITS as limits,
  type SafetyCatalog, type SafetyCatalogFile, type SafetyProjectileRow } from '../safety/SafetyCatalog.ts';

export type SafetyCatalogLoad = { ok: true; catalog: SafetyCatalogFile; path: string } | { ok: false; reason: string };

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${field}`);
  return value as Record<string, unknown>;
}
function number(value: unknown, field: string, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`Invalid ${field} (expected ${integer ? 'integer ' : ''}0…${max})`);
  }
  return value;
}
function rows(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`Invalid ${field} array`);
  return value;
}
function tuple(value: unknown, length: number, field: string): unknown[] {
  const result = rows(value, field);
  if (result.length !== length) throw new TypeError(`Invalid ${field} tuple length`);
  return result;
}

/** JSON boundary only: return fresh, cloneable data with no XML/runtime dependency. */
export function validateSafetyCatalog(value: unknown): SafetyCatalogFile {
  const file = record(value, 'catalog envelope');
  if (file.schemaVersion !== 1) throw new TypeError('Invalid schemaVersion (expected 1)');
  if (typeof file.gameBuild !== 'string' || !file.gameBuild.trim()) throw new TypeError('Missing or invalid gameBuild');
  const source = record(file.source, 'source');
  const hash = (key: string): string => {
    const value = source[key];
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new TypeError(`Invalid source.${key}`);
    return value;
  };
  const objectsSha256 = hash('objectsSha256'), tilesSha256 = hash('tilesSha256');
  const projectileKeys = new Set<string>(), tileKeys = new Set<number>();
  const projectiles = rows(file.projectiles, 'projectiles').map((value): SafetyProjectileRow => {
    const row = tuple(value, 6, 'projectile');
    const type = number(row[0], 'projectile type', limits.maxType, true);
    const id = number(row[1], 'projectile id', limits.maxProjectileId, true);
    const key = `${type}:${id}`;
    if (projectileKeys.has(key)) throw new TypeError(`Invalid duplicate projectile key ${key}`);
    projectileKeys.add(key);
    const lifetime = number(row[2], 'lifetimeMs', limits.maxLifetimeMs);
    const flags = number(row[3], 'flags', PROJECTILE_FLAGS.multiHit | PROJECTILE_FLAGS.armorPiercing, true);
    const damage = number(row[4], 'maxHealthDamage', limits.maxDamage);
    const effects = rows(row[5], 'effects').map((value): [string, number] => {
      const effect = tuple(value, 2, 'effect');
      if (typeof effect[0] !== 'string' || !effect[0].trim()) throw new TypeError('Invalid effect name');
      return [effect[0], number(effect[1], 'durationSec', limits.maxDurationSec)];
    });
    return [type, id, lifetime, flags, damage, effects];
  });
  const tiles = rows(file.tiles, 'tiles').map((value): [number, number] => {
    const row = tuple(value, 2, 'tile');
    const type = number(row[0], 'tile type', limits.maxType, true);
    if (tileKeys.has(type)) throw new TypeError(`Invalid duplicate tile key ${type}`);
    tileKeys.add(type);
    return [type, number(row[1], 'tile damage', limits.maxDamage)];
  });
  return { schemaVersion: 1, gameBuild: file.gameBuild, source: { objectsSha256, tilesSha256 }, projectiles, tiles };
}

export function toSafetyCatalog(file: SafetyCatalogFile): SafetyCatalog {
  return {
    projectiles: file.projectiles.map(([type, id, lifetimeMs, flags, maxHealthDamage, effects]) => [type, id, {
      lifetimeMs, multiHit: (flags & PROJECTILE_FLAGS.multiHit) !== 0, armorPiercing: (flags & PROJECTILE_FLAGS.armorPiercing) !== 0,
      maxHealthDamage, conditionEffects: effects.map(([effect, durationSec]) => ({ effect, durationSec })),
    }]),
    tiles: file.tiles.map(([type, damage]) => [type, damage]),
  };
}

export function loadSafetyCatalog(options: { appDataDir?: string; bundledPath?: string; gameBuild?: string; gameDir?: string } = {}): SafetyCatalogLoad {
  const bundled = options.bundledPath ?? join(resourcePaths().dataDir, 'catalogs/safety.json');
  let first: SafetyCatalogLoad | undefined;
  for (const path of [join(options.appDataDir ?? appDataDir(), 'data', 'catalogs', 'safety.json'), bundled]) {
    let result: SafetyCatalogLoad;
    try {
      const bytes = readFileSync(path);
      if (bytes.length > limits.maxFileBytes) throw new Error(`catalog exceeds ${limits.maxFileBytes} bytes`);
      result = { ok: true, catalog: validateSafetyCatalog(JSON.parse(bytes.toString('utf8'))), path };
      if (options.gameDir && path === join(options.appDataDir ?? appDataDir(), 'data', 'catalogs', 'safety.json')) {
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
  return first ?? { ok: false, reason: 'safety catalog not found' };
}
