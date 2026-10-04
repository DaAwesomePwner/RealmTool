import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { BACKUP_FILE } from '../game/helperInstaller.ts';
import { log } from '../util/log.ts';

let root: string;
let game: string;
let detach: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realmtool-uninstall-'));
  vi.stubEnv('APPDATA', root);
  game = join(root, 'game');
  mkdirSync(game);
  writeFileSync(join(game, 'RotMG Exalt.exe'), 'fixture');
  log.setConsole(false);
  detach = log.addSink(() => {});
  new AppConfigStore().update({ gameDir: game });
});
afterEach(() => {
  detach(); log.setConsole(true); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('non-quiet uninstall uses ROTMG_PATH rather than the saved gameDir', async () => {
  const other = join(root, 'other-game');
  mkdirSync(other);
  writeFileSync(join(other, 'RotMG Exalt.exe'), 'fixture');
  writeFileSync(join(other, 'winhttp.dll'), 'RealmTool-Helper/1');
  writeFileSync(join(game, 'winhttp.dll'), 'RealmTool-Helper/1');
  vi.stubEnv('ROTMG_PATH', other);
  expect(await main(['uninstall-helper'])).toBe(0);
  expect(existsSync(join(other, 'winhttp.dll'))).toBe(false);
  expect(readFileSync(join(game, 'winhttp.dll'), 'utf8')).toBe('RealmTool-Helper/1');
});
it('quiet uninstall reads config gameDir, restores the backup and is silent and idempotent', async () => {
  writeFileSync(join(game, 'winhttp.dll'), 'RealmTool-Helper/1');
  writeFileSync(join(game, BACKUP_FILE), 'foreign original');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log.setConsole(true);
  const info = vi.spyOn(log, 'info');
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(readFileSync(join(game, 'winhttp.dll'), 'utf8')).toBe('foreign original');
  expect(existsSync(join(game, BACKUP_FILE))).toBe(false);
  rmSync(join(game, 'winhttp.dll'));
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  expect(warnings).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});
