import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppConfigStore } from '../appConfig.ts';
import { createProfile } from '../profiles.ts';
import { log, type LogRecord } from '../../util/log.ts';

let dir: string;
let records: LogRecord[];
let remove: () => void;
const defaults = { schemaVersion: 1, gameDir: null, helperDirs: [], launcher: null, activeProfile: 'default' };
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

it('loads an older config without helperDirs', () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, gameDir: dir }));
  expect(new AppConfigStore(dir).get()).toEqual({ ...defaults, gameDir: dir });
});

it('resolves and deduplicates helper directories without exposing mutable arrays', () => {
  const store = new AppConfigStore(dir);
  const target = join(dir, 'game');
  const saved = store.update({ helperDirs: [join(target, '..', 'game'), target.toUpperCase()] });
  expect(saved.helperDirs).toEqual([target]);
  saved.helperDirs.push(join(dir, 'other'));
  store.get().helperDirs.length = 0;
  expect(store.get().helperDirs).toEqual([target]);
  expect(new AppConfigStore(dir).get().helperDirs).toEqual([target]);
});

it.each([null, 'game', ['relative'], [42], Array.from({ length: 17 }, (_, i) => join(tmpdir(), `game-${i}`))].map(helperDirs => ({ helperDirs })))(
  'rejects invalid helperDirs $helperDirs on update and backs up invalid saved config', ({ helperDirs }) => {
    const store = new AppConfigStore(dir);
    expect(() => store.update({ helperDirs } as never)).toThrow('helperDirs');
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ schemaVersion: 1, helperDirs }));
    expect(new AppConfigStore(dir).get()).toEqual(defaults);
    expect(readdirSync(dir).some(name => name.startsWith('config.json.corrupt-'))).toBe(true);
  },
);

it('merges a stale settings update onto the latest saved helper targets and settings', () => {
  const a = join(dir, 'a'), b = join(dir, 'b');
  const first = new AppConfigStore(dir); first.update({ helperDirs: [a], gameDir: a });
  const second = new AppConfigStore(dir); second.addHelperDir(b);
  second.update({ gameDir: b });
  expect(first.get().helperDirs).toEqual([a]);
  const saved = first.update({ launcher: 'new launcher' });
  expect(saved).toMatchObject({ helperDirs: [a, b], gameDir: b, launcher: 'new launcher' });
  expect(first.get()).toEqual(saved);
  expect(new AppConfigStore(dir).get()).toEqual(saved);
});

it('removes only the requested target from the latest saved state', () => {
  const a = join(dir, 'a'), b = join(dir, 'b');
  const first = new AppConfigStore(dir); first.update({ helperDirs: [a], gameDir: a });
  const second = new AppConfigStore(dir); second.addHelperDir(b);
  const saved = first.removeHelperDirs([a.toUpperCase()]);
  expect(saved.helperDirs).toEqual([b]);
  expect(first.get()).toEqual(saved);
  expect(new AppConfigStore(dir).get()).toEqual(saved);
});

it('adds to the latest saved set without resurrecting a removed target or changing the selected folder', () => {
  const a = join(dir, 'a'), b = join(dir, 'b'), c = join(dir, 'c');
  const first = new AppConfigStore(dir); first.update({ helperDirs: [a], gameDir: a });
  const second = new AppConfigStore(dir);
  second.addHelperDir(b); second.removeHelperDirs([a]); second.update({ gameDir: b });
  expect(first.addHelperDir(c)).toMatchObject({ helperDirs: [b, c], gameDir: b });
  expect(new AppConfigStore(dir).get().helperDirs).toEqual([b, c]);
});

it('validates helper set operations and allows a duplicate at the 16-target limit', () => {
  const store = new AppConfigStore(dir), target = join(dir, 'game');
  expect(() => store.addHelperDir('relative')).toThrow('helperDirs');
  expect(() => store.removeHelperDirs(['relative'])).toThrow('helperDirs');
  expect(store.addHelperDir(target)).toMatchObject({ gameDir: target, helperDirs: [target] });
  for (let i = 1; i < 16; i++) store.addHelperDir(join(dir, `game-${i}`));
  expect(store.addHelperDir(target.toUpperCase()).helperDirs).toHaveLength(16);
  expect(() => store.addHelperDir(join(dir, 'overflow'))).toThrow('helperDirs');
  expect(new AppConfigStore(dir).get().helperDirs).toHaveLength(16);
});

it.each(['missing', 'corrupt'])('uses cached state when the file becomes %s, preserving corrupt input', kind => {
  const store = new AppConfigStore(dir), target = join(dir, 'game');
  store.update({ helperDirs: [target], gameDir: target });
  const path = join(dir, 'config.json');
  if (kind === 'missing') rmSync(path);
  else writeFileSync(path, '{broken');
  expect(store.update({ launcher: 'launcher' })).toMatchObject({ helperDirs: [target], gameDir: target, launcher: 'launcher' });
  if (kind === 'corrupt') {
    const backup = readdirSync(dir).find(name => name.startsWith('config.json.corrupt-'))!;
    expect(readFileSync(join(dir, backup), 'utf8')).toBe('{broken');
  }
});

it('refuses to overwrite a new unknown schema and retains the last cached state', () => {
  const store = new AppConfigStore(dir);
  const cached = store.update({ launcher: 'cached' });
  const text = JSON.stringify({ schemaVersion: 2, future: true });
  writeFileSync(join(dir, 'config.json'), text);
  expect(() => store.update({ launcher: 'replacement' })).toThrow('saving is disabled');
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(text);
  expect(store.get()).toEqual(cached);
});

it('disables later writes when the latest config cannot be read', () => {
  const store = new AppConfigStore(dir), path = join(dir, 'config.json');
  const cached = store.update({ launcher: 'cached' });
  rmSync(path); mkdirSync(path);
  expect(() => store.update({ launcher: 'replacement' })).toThrow('saving is disabled');
  expect(store.get()).toEqual(cached);
  rmdirSync(path); writeFileSync(path, JSON.stringify(cached));
  expect(() => store.update({ launcher: 'replacement' })).toThrow('saving is disabled');
});
