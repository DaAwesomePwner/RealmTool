import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROAMING = 'home/AppData/Roaming';
export const LOCAL = 'home/AppData/Local';

export function prepareProfile(root: string, build: string): string {
  if (!build || /[\r\n]/.test(build)) throw new Error('Invalid catalog gameBuild');
  const gameDir = join(root, 'game');
  // Tauri resolves known folders from %USERPROFILE%, so the fake home must contain them.
  for (const dir of ['game/RotMG Exalt_Data', `${ROAMING}/RealmTool`, LOCAL, 'webview']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(gameDir, 'RotMG Exalt.exe'), 'fixture, never execute');
  writeFileSync(join(gameDir, 'RotMG Exalt_Data/boot.config'), `build-guid=${build}\n`);
  writeFileSync(join(root, ROAMING, 'RealmTool/config.json'), JSON.stringify({
    schemaVersion: 1, gameDir, launcher: null, activeProfile: 'default',
  }));
  return gameDir;
}

export function launchEnvironment(root: string, port: number, inherited = process.env): NodeJS.ProcessEnv {
  const overrides = {
    APPDATA: join(root, ROAMING), LOCALAPPDATA: join(root, LOCAL), USERPROFILE: join(root, 'home'),
    HOME: join(root, 'home'), ROTMG_PATH: join(root, 'game'),
    TEMP: root, TMP: root, TMPDIR: root,
    WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  };
  const removed = new Set([...Object.keys(overrides), 'NODE_OPTIONS', 'NODE_PATH', 'ROTMG_LAUNCHER',
    'WEBVIEW2_BROWSER_EXECUTABLE_FOLDER', 'REALMTOOL_RESOURCES', 'REALMTOOL_API_TOKEN', 'REALMTOOL_UI_ORIGINS']);
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !removed.has(key.toUpperCase()))), ...overrides };
}

/** Lifecycle boundary is injectable so failures exercise cleanup on non-Windows hosts. */
export async function withApp(work: () => Promise<void>, cleanup: {
  diagnose?(failed: boolean): Promise<void>; stop(): Promise<void>; verify?(): Promise<void>; remove(): Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  try { await work(); } catch (error) { failures.push(error); }
  // Diagnostics are best-effort and must never change the smoke result.
  try { await cleanup.diagnose?.(failures.length > 0); } catch (error) { console.warn(`GUI diagnostics failed: ${error}`); }
  try { await cleanup.stop(); } catch (error) { failures.push(error); }
  finally {
    try { await cleanup.verify?.(); } catch (error) { failures.push(error); }
    finally { try { await cleanup.remove(); } catch (error) { failures.push(error); } }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map(String).join('\n'));
}
