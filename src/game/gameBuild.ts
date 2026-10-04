// Adapted from realm-engine-client client/src/util/rotmgLocalExtractor.ts @ 88a66b2 (MIT, see NOTICE).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from '../util/describeError.ts';

/** Unity data-directory entry point retained for catalog generation. */
export function readBuildGuid(gameDataDir: string): string {
  const path = join(gameDataDir, 'boot.config');
  let contents: string;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) {
    throw new Error(`${path}: unable to read boot.config (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  const guid = contents.match(/^build-guid=(.+)$/m)?.[1].trim();
  if (!guid) throw new Error(`${path}: missing build-guid`);
  return guid;
}

/** Read only the installed game's build stamp; no asset extraction or XML parsing. */
export function readGameBuild(gameDir: string): string {
  return readBuildGuid(join(gameDir, 'RotMG Exalt_Data'));
}

/** Worker startup checks must not block socket or safety processing on disk I/O. */
export async function readGameBuildAsync(gameDir: string): Promise<string> {
  const path = join(gameDir, 'RotMG Exalt_Data', 'boot.config');
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) {
    throw new Error(`${path}: unable to read boot.config (${describeError(error)})`, { cause: error });
  }
  const guid = contents.match(/^build-guid=(.+)$/m)?.[1].trim();
  if (!guid) throw new Error(`${path}: missing build-guid`);
  return guid;
}
