import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ResourcePaths {
  /** Directory holding data/, native/ and backend/ in a package; the repository root in development. */
  readonly root: string;
  readonly dataDir: string;        // <root>/data
  readonly helperDll: string;      // dev: <root>/native/helper/bin/winhttp.dll; packaged: <root>/native/winhttp.dll
  readonly workerUrl: URL;         // dev: src/transport/worker.ts; packaged: <root>/backend/worker.mjs
  readonly packaged: boolean;
}

/** REALMTOOL_RESOURCES (absolute) selects the packaged layout; otherwise the repository layout. */
export function resourcePaths(env: NodeJS.ProcessEnv = process.env): ResourcePaths {
  const selected = env.REALMTOOL_RESOURCES;
  if (selected !== undefined && !isAbsolute(selected)) throw new Error('REALMTOOL_RESOURCES must be absolute');
  const packaged = selected !== undefined;
  const root = selected ?? fileURLToPath(new URL('../../', import.meta.url));
  return {
    root,
    dataDir: join(root, 'data'),
    helperDll: join(root, packaged ? 'native/winhttp.dll' : 'native/helper/bin/winhttp.dll'),
    workerUrl: pathToFileURL(join(root, packaged ? 'backend/worker.mjs' : 'src/transport/worker.ts')),
    packaged,
  };
}
