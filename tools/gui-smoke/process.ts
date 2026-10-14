import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareProfile(root: string, build: string): string {
  if (!build || /[\r\n]/.test(build)) throw new Error('Invalid catalog gameBuild');
  const gameDir = join(root, 'game');
  for (const dir of ['game/RotMG Exalt_Data', 'roaming/RealmTool', 'local', 'webview', 'home']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(gameDir, 'RotMG Exalt.exe'), 'fixture, never execute');
  writeFileSync(join(gameDir, 'RotMG Exalt_Data/boot.config'), `build-guid=${build}\n`);
  writeFileSync(join(root, 'roaming/RealmTool/config.json'), JSON.stringify({
    schemaVersion: 1, gameDir, launcher: null, activeProfile: 'default',
  }));
  return gameDir;
}

export function launchEnvironment(root: string, port: number, inherited = process.env): NodeJS.ProcessEnv {
  const overrides = {
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), USERPROFILE: join(root, 'home'),
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
  diagnose?(): Promise<void>; stop(): Promise<void>; verify?(): Promise<void>; remove(): Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  try { await work(); } catch (error) { failures.push(error); }
  // Capture even on success: a later isolation/cleanup failure still needs live evidence.
  try { await cleanup.diagnose?.(); } catch (error) { failures.push(error); }
  try { await cleanup.stop(); } catch (error) { failures.push(error); }
  finally {
    try { await cleanup.verify?.(); } catch (error) { failures.push(error); }
    finally { try { await cleanup.remove(); } catch (error) { failures.push(error); } }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map(String).join('\n'));
}
