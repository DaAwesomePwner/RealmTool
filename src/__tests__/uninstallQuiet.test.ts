import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../cli.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { BACKUP_FILE } from '../game/helperInstaller.ts';
import * as installer from '../game/helperInstaller.ts';
import * as finder from '../game/exaltFinder.ts';
import { log } from '../util/log.ts';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

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
  new AppConfigStore().update({ helperDirs: [game, other] });
  vi.stubEnv('ROTMG_PATH', other);
  expect(await main(['uninstall-helper'])).toBe(0);
  expect(existsSync(join(other, 'winhttp.dll'))).toBe(false);
  expect(readFileSync(join(game, 'winhttp.dll'), 'utf8')).toBe('RealmTool-Helper/1');
  expect(new AppConfigStore().get().helperDirs).toEqual([game]);
});

it('quiet uninstall restores every recorded folder once and empties the list silently', async () => {
  const other = join(root, 'other'); mkdirSync(other);
  for (const dir of [game, other]) {
    writeFileSync(join(dir, 'winhttp.dll'), 'RealmTool-Helper/1');
    writeFileSync(join(dir, BACKUP_FILE), `original ${dir}`);
  }
  new AppConfigStore().update({ gameDir: other.toUpperCase(), helperDirs: [game, other] });
  const uninstall = vi.spyOn(installer, 'uninstallHelper');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log.setConsole(true);
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(uninstall.mock.calls.map(args => args[0])).toEqual([game, other]);
  for (const dir of [game, other]) expect(readFileSync(join(dir, 'winhttp.dll'), 'utf8')).toBe(`original ${dir}`);
  expect(new AppConfigStore().get().helperDirs).toEqual([]);
  expect(output).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled(); expect(warnings).not.toHaveBeenCalled();
});

it('quiet uninstall skips missing directories and paths that are now files', async () => {
  const missing = join(root, 'missing'), file = join(root, 'file');
  writeFileSync(file, 'fixture');
  new AppConfigStore().update({ helperDirs: [missing, file, game] });
  const uninstall = vi.spyOn(installer, 'uninstallHelper');
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(uninstall.mock.calls.map(args => args[0])).toEqual([game]);
  expect(new AppConfigStore().get().helperDirs).toEqual([]);
});

it('quiet uninstall continues after a failure, returns one and retains the failed target', async () => {
  const other = join(root, 'other'); mkdirSync(other);
  new AppConfigStore().update({ helperDirs: [game, other] });
  const uninstall = vi.spyOn(installer, 'uninstallHelper').mockImplementation(dir => {
    if (dir === game) throw new Error('locked');
    return 'not-installed';
  });
  expect(await main(['uninstall-helper', '--quiet'])).toBe(1);
  expect(uninstall.mock.calls.map(args => args[0])).toEqual([game, other]);
  expect(new AppConfigStore().get().helperDirs).toEqual([game]);
});

it('quiet uninstall preserves a target recorded while another target is being removed', async () => {
  const other = join(root, 'other');
  new AppConfigStore().update({ helperDirs: [game] });
  const uninstall = vi.spyOn(installer, 'uninstallHelper').mockImplementation(() => {
    new AppConfigStore().addHelperDir(other);
    return 'removed';
  });
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(uninstall).toHaveBeenCalledExactlyOnceWith(game);
  expect(new AppConfigStore().get().helperDirs).toEqual([other]);
});

it('quiet uninstall with no saved targets never discovers or touches another folder', async () => {
  rmSync(join(root, 'RealmTool', 'config.json'));
  vi.stubEnv('ROTMG_PATH', game);
  const discover = vi.spyOn(finder, 'findExaltDirs');
  const uninstall = vi.spyOn(installer, 'uninstallHelper');
  expect(await main(['uninstall-helper', '--quiet', '--game-dir', game])).toBe(0);
  expect(discover).not.toHaveBeenCalled(); expect(uninstall).not.toHaveBeenCalled();
});

it('quiet uninstall succeeds even when saving the processed list fails', async () => {
  new AppConfigStore().update({ helperDirs: [game] });
  writeFileSync(join(game, 'winhttp.dll'), 'RealmTool-Helper/1');
  vi.spyOn(AppConfigStore.prototype, 'removeHelperDirs').mockImplementation(() => { throw new Error('read-only'); });
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(existsSync(join(game, 'winhttp.dll'))).toBe(false);
});

it('quiet uninstall keeps a target whose directory cannot be inspected', async () => {
  new AppConfigStore().update({ helperDirs: [game] });
  vi.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  const uninstall = vi.spyOn(installer, 'uninstallHelper');
  expect(await main(['uninstall-helper', '--quiet'])).toBe(0);
  expect(uninstall).not.toHaveBeenCalled();
  expect(new AppConfigStore().get().helperDirs).toEqual([game]);
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
