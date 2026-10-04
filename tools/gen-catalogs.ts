import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { consumablesFromObjectsXml, objectFragments } from './catalogs/consumables.ts';
import { extractXmlTextAssets, readBuildGuid } from './catalogs/unityText.ts';
import { validateConsumablesCatalog, type ConsumablesCatalog } from '../src/data/consumables.ts';

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = generateCatalog(process.argv.slice(2));
    console.log(`${result.path}: ${result.catalog.items.length} items, ${result.bytes} bytes, gameBuild=${result.catalog.gameBuild}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
