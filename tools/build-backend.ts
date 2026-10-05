import { build } from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildBackend(options: { outDir?: string; allowMissingHelper?: boolean } = {}): Promise<void> {
  const out = resolve(options.outDir ?? join(root, 'dist/app'));
  const helper = join(root, 'native/helper/bin/winhttp.dll');
  if (!existsSync(helper) && !options.allowMissingHelper) throw new Error('Missing helper DLL; run npm run build:helper or pass --allow-missing-helper');
  const backend = join(out, 'backend');
  const result = await build({
    absWorkingDir: root,
    entryPoints: { main: 'src/cli.ts', worker: 'src/transport/worker.ts' },
    outdir: backend, outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['koffi'],
    minify: true, sourcemap: 'linked', metafile: true, write: false,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const specifier of output.imports) {
      if (/\.ts(?:$|[?#])|\/src\//.test(specifier.path)) throw new Error(`Unbundled source module: ${specifier.path}`);
    }
  }
  mkdirSync(backend, { recursive: true });
  for (const file of result.outputFiles) writeFileSync(file.path, file.contents);
  cpSync(join(root, 'data'), join(out, 'data'), { recursive: true });
  mkdirSync(join(out, 'native'), { recursive: true });
  if (existsSync(helper)) copyFileSync(helper, join(out, 'native/winhttp.dll'));
  else rmSync(join(out, 'native/winhttp.dll'), { force: true });
  const koffiSource = dirname(createRequire(import.meta.url).resolve('koffi/package.json'));
  const koffiDest = join(backend, 'node_modules/koffi');
  rmSync(koffiDest, { recursive: true, force: true });
  mkdirSync(join(koffiDest, 'build/koffi/win32_x64'), { recursive: true });
  for (const file of ['package.json', 'index.js', 'LICENSE.txt', 'build/koffi/win32_x64/koffi.node']) {
    copyFileSync(join(koffiSource, file), join(koffiDest, file));
  }
  for (const name of ['main.mjs', 'worker.mjs']) console.log(`${name}: ${statSync(join(backend, name)).size} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'allow-missing-helper': { type: 'boolean' } } });
  await buildBackend({ outDir: values['out-dir'], allowMissingHelper: values['allow-missing-helper'] });
}
