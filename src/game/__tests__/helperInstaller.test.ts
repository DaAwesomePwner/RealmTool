import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_FILE, HELPER_FILE, installHelper, uninstallHelper } from '../helperInstaller.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-install-'));
  const game = join(root, 'game');
  const helper = join(root, 'helper.dll');
  writeFileSync(helper, 'MZ...RealmTool-Helper/1...v2');
  mkdirSync(game);
  return { game, helper, target: join(game, HELPER_FILE), backup: join(game, BACKUP_FILE) };
}

describe('helper installer', () => {
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
    expect(uninstallHelper(join(s.game, 'missing'))).toBe('not-installed');
  });
});
