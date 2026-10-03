import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { STEAM_ROOTS, steamLibraries } from './exaltFinder.ts';

export const LAUNCHER_EXE = 'RotMG Exalt Launcher.exe';
export const STEAM_GAME_NAME = 'Realm of the Mad God Exalt';

export interface LauncherEnv {
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  readText(path: string): string | null;
  listDir(path: string): string[];
  /** stdout of `reg query <key> /s /f "RotMG Exalt Launcher" /d`, or null on failure. */
  regQuery(key: string): string | null;
}

export type LaunchTarget =
  | { kind: 'deca'; exe: string }
  | { kind: 'steam'; appId: string; uri: string };

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

function defaultLauncherEnv(): LauncherEnv {
  return {
    env: process.env,
    exists: existsSync,
    readText: path => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    listDir: path => { try { return readdirSync(path); } catch { return []; } },
    regQuery: key => {
      try {
        const result = spawnSync('reg', ['query', key, '/s', '/f', 'RotMG Exalt Launcher', '/d'],
          { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        return !result.error && result.status === 0 ? result.stdout : null;
      } catch { return null; }
    },
  };
}

export function parseRegInstallLocations(output: string): string[] {
  const locations: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
    if (match?.[1].trim()) locations.push(match[1].trim());
  }
  return locations;
}

export function decaLauncherCandidates(f: LauncherEnv): string[] {
  const candidates: string[] = [];
  if (f.env.ROTMG_LAUNCHER) candidates.push(f.env.ROTMG_LAUNCHER);
  for (const key of UNINSTALL_KEYS) {
    const output = f.regQuery(key);
    if (output) for (const location of parseRegInstallLocations(output)) candidates.push(join(location, LAUNCHER_EXE));
  }
  candidates.push(
    join('C:\\Program Files\\RotMG Exalt Launcher', LAUNCHER_EXE),
    join('C:\\Program Files (x86)\\RotMG Exalt Launcher', LAUNCHER_EXE),
  );
  if (f.env.LOCALAPPDATA) candidates.push(join(f.env.LOCALAPPDATA, 'Programs', 'RotMG Exalt Launcher', LAUNCHER_EXE));
  const seen = new Set<string>();
  return candidates.filter(path => {
    const key = path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findSteamAppId(f: LauncherEnv): string | null {
  const libraries = new Set<string>(STEAM_ROOTS);
  for (const root of STEAM_ROOTS) {
    const vdf = f.readText(join(root, 'steamapps', 'libraryfolders.vdf'));
    if (vdf) for (const library of steamLibraries(vdf)) libraries.add(library);
  }
  for (const library of libraries) {
    const steamapps = join(library, 'steamapps');
    for (const file of f.listDir(steamapps)) {
      if (!/^appmanifest_\d+\.acf$/.test(file)) continue;
      const manifest = f.readText(join(steamapps, file));
      if (!manifest || /"name"\s+"([^"]*)"/.exec(manifest)?.[1] !== STEAM_GAME_NAME) continue;
      const appId = /"appid"\s+"([^"]+)"/.exec(manifest)?.[1];
      if (appId) return appId;
    }
  }
  return null;
}

export function findLaunchTarget(f: LauncherEnv = defaultLauncherEnv(), override?: string): LaunchTarget | null {
  if (override !== undefined) {
    if (!f.exists(override)) throw new Error(`Launcher not found: ${override}`);
    return { kind: 'deca', exe: resolve(override) };
  }
  const envLauncher = f.env.ROTMG_LAUNCHER;
  if (envLauncher && f.exists(envLauncher)) return { kind: 'deca', exe: envLauncher };
  for (const exe of decaLauncherCandidates(f)) {
    if (f.exists(exe)) return { kind: 'deca', exe };
  }
  const appId = findSteamAppId(f);
  return appId ? { kind: 'steam', appId, uri: 'steam://rungameid/' + appId } : null;
}

export function openLaunchTarget(target: LaunchTarget, onError: (error: Error) => void): void {
  try {
    const child = target.kind === 'deca'
      ? spawn(target.exe, [], { cwd: dirname(target.exe), detached: true, stdio: 'ignore' })
      : spawn('explorer.exe', [target.uri], { detached: true, stdio: 'ignore' });
    child.once('error', onError);
    child.unref();
  } catch (error) {
    onError(error as Error);
  }
}

export function describeLaunchTarget(target: LaunchTarget): string {
  return target.kind === 'deca' ? `RotMG Exalt Launcher (${target.exe})` : `Steam (app ${target.appId})`;
}
