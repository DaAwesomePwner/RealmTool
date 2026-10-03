import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEAM_ROOTS } from '../exaltFinder.ts';
import {
  LAUNCHER_EXE, STEAM_GAME_NAME, decaLauncherCandidates, describeLaunchTarget,
  findLaunchTarget, findSteamAppId, openLaunchTarget, parseRegInstallLocations, type LauncherEnv,
} from '../gameLauncher.ts';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

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

  it('checks an existing environment launcher before querying the registry', () => {
    const exe = join('D:\\Preferred', LAUNCHER_EXE);
    const regQuery = vi.fn(() => { throw new Error('Registry must not be queried'); });
    const f = fakeEnv({ env: { ROTMG_LAUNCHER: exe }, exists: path => path === exe, regQuery });
    expect(findLaunchTarget(f)).toEqual({ kind: 'deca', exe });
    expect(regQuery).not.toHaveBeenCalled();
  });

  it('uses a known path after every registry query fails, then falls back to Steam when absent', () => {
    const exe = join('C:\\Program Files\\RotMG Exalt Launcher', LAUNCHER_EXE);
    const f = steamEnv();
    f.env.ROTMG_LAUNCHER = 'missing.exe';
    const regQuery = vi.fn(() => null);
    f.regQuery = regQuery;
    f.exists = path => path === exe;
    expect(findLaunchTarget(f)).toEqual({ kind: 'deca', exe });
    expect(regQuery).toHaveBeenCalledTimes(3);
    regQuery.mockClear();
    f.exists = () => false;
    expect(findLaunchTarget(f)).toEqual({ kind: 'steam', appId: '987654', uri: 'steam://rungameid/987654' });
    expect(regQuery).toHaveBeenCalledTimes(3);
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

describe('default registry discovery', () => {
  afterEach(() => {
    vi.mocked(existsSync).mockReset().mockImplementation(existsSyncOriginal);
    vi.mocked(spawnSync).mockReset();
    vi.unstubAllEnvs();
  });

  const existsSyncOriginal = vi.mocked(existsSync).getMockImplementation()!;

  it.each([
    { name: 'timeout', status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { name: 'error even with status zero', status: 0, error: new Error('query failed') },
    { name: 'nonzero status', status: 1, error: undefined },
    { name: 'success', status: 0, error: undefined },
  ])('bounds registry queries and handles $name', ({ status, error }) => {
    vi.stubEnv('ROTMG_LAUNCHER', '');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0, output: [], stdout: 'InstallLocation REG_SZ D:\\Registry', stderr: '', signal: null, status, error,
    });
    const expectedDir = status === 0 && !error ? 'D:\\Registry' : 'C:\\Program Files\\RotMG Exalt Launcher';
    expect(findLaunchTarget()).toEqual({ kind: 'deca', exe: join(expectedDir, LAUNCHER_EXE) });
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call).toEqual([
        'reg', ['query', expect.any(String), '/s', '/f', 'RotMG Exalt Launcher', '/d'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      ]);
    }
    expect(spawnSync).toHaveBeenCalled();
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
