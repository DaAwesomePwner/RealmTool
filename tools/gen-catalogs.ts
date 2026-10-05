import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalog, generateCatalogs } from '../src/catalogs/generate.ts';
export { generateCatalog, generateCatalogs };

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
