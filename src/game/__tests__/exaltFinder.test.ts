import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXALT_EXE, exaltCandidates, findExaltDirs, steamLibraries, type FinderEnv } from '../exaltFinder.ts';

function finder(files: string[], texts: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}): FinderEnv {
  return { env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ...env }, home: 'C:\\Users\\me',
    exists: path => files.includes(path), readText: path => texts[path] ?? null };
}

describe('Exalt finder', () => {
  it('parses Steam library folders, unescaping backslashes', () => {
    const vdf = '"libraryfolders"\n{\n "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }\n "1" { "path"\t\t"D:\\\\Games\\\\SteamLibrary" }\n}';
    expect(steamLibraries(vdf)).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\Games\\SteamLibrary']);
  });

  it('prefers ROTMG_PATH, then the Deca launcher install, then Steam libraries', () => {
    const deca = join('C:\\Users\\me\\AppData\\Local', 'RealmOfTheMadGod', 'Production');
    const custom = 'E:\\Exalt';
    const steam = join('D:\\Games\\SteamLibrary', 'steamapps', 'common', 'RotMG Exalt');
    const vdfPath = join('C:\\Program Files (x86)\\Steam', 'steamapps', 'libraryfolders.vdf');
    const f = finder([join(deca, EXALT_EXE), join(custom, EXALT_EXE), join(steam, EXALT_EXE)],
      { [vdfPath]: '"path" "D:\\\\Games\\\\SteamLibrary"' }, { ROTMG_PATH: custom });
    expect(findExaltDirs(f)).toEqual([custom, deca, steam]);
    expect(exaltCandidates(f)[0]).toBe(custom);
  });

  it('returns nothing when no candidate holds the exe', () => {
    expect(findExaltDirs(finder([]))).toEqual([]);
  });
});
