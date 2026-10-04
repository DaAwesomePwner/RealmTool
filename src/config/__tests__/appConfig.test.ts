import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppConfigStore } from '../appConfig.ts';
import { createProfile } from '../profiles.ts';
import { log, type LogRecord } from '../../util/log.ts';

let dir: string;
let records: LogRecord[];
let remove: () => void;
const defaults = { schemaVersion: 1, gameDir: null, launcher: null, activeProfile: 'default' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'realmtool-app-config-'));
  records = [];
  log.setConsole(false);
  remove = log.addSink(record => records.push(record));
});
afterEach(() => { remove(); log.setConsole(true); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it('uses defaults without creating a file, and resolves the default directory', () => {
  expect(new AppConfigStore(dir).get()).toEqual(defaults);
  expect(readdirSync(dir)).toEqual([]);
  vi.stubEnv('APPDATA', dir);
  new AppConfigStore().update({ gameDir: 'game' });
  expect(new AppConfigStore(join(dir, 'RealmTool')).get().gameDir).toBe('game');
});

it('atomically saves partial updates across reloads without exposing mutable state', () => {
  createProfile('My Profile_1', undefined, dir);
  const store = new AppConfigStore(dir);
  const saved = store.update({ gameDir: 'game', launcher: 'launcher', activeProfile: 'My Profile_1' });
  expect(new AppConfigStore(dir).get()).toEqual(saved);
  expect(readdirSync(dir).sort()).toEqual(['config.json', 'profiles']);
  saved.gameDir = 'changed';
  store.get().launcher = 'changed';
  expect(store.update({ launcher: null }).gameDir).toBe('game');
});

it.each(['{ broken', '[]', '{"schemaVersion":1,"gameDir":42}'])('backs up corrupt config with one warning: %s', text => {
  writeFileSync(join(dir, 'config.json'), text);
  const store = new AppConfigStore(dir);
  expect(store.get()).toEqual(defaults);
  const backup = readdirSync(dir).find(name => name.startsWith('config.json.corrupt-'))!;
  expect(readFileSync(join(dir, backup), 'utf8')).toBe(text);
  expect(records).toHaveLength(1);
  expect(records[0]?.level).toBe('warn');
  store.update({ launcher: 'launcher' });
  expect(new AppConfigStore(dir).get().launcher).toBe('launcher');
});

it.each([2, 0, 'future'])('leaves unknown schema %j untouched throughout the session', schemaVersion => {
  const text = JSON.stringify({ schemaVersion, future: true });
  writeFileSync(join(dir, 'config.json'), text);
  const store = new AppConfigStore(dir);
  expect(store.get()).toEqual(defaults);
  try { store.update({ gameDir: 'game' }); } catch { /* disabled saving may reject updates */ }
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(text);
  expect(readdirSync(dir)).toEqual(['config.json']);
  expect(records).toHaveLength(1);
});

it('falls back from a missing active profile with one warning', () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, activeProfile: 'missing' }));
  expect(new AppConfigStore(dir).get()).toEqual(defaults);
  expect(records).toHaveLength(1);
  expect(records[0]?.message).toContain('missing');
});

it('does not replace in-memory state when persistence fails', () => {
  const store = new AppConfigStore(dir);
  mkdirSync(join(dir, 'config.json'));
  expect(() => store.update({ launcher: 'launcher' })).toThrow();
  expect(store.get()).toEqual(defaults);
});

it('rejects invalid updates before writing', () => {
  const store = new AppConfigStore(dir);
  expect(() => store.update({ activeProfile: '../escape' })).toThrow();
  expect(() => store.update({ gameDir: 42 } as never)).toThrow();
  expect(readdirSync(dir)).toEqual([]);
});
