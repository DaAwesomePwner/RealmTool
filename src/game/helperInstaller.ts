import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HELPER_FILE = 'winhttp.dll';
export const BACKUP_FILE = 'winhttp.dll.realmtool-backup';
/** Embedded in every helper build (native/helper/src/dllmain.cpp) so we never mistake a foreign DLL for ours. */
export const HELPER_MARKER = 'RealmTool-Helper/';
export const DEFAULT_HELPER_PATH = fileURLToPath(new URL('../../native/helper/bin/winhttp.dll', import.meta.url));

export type InstallStatus = 'installed' | 'updated' | 'unchanged';
export interface InstallResult {
  status: InstallStatus;
  backedUp: boolean;
  target: string;
}
export type UninstallStatus = 'removed' | 'restored' | 'not-installed' | 'foreign';

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export function isRealmToolHelper(path: string): boolean {
  try { return readFileSync(path).includes(HELPER_MARKER, 0, 'latin1'); } catch { return false; }
}

export function installHelper(gameDir: string, helperPath: string): InstallResult {
  if (!existsSync(helperPath)) throw new Error(`Helper DLL not found at ${helperPath}. Run "npm run build:helper" first.`);
  if (!isRealmToolHelper(helperPath)) throw new Error(`${helperPath} is not a RealmTool helper build (marker missing).`);
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  let status: InstallStatus = 'installed';
  let backedUp = false;
  if (existsSync(target)) {
    if (sha256(target) === sha256(helperPath)) return { status: 'unchanged', backedUp: false, target };
    if (isRealmToolHelper(target)) {
      status = 'updated';
    } else {
      if (existsSync(backup)) {
        throw new Error(`${target} is not RealmTool's and ${BACKUP_FILE} already exists. Move one of them aside and retry.`);
      }
      try { renameSync(target, backup); } catch (error) {
        throw new Error(`Could not back up ${target} (is the game running?): ${(error as Error).message}`);
      }
      backedUp = true;
    }
  }
  try { copyFileSync(helperPath, target); } catch (error) {
    throw new Error(`Could not write ${target} (is the game running?): ${(error as Error).message}`);
  }
  return { status, backedUp, target };
}

export function uninstallHelper(gameDir: string): UninstallStatus {
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  if (!existsSync(target)) return 'not-installed';
  if (!isRealmToolHelper(target)) return 'foreign';
  unlinkSync(target);
  if (existsSync(backup)) {
    renameSync(backup, target);
    return 'restored';
  }
  return 'removed';
}
