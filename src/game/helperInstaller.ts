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

export interface InstallerOps {
  copyFile(src: string, dest: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  exists(path: string): boolean;
}

const defaultOps: InstallerOps = {
  copyFile: copyFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  exists: existsSync,
};

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

export function isRealmToolHelper(path: string): boolean {
  try { return readFileSync(path).includes(HELPER_MARKER, 0, 'latin1'); } catch { return false; }
}

export function installHelper(gameDir: string, helperPath: string, ops: InstallerOps = defaultOps): InstallResult {
  if (!ops.exists(helperPath)) throw new Error(`Helper DLL not found at ${helperPath}. Run "npm run build:helper" first.`);
  if (!isRealmToolHelper(helperPath)) throw new Error(`${helperPath} is not a RealmTool helper build (marker missing).`);
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  let status: InstallStatus = 'installed';
  let backedUp = false;
  if (ops.exists(target)) {
    if (sha256(target) === sha256(helperPath)) return { status: 'unchanged', backedUp: false, target };
    if (isRealmToolHelper(target)) {
      status = 'updated';
    } else {
      if (ops.exists(backup)) {
        throw new Error(`${target} is not RealmTool's and ${BACKUP_FILE} already exists. Move one of them aside and retry.`);
      }
      try { ops.rename(target, backup); } catch (error) {
        throw new Error(`Could not back up ${target} (is the game running?): ${(error as Error).message}`);
      }
      backedUp = true;
    }
  }
  const staging = target + '.realmtool-new';
  try {
    ops.copyFile(helperPath, staging);
    ops.rename(staging, target);
  } catch (error) {
    try { ops.unlink(staging); } catch { /* Best-effort staging cleanup. */ }
    let recovery = '';
    if (backedUp) {
      try { ops.rename(backup, target); } catch (restoreError) {
        recovery = ` Could not restore the backup at ${backup}: ${(restoreError as Error).message}. Restore it to ${target} manually.`;
      }
    }
    throw new Error(`Could not write ${target} (is the game running?): ${(error as Error).message}${recovery}`);
  }
  return { status, backedUp, target };
}

export function uninstallHelper(gameDir: string, ops: InstallerOps = defaultOps): UninstallStatus {
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  const targetExists = ops.exists(target);
  if (targetExists) {
    if (!isRealmToolHelper(target)) return 'foreign';
    ops.unlink(target);
  }
  if (ops.exists(backup)) {
    try { ops.rename(backup, target); } catch (error) {
      throw new Error(`Could not restore the backup at ${backup} (is the game running?): ${(error as Error).message}. Restore it to ${target} manually.`);
    }
    return 'restored';
  }
  return targetExists ? 'removed' : 'not-installed';
}
