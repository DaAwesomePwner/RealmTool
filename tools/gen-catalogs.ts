import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { consumablesFromObjectsXml, objectFragments } from './catalogs/consumables.ts';
import { extractXmlTextAssets } from './catalogs/unityText.ts';
import { readBuildGuid } from '../src/game/gameBuild.ts';
import { validateConsumablesCatalog, type ConsumablesCatalog } from '../src/data/consumables.ts';
import { groundFragments, safetyFromXml } from './catalogs/safety.ts';
import { validateSafetyCatalog } from '../src/data/safety.ts';
import { SAFETY_CATALOG_LIMITS } from '../src/safety/SafetyCatalog.ts';

export function generateCatalog(args: string[]): { catalog: ConsumablesCatalog; path: string; bytes: number } {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--game-dir', '--objects', '--build', '--out'].includes(key) || !value || value.startsWith('--') || options.has(key)) {
      throw new Error('Usage: node tools/gen-catalogs.ts (--game-dir <dir> | --objects <objects.xml> --build <label>) [--out <path>]');
    }
    options.set(key, value);
  }
  if ((options.has('--objects') && options.has('--game-dir')) || options.has('--objects') !== options.has('--build')) {
    throw new Error('Use --game-dir or --objects with --build');
  }
  let xml: string, gameBuild: string;
  const objectsPath = options.get('--objects');
  if (objectsPath) {
    xml = fs.readFileSync(objectsPath, 'utf8');
    gameBuild = options.get('--build')!;
  } else {
    const gameDir = options.get('--game-dir') ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'RealmOfTheMadGod', 'Production'));
    if (!gameDir) throw new Error('No LOCALAPPDATA; supply --game-dir');
    const dataDir = join(gameDir, 'RotMG Exalt_Data');
    gameBuild = readBuildGuid(dataDir);
    const extracted = extractXmlTextAssets(fs.readFileSync(join(dataDir, 'resources.assets')));
    if (!extracted.objects.length) throw new Error('No Objects XML TextAssets found');
    // Structural enumeration also excludes comments/CDATA around the XML root.
    const fragments = extracted.objects.flatMap(objectFragments);
    xml = `<Objects>\n${fragments.join('\n')}\n</Objects>`;
  }
  const catalog = validateConsumablesCatalog({ schemaVersion: 1, gameBuild,
    source: { objectsSha256: createHash('sha256').update(xml).digest('hex') }, items: consumablesFromObjectsXml(xml) });
  const json = JSON.stringify(catalog, null, 2) + '\n';
  const path = resolve(options.get('--out') ?? 'data/catalogs/consumables.json');
  fs.mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, json, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { catalog, path, bytes: Buffer.byteLength(json) };
}

export function generateCatalogs(args: string[]): {
  consumables: { path: string; bytes: number; items: number };
  safety: { path: string; bytes: number; projectiles: number; tiles: number }; gameBuild: string;
} {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--game-dir', '--objects', '--tiles', '--build', '--out-dir'].includes(key) || !value || value.startsWith('--') || options.has(key)) {
      throw new Error('Usage: node tools/gen-catalogs.ts [--game-dir <dir> | --objects <xml> --tiles <xml> --build <label>] [--out-dir <dir>]');
    }
    options.set(key, value);
  }
  const explicit = ['--objects', '--tiles', '--build'].some(key => options.has(key));
  if (explicit && (options.has('--game-dir') || !['--objects', '--tiles', '--build'].every(key => options.has(key)))) {
    throw new Error('Use --game-dir or --objects with --tiles and --build');
  }
  let objectsXml: string, tilesXml: string, gameBuild: string;
  if (explicit) {
    objectsXml = fs.readFileSync(options.get('--objects')!, 'utf8');
    tilesXml = fs.readFileSync(options.get('--tiles')!, 'utf8');
    gameBuild = options.get('--build')!;
  } else {
    const gameDir = options.get('--game-dir') ?? (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'RealmOfTheMadGod', 'Production'));
    if (!gameDir) throw new Error('No LOCALAPPDATA; supply --game-dir');
    const dataDir = join(gameDir, 'RotMG Exalt_Data');
    gameBuild = readBuildGuid(dataDir);
    const extracted = extractXmlTextAssets(fs.readFileSync(join(dataDir, 'resources.assets')));
    if (!extracted.objects.length || !extracted.tiles.length) throw new Error('Missing Objects or GroundTypes XML TextAssets');
    objectsXml = `<Objects>\n${extracted.objects.flatMap(objectFragments).join('\n')}\n</Objects>`;
    tilesXml = `<GroundTypes>\n${extracted.tiles.flatMap(groundFragments).join('\n')}\n</GroundTypes>`;
  }
  const objectsSha256 = createHash('sha256').update(objectsXml).digest('hex');
  const consumables = validateConsumablesCatalog({ schemaVersion: 1, gameBuild,
    source: { objectsSha256 }, items: consumablesFromObjectsXml(objectsXml) });
  const safety = validateSafetyCatalog({ schemaVersion: 1, gameBuild,
    source: { objectsSha256, tilesSha256: createHash('sha256').update(tilesXml).digest('hex') }, ...safetyFromXml(objectsXml, tilesXml) });
  const consumablesJson = JSON.stringify(consumables, null, 2) + '\n', safetyJson = JSON.stringify(safety) + '\n';
  const consumablesBytes = Buffer.byteLength(consumablesJson), safetyBytes = Buffer.byteLength(safetyJson);
  if (safetyBytes > SAFETY_CATALOG_LIMITS.maxFileBytes) throw new Error(`Safety catalog exceeds ${SAFETY_CATALOG_LIMITS.maxFileBytes} bytes`);
  if (consumablesBytes + safetyBytes > 2 * 1024 * 1024) throw new Error('Combined catalogs exceed 2 MiB');
  const outDir = resolve(options.get('--out-dir') ?? 'data/catalogs');
  const outputs = [
    { path: join(outDir, 'consumables.json'), json: consumablesJson },
    { path: join(outDir, 'safety.json'), json: safetyJson },
  ].map(output => ({ ...output, temporary: `${output.path}.${randomUUID()}.tmp` }));
  fs.mkdirSync(outDir, { recursive: true });
  // Validation and staging finish before publication. Two renames are not a filesystem transaction.
  try {
    for (const output of outputs) fs.writeFileSync(output.temporary, output.json, { encoding: 'utf8', flag: 'wx' });
    for (const output of outputs) fs.renameSync(output.temporary, output.path);
  } finally {
    for (const output of outputs) fs.rmSync(output.temporary, { force: true });
  }
  return { consumables: { path: outputs[0].path, bytes: consumablesBytes, items: consumables.items.length },
    safety: { path: outputs[1].path, bytes: safetyBytes, projectiles: safety.projectiles.length, tiles: safety.tiles.length }, gameBuild };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--objects') && !args.includes('--tiles') && !args.includes('--out-dir')) {
      const result = generateCatalog(args);
      console.log(`${result.path}: ${result.catalog.items.length} items, ${result.bytes} bytes, gameBuild=${result.catalog.gameBuild}`);
    } else {
      const result = generateCatalogs(args);
      console.log(`${result.consumables.path}: ${result.consumables.items} items, ${result.consumables.bytes} bytes, gameBuild=${result.gameBuild}`);
      console.log(`${result.safety.path}: ${result.safety.projectiles} projectiles, ${result.safety.tiles} tiles, ${result.safety.bytes} bytes, gameBuild=${result.gameBuild}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
