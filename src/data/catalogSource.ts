import { readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileStamp { size: number; mtimeMs: number }
export interface GameFileStamps { resourcesAssets: FileStamp; bootConfig: FileStamp }
export interface CatalogSource extends GameFileStamps { schemaVersion: 1; gameBuild: string }
const stamp = ({ size, mtimeMs }: FileStamp): FileStamp => ({ size, mtimeMs });

export function readGameFileStampsSync(gameDataDir: string): GameFileStamps {
  return { resourcesAssets: stamp(statSync(join(gameDataDir, 'resources.assets'))), bootConfig: stamp(statSync(join(gameDataDir, 'boot.config'))) };
}
export async function readGameFileStamps(gameDir: string): Promise<GameFileStamps> {
  const data = join(gameDir, 'RotMG Exalt_Data');
  const [assets, boot] = await Promise.all([stat(join(data, 'resources.assets')), stat(join(data, 'boot.config'))]);
  return { resourcesAssets: stamp(assets), bootConfig: stamp(boot) };
}
export function sameGameFiles(a: GameFileStamps, b: GameFileStamps): boolean {
  return a.resourcesAssets.size === b.resourcesAssets.size && a.resourcesAssets.mtimeMs === b.resourcesAssets.mtimeMs
    && a.bootConfig.size === b.bootConfig.size && a.bootConfig.mtimeMs === b.bootConfig.mtimeMs;
}
export function validateCatalogSource(value: unknown): CatalogSource {
  const source = value as CatalogSource | null;
  const valid = (file: FileStamp | undefined) => !!file && Number.isSafeInteger(file.size) && file.size >= 0
    && Number.isFinite(file.mtimeMs) && file.mtimeMs >= 0;
  if (!source || source.schemaVersion !== 1 || typeof source.gameBuild !== 'string' || !source.gameBuild.trim()
    || !valid(source.resourcesAssets) || !valid(source.bootConfig)) throw new Error('Invalid catalog source fingerprint');
  return { schemaVersion: 1, gameBuild: source.gameBuild, resourcesAssets: stamp(source.resourcesAssets), bootConfig: stamp(source.bootConfig) };
}
export function readCatalogSourceSync(outDir: string): CatalogSource | null {
  try { return validateCatalogSource(JSON.parse(readFileSync(join(outDir, 'source.json'), 'utf8'))); }
  catch { return null; }
}
