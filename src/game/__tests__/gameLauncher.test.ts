import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STEAM_ROOTS } from '../exaltFinder.ts';
import {
  LAUNCHER_EXE, STEAM_GAME_NAME, decaLauncherCandidates, describeLaunchTarget,
  findLaunchTarget, findSteamAppId, openLaunchTarget, parseRegInstallLocations, type LauncherEnv,
} from '../gameLauncher.ts';

function fakeEnv(overrides: Partial<LauncherEnv> = {}): LauncherEnv {
  return { env: {}, exists: () => false, readText: () => null, listDir: () => [], regQuery: () => null, ...overrides };
}

function steamEnv(): LauncherEnv {
  const library = 'D:\\SteamLibrary';
  const files = new Map([
    [join(STEAM_ROOTS[0], 'steamapps', 'libraryfolders.vdf'), '"libraryfolders" { "1" { "path" "D:\\\\SteamLibrary" } }'],
    [join(library, 'steamapps', 'appmanifest_123.acf'), '"AppState" { "appid" "123" "name" "Another game" }'],
    [join(library, 'steamapps', 'appmanifest_987654.acf'), `"AppState" { "appid" "987654" "name" "${STEAM_GAME_NAME}" }`],
  ]);
  return fakeEnv({
    readText: path => files.get(path) ?? null,
    listDir: path => path === join(library, 'steamapps')
      ? ['appmanifest_123.acf', 'appmanifest_404.acf', 'appmanifest_987654.acf'] : [],
  });
}

describe('launcher discovery', () => {
  it('extracts only nonempty REG_SZ install locations across registry keys', () => {
    expect(parseRegInstallLocations(`
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Launcher
    DisplayName    REG_SZ    RotMG Exalt Launcher
    InstallLocation    REG_SZ    C:\\Program Files\\RotMG Exalt Launcher\t
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Empty
    InstallLocation    REG_SZ\t
    InstallLocation    REG_EXPAND_SZ    %LOCALAPPDATA%\\Launcher
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other
    installlocation    reg_sz    D:\\My Launcher
`)).toEqual(['C:\\Program Files\\RotMG Exalt Launcher', 'D:\\My Launcher']);
  });

  it('orders env, registry and known paths and deduplicates case-insensitively', () => {
    const keys: string[] = [];
    const f = fakeEnv({
      env: { ROTMG_LAUNCHER: join('D:\\Preferred', LAUNCHER_EXE), LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      regQuery: key => {
        keys.push(key);
        return [
          'InstallLocation REG_SZ d:\\preferred\nInstallLocation REG_SZ D:\\Registry',
          'InstallLocation REG_SZ C:\\Program Files\\RotMG Exalt Launcher',
          'InstallLocation REG_SZ D:\\Registry32',
        ][keys.length - 1];
      },
    });
    expect(decaLauncherCandidates(f)).toEqual([
      f.env.ROTMG_LAUNCHER,
      join('D:\\Registry', LAUNCHER_EXE),
      join('C:\\Program Files\\RotMG Exalt Launcher', LAUNCHER_EXE),
      join('D:\\Registry32', LAUNCHER_EXE),
      join('C:\\Program Files (x86)\\RotMG Exalt Launcher', LAUNCHER_EXE),
      join(f.env.LOCALAPPDATA!, 'Programs', 'RotMG Exalt Launcher', LAUNCHER_EXE),
    ]);
    expect(keys).toEqual([
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]);
  });

  it('prefers the first existing Deca candidate even when Steam is present', () => {
    const f = steamEnv();
    const exe = join('D:\\Deca', LAUNCHER_EXE);
    f.env.ROTMG_LAUNCHER = 'missing.exe';
    f.regQuery = () => 'InstallLocation REG_SZ D:\\Deca';
    f.exists = path => path === exe || path === join('C:\\Program Files\\RotMG Exalt Launcher', LAUNCHER_EXE);
    expect(findSteamAppId(f)).toBe('987654');
    expect(findLaunchTarget(f)).toEqual({ kind: 'deca', exe });
  });

  it('falls back to the app id read from a manifest in an additional Steam library', () => {
    expect(findLaunchTarget(steamEnv())).toEqual({ kind: 'steam', appId: '987654', uri: 'steam://rungameid/987654' });
  });

  it('also searches both Steam roots and ignores unrelated files and names', () => {
    for (const root of STEAM_ROOTS) {
      const f = fakeEnv({
        listDir: path => path === join(root, 'steamapps') ? ['other.acf', 'appmanifest_42.acf'] : [],
        readText: path => path.endsWith('.acf') ? `"appid" "42" "name" "${STEAM_GAME_NAME}"` : null,
      });
      expect(findSteamAppId(f)).toBe('42');
      f.readText = () => '"appid" "42" "name" "Realm of the Mad God"';
      expect(findSteamAppId(f)).toBeNull();
      f.listDir = () => ['other.acf'];
      f.readText = () => `"appid" "42" "name" "${STEAM_GAME_NAME}"`;
      expect(findSteamAppId(f)).toBeNull();
    }
  });

  it('returns null when neither launcher is found', () => {
    expect(findLaunchTarget(fakeEnv())).toBeNull();
  });

  it('resolves an existing override and reports a missing override without falling back', () => {
    const f = steamEnv();
    f.exists = path => path === 'custom-launcher.exe';
    expect(findLaunchTarget(f, 'custom-launcher.exe')).toEqual({ kind: 'deca', exe: resolve('custom-launcher.exe') });
    expect(() => findLaunchTarget(f, 'missing.exe')).toThrow('Launcher not found: missing.exe');
  });

  it('describes Deca and Steam targets', () => {
    expect(describeLaunchTarget({ kind: 'deca', exe: 'launcher.exe' })).toBe('RotMG Exalt Launcher (launcher.exe)');
    expect(describeLaunchTarget({ kind: 'steam', appId: '42', uri: 'steam://rungameid/42' })).toBe('Steam (app 42)');
  });
});

it('reports a nonexistent Deca exe asynchronously with real spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'realmtool-launch-'));
  rmdirSync(dir);
  let synchronous = true;
  let wasSynchronous = true;
  let onError!: (error: Error) => void;
  const failed = new Promise<Error>(resolveError => {
    onError = error => { wasSynchronous = synchronous; resolveError(error); };
  });
  expect(() => openLaunchTarget({ kind: 'deca', exe: join(dir, LAUNCHER_EXE) }, onError)).not.toThrow();
  synchronous = false;
  const error = await failed;
  expect(wasSynchronous).toBe(false);
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
});
