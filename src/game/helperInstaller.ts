import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourcePaths } from '../app/resources.ts';

export const HELPER_FILE = 'winhttp.dll';
export const BACKUP_FILE = 'winhttp.dll.realmtool-backup';
export const LOCK_FILE = 'winhttp.dll.realmtool-lock';
/** Embedded in every helper build (native/helper/src/dllmain.cpp) so we never mistake a foreign DLL for ours. */
export const HELPER_MARKER = 'RealmTool-Helper/';
export const DEFAULT_HELPER_PATH = resourcePaths().helperDll;

export type InstallStatus = 'installed' | 'updated' | 'unchanged';
export interface InstallResult {
  status: InstallStatus;
  backedUp: boolean;
  target: string;
}
export type UninstallStatus = 'removed' | 'restored' | 'not-installed' | 'foreign';

export type HelperState = 'absent' | 'installed' | 'outdated' | 'foreign';
export function inspectHelper(gameDir: string, helperPath: string): { state: HelperState; backup: boolean } {
  return inspectWithHash(gameDir, helperPath, sha256);
}

/** Cache the immutable bundled helper for one controller lifetime. */
export function createHelperInspector(): typeof inspectHelper {
  let bundled: { path: string; hash: string } | undefined;
  return (gameDir, helperPath) => inspectWithHash(gameDir, helperPath, path => {
    if (bundled?.path !== path) bundled = { path, hash: sha256(path) };
    return bundled.hash;
  });
}

function inspectWithHash(gameDir: string, helperPath: string, bundledHash: (path: string) => string): { state: HelperState; backup: boolean } {
  const target = join(gameDir, HELPER_FILE);
  const backup = existsSync(join(gameDir, BACKUP_FILE));
  if (!existsSync(target)) return { state: 'absent', backup };
  const bytes = readFileSync(target);
  if (!bytes.includes(HELPER_MARKER, 0, 'latin1')) return { state: 'foreign', backup };
  return { state: hash(bytes) === bundledHash(helperPath) ? 'installed' : 'outdated', backup };
}

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

const IN_USE_MESSAGE = 'winhttp.dll is in use. Close RotMG Exalt (and its launcher) and try again.';

function inUse(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export interface InstallerLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
}

function withInstallerLock<T>(gameDir: string, options: InstallerLockOptions, action: () => T): T {
  const path = join(gameDir, LOCK_FILE);
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let fd: number;
  for (;;) {
    try {
      fd = openSync(path, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > (options.staleMs ?? 30_000)) {
          unlinkSync(path);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Another RealmTool process is installing or uninstalling the helper in ${gameDir}; try again`);
      }
      Atomics.wait(wait, 0, 0, Math.min(options.retryMs ?? 100, remaining));
    }
  }
  try {
    writeFileSync(fd, String(process.pid));
    return action();
  } finally {
    try { closeSync(fd); } finally {
      try { unlinkSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha256 = (path: string): string => hash(readFileSync(path));

export function isRealmToolHelper(path: string): boolean {
  try { return readFileSync(path).includes(HELPER_MARKER, 0, 'latin1'); } catch { return false; }
}

export function installHelper(gameDir: string, helperPath: string, ops: InstallerOps = defaultOps,
  options: InstallerLockOptions = {}): InstallResult {
  return withInstallerLock(gameDir, options, () => installLocked(gameDir, helperPath, ops));
}

function installLocked(gameDir: string, helperPath: string, ops: InstallerOps): InstallResult {
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
        if (inUse(error)) throw new Error(IN_USE_MESSAGE);
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
    const message = inUse(error)
      ? IN_USE_MESSAGE
      : `Could not write ${target} (is the game running?): ${(error as Error).message}`;
    throw new Error(message + recovery);
  }
  return { status, backedUp, target };
}

export function uninstallHelper(gameDir: string, ops: InstallerOps = defaultOps,
  options: InstallerLockOptions = {}): UninstallStatus {
  return withInstallerLock(gameDir, options, () => uninstallLocked(gameDir, ops));
}

function uninstallLocked(gameDir: string, ops: InstallerOps): UninstallStatus {
  const target = join(gameDir, HELPER_FILE);
  const backup = join(gameDir, BACKUP_FILE);
  const targetExists = ops.exists(target);
  if (targetExists) {
    if (!isRealmToolHelper(target)) return 'foreign';
    try { ops.unlink(target); } catch (error) {
      if (inUse(error)) throw new Error(IN_USE_MESSAGE);
      throw error;
    }
  }
  if (ops.exists(backup)) {
    try { ops.rename(backup, target); } catch (error) {
      throw new Error(`Could not restore the backup at ${backup} (is the game running?): ${(error as Error).message}. Restore it to ${target} manually.`);
    }
    return 'restored';
  }
  return targetExists ? 'removed' : 'not-installed';
}
