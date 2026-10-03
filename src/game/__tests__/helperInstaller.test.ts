import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_FILE, HELPER_FILE, LOCK_FILE, installHelper, uninstallHelper, type InstallerOps } from '../helperInstaller.ts';

function failingOps(operation: 'copyFile' | 'rename', failOnCall: number): InstallerOps {
  let calls = 0;
  const failIfChosen = (current: typeof operation) => {
    if (current === operation && ++calls === failOnCall) throw new Error(`Injected ${operation} failure`);
  };
  return {
    copyFile(src, dest) { failIfChosen('copyFile'); copyFileSync(src, dest); },
    rename(from, to) { failIfChosen('rename'); renameSync(from, to); },
    unlink: unlinkSync,
    exists: existsSync,
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-install-'));
  const game = join(root, 'game');
  const helper = join(root, 'helper.dll');
  writeFileSync(helper, 'MZ...RealmTool-Helper/1...v2');
  mkdirSync(game);
  return { game, helper, target: join(game, HELPER_FILE), backup: join(game, BACKUP_FILE) };
}

describe('helper installer', () => {
  it('refuses a fresh held lock before checking or changing helper files', () => {
    const s = setup();
    const lock = join(s.game, LOCK_FILE);
    writeFileSync(lock, '12345');
    const message = `Another RealmTool process is installing or uninstalling the helper in ${s.game}; try again`;
    const options = { timeoutMs: 10, retryMs: 1 };
    expect(() => installHelper(s.game, 'missing-helper.dll', undefined, options)).toThrow(message);
    expect(() => uninstallHelper(s.game, undefined, options)).toThrow(message);
    expect(readFileSync(lock, 'utf8')).toBe('12345');
    expect(existsSync(s.target)).toBe(false);
  });

  it('clears a stale lock and releases its own lock after installation', () => {
    const s = setup();
    const lock = join(s.game, LOCK_FILE);
    writeFileSync(lock, '12345');
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    expect(installHelper(s.game, s.helper).status).toBe('installed');
    expect(existsSync(lock)).toBe(false);
    expect(uninstallHelper(s.game)).toBe('removed');
    expect(existsSync(lock)).toBe(false);
  });

  it('writes its PID and releases the lock after a thrown install or uninstall failure', () => {
    const s = setup();
    const lock = join(s.game, LOCK_FILE);
    const ops = failingOps('copyFile', 1);
    ops.exists = path => {
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      return existsSync(path);
    };
    expect(() => installHelper(s.game, s.helper, ops)).toThrow('Injected copyFile failure');
    expect(existsSync(lock)).toBe(false);
    installHelper(s.game, s.helper);
    ops.unlink = () => { throw new Error('Injected unlink failure'); };
    expect(() => uninstallHelper(s.game, ops)).toThrow('Injected unlink failure');
    expect(existsSync(lock)).toBe(false);
  });

  it.each([['copyFile', 1], ['rename', 2]] as const)('restores a foreign DLL when %s fails', (operation, call) => {
    const s = setup();
    writeFileSync(s.target, 'MZ realm engine redirector');
    expect(() => installHelper(s.game, s.helper, failingOps(operation, call))).toThrow('(is the game running?)');
    expect(readFileSync(s.target, 'utf8')).toBe('MZ realm engine redirector');
    expect(existsSync(s.backup)).toBe(false);
    expect(existsSync(s.target + '.realmtool-new')).toBe(false);
  });

  it('preserves an older RealmTool helper when copying its update fails', () => {
    const s = setup();
    writeFileSync(s.target, 'MZ...RealmTool-Helper/1...v1');
    expect(() => installHelper(s.game, s.helper, failingOps('copyFile', 1))).toThrow('(is the game running?)');
    expect(readFileSync(s.target, 'utf8')).toBe('MZ...RealmTool-Helper/1...v1');
    expect(existsSync(s.backup)).toBe(false);
    expect(existsSync(s.target + '.realmtool-new')).toBe(false);
  });

  it('restores a backup on uninstall when the target is missing', () => {
    const s = setup();
    writeFileSync(s.backup, 'MZ realm engine redirector');
    expect(uninstallHelper(s.game)).toBe('restored');
    expect(readFileSync(s.target, 'utf8')).toBe('MZ realm engine redirector');
    expect(existsSync(s.backup)).toBe(false);
  });

  it('installs into an empty game folder and is idempotent', () => {
    const s = setup();
    expect(installHelper(s.game, s.helper)).toEqual({ status: 'installed', backedUp: false, target: s.target });
    expect(installHelper(s.game, s.helper).status).toBe('unchanged');
  });

  it('backs up a foreign winhttp.dll and restores it on uninstall', () => {
    const s = setup();
    writeFileSync(s.target, 'MZ realm engine redirector');
    expect(installHelper(s.game, s.helper)).toMatchObject({ status: 'installed', backedUp: true });
    expect(readFileSync(s.backup, 'utf8')).toBe('MZ realm engine redirector');
    expect(uninstallHelper(s.game)).toBe('restored');
    expect(readFileSync(s.target, 'utf8')).toBe('MZ realm engine redirector');
    expect(existsSync(s.backup)).toBe(false);
  });

  it('upgrades an older RealmTool helper in place without a backup', () => {
    const s = setup();
    writeFileSync(s.target, 'MZ...RealmTool-Helper/1...v1');
    expect(installHelper(s.game, s.helper)).toMatchObject({ status: 'updated', backedUp: false });
    expect(existsSync(s.backup)).toBe(false);
  });

  it('refuses to clobber an existing backup', () => {
    const s = setup();
    writeFileSync(s.target, 'foreign');
    writeFileSync(s.backup, 'older foreign');
    expect(() => installHelper(s.game, s.helper)).toThrow(BACKUP_FILE);
  });

  it('refuses a helper build without the marker', () => {
    const s = setup();
    writeFileSync(s.helper, 'MZ something else');
    expect(() => installHelper(s.game, s.helper)).toThrow('marker');
  });

  it('never deletes a foreign DLL on uninstall', () => {
    const s = setup();
    writeFileSync(s.target, 'foreign');
    expect(uninstallHelper(s.game)).toBe('foreign');
    expect(readFileSync(s.target, 'utf8')).toBe('foreign');
    const empty = join(s.game, 'empty');
    mkdirSync(empty);
    expect(uninstallHelper(empty)).toBe('not-installed');
  });
});
