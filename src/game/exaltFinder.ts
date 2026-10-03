// Ported from realm-engine-client client/src/hooker/ExaltFinder.ts @ 9ab4f8f (MIT, see NOTICE). Search order adapted; adds Steam libraryfolders.vdf parsing.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EXALT_EXE = 'RotMG Exalt.exe';

export interface FinderEnv {
  env: NodeJS.ProcessEnv;
  home: string;
  exists(path: string): boolean;
  readText(path: string): string | null;
}

export const STEAM_ROOTS = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
const STEAM_GAME_FOLDERS = ['RotMG Exalt', 'Realm of the Mad God'];

function defaultFinder(): FinderEnv {
  return {
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readText: path => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
  };
}

/** Library paths from Steam's libraryfolders.vdf. */
export function steamLibraries(vdf: string): string[] {
  const paths: string[] = [];
  for (const match of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) paths.push(match[1].replace(/\\\\/g, '\\'));
  return paths;
}

export function exaltCandidates(f: FinderEnv): string[] {
  const local = f.env.LOCALAPPDATA || join(f.home, 'AppData', 'Local');
  const libraries = new Set<string>(STEAM_ROOTS);
  for (const root of STEAM_ROOTS) {
    const vdf = f.readText(join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) for (const library of steamLibraries(vdf)) libraries.add(library);
  }
  return [
    f.env.ROTMG_PATH ?? '',
    join(local, 'RealmOfTheMadGod', 'Production'),
    join(f.home, 'Documents', 'RealmOfTheMadGod', 'Production'),
    ...[...libraries].flatMap(library => STEAM_GAME_FOLDERS.map(game => join(library, 'steamapps', 'common', game))),
  ].filter(dir => dir.length > 0);
}

/** Every Exalt install on this machine, best first. */
export function findExaltDirs(f: FinderEnv = defaultFinder()): string[] {
  const found: string[] = [];
  for (const dir of exaltCandidates(f)) {
    if (!found.includes(dir) && f.exists(join(dir, EXALT_EXE))) found.push(dir);
  }
  return found;
}

export function isExaltDir(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(dir, EXALT_EXE));
}
