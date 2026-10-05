import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import * as installer from '../game/helperInstaller.ts';
import { log, type LogRecord } from '../util/log.ts';

let root: string, game: string, helper: string;
let records: LogRecord[], detach: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realmtool-cli-install-'));
  vi.stubEnv('APPDATA', root);
  game = join(root, 'game'); mkdirSync(game);
  writeFileSync(join(game, 'RotMG Exalt.exe'), 'fixture');
  helper = join(root, 'helper.dll'); writeFileSync(helper, 'RealmTool-Helper/1');
  records = []; log.setConsole(false);
  detach = log.addSink(record => records.push(record));
});
afterEach(() => {
  detach(); log.setConsole(true); vi.restoreAllMocks(); vi.unstubAllEnvs();
  expect(root.startsWith(join(tmpdir(), 'realmtool-cli-install-'))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

it('records the resolved folder in a fresh config before installing', async () => {
  const configPath = join(root, 'RealmTool', 'config.json');
  expect(existsSync(configPath)).toBe(false);
  const save = vi.spyOn(AppConfigStore.prototype, 'addHelperDir');
  const originalInstall = installer.installHelper;
  const install = vi.spyOn(installer, 'installHelper').mockImplementation((dir, path) => {
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({ gameDir: game, helperDirs: [game] });
    return originalInstall(dir, path);
  });
  expect(await main(['install-helper', '--game-dir', relative(process.cwd(), game), '--helper', helper])).toBe(0);
  expect(install).toHaveBeenCalledExactlyOnceWith(game, helper);
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0]);
  expect(readFileSync(join(game, installer.HELPER_FILE), 'utf8')).toBe('RealmTool-Helper/1');
});

it.each(['disabled', 'write error'])('refuses installation when config saving fails: %s', async failure => {
  const configDir = join(root, 'RealmTool'); mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  if (failure === 'disabled') writeFileSync(configPath, JSON.stringify({ schemaVersion: 2 }));
  else vi.spyOn(AppConfigStore.prototype, 'addHelperDir').mockImplementation(() => { throw new Error('write failed'); });
  writeFileSync(join(game, installer.HELPER_FILE), 'foreign original');
  const install = vi.spyOn(installer, 'installHelper');
  expect(await main(['install-helper', '--game-dir', game, '--helper', helper])).toBe(1);
  expect(install).not.toHaveBeenCalled();
  expect(readFileSync(join(game, installer.HELPER_FILE), 'utf8')).toBe('foreign original');
  expect(existsSync(join(game, installer.BACKUP_FILE))).toBe(false);
  expect(records).toContainEqual(expect.objectContaining({
    level: 'error', message: 'Could not save the game folder; the helper was not installed',
  }));
});

it('preserves the selected folder and deduplicates an existing target even at the tracking limit', async () => {
  const other = join(root, 'selected');
  const helperDirs = [game.toUpperCase(), ...Array.from({ length: 15 }, (_, i) => join(root, `previous-${i}`))];
  new AppConfigStore().update({ gameDir: other, helperDirs });
  expect(await main(['install-helper', '--game-dir', game, '--helper', helper])).toBe(0);
  expect(new AppConfigStore().get()).toMatchObject({ gameDir: other, helperDirs });
});
