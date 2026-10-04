import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDataDir, emptyProfile, normalizeProfile, ProfileStore, writeJsonAtomic, type ProfileFs } from '../store.ts';
import { log, type LogRecord } from '../../util/log.ts';

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'realmtool-config-')); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('config store', () => {
  it('resolves the app data folder from APPDATA', () => {
    expect(appDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'RealmTool'));
  });

  it('writes JSON atomically and leaves no temp file', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'a.json');
    writeJsonAtomic(path, { a: 1 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(join(dir, 'nested'))).toEqual(['a.json']);
  });

  it('loads a missing profile as empty', () => {
    const store = new ProfileStore({ dir: tempDir() });
    expect(store.load()).toEqual(emptyProfile());
    expect(store.savingDisabled).toBe(false);
  });

  it('leaves a newer-schema profile untouched and disables saving', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    const bytes = Buffer.from('\uFEFF' + JSON.stringify({ schemaVersion: 2, plugins: { a: { enabled: true } }, future: { x: 1 } }) + '\n');
    writeFileSync(store.path, bytes);
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      store.scheduleSave(emptyProfile());
      expect(store.load()).toEqual(emptyProfile());
      expect(store.savingDisabled).toBe(true);
      expect(readFileSync(store.path)).toEqual(bytes);
      expect(readdirSync(join(dir, 'profiles'))).toEqual(['default.json']);
      store.scheduleSave(emptyProfile());
      store.flush();
      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(readFileSync(store.path)).toEqual(bytes);
      expect(readdirSync(join(dir, 'profiles'))).toEqual(['default.json']);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: 'warn',
        message: `Profile ${store.path} was written by a newer RealmTool (schema 2); using defaults and not saving settings this session so the file is left untouched`,
      });
    } finally { remove(); log.setConsole(true); }
  });

  it('loads plugin entries when schemaVersion is omitted', () => {
    const store = new ProfileStore({ dir: tempDir() });
    const plugins = { a: { enabled: true, settings: { x: 1 } } };
    writeJsonAtomic(store.path, { plugins });
    expect(store.load()).toEqual({ schemaVersion: 1, plugins });
    expect(store.savingDisabled).toBe(false);
  });

  it.each(['1', 0, -1, 1.5, 2.5, null, true, {}, []])('backs up a profile with invalid schemaVersion %j', schemaVersion => {
    vi.useFakeTimers();
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    const text = JSON.stringify({ schemaVersion, plugins: { a: { enabled: true } } });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(store.path, text);
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      expect(store.load()).toEqual(emptyProfile());
      expect(store.savingDisabled).toBe(false);
      expect(existsSync(store.path)).toBe(false);
      const backup = `${store.path}.corrupt-${Date.now()}`;
      expect(readFileSync(backup, 'utf8')).toBe(text);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('is unreadable') });
    } finally { remove(); log.setConsole(true); }
  });

  it('disables saving for a locked profile without modifying the file', () => {
    vi.useFakeTimers();
    const fs: ProfileFs = {
      readFile: vi.fn(() => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }),
      rename: vi.fn(),
      writeJson: vi.fn(),
    };
    const store = new ProfileStore({ dir: tempDir(), fs });
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      store.scheduleSave(emptyProfile());
      expect(store.load()).toEqual(emptyProfile());
      expect(store.savingDisabled).toBe(true);
      store.scheduleSave(emptyProfile());
      store.flush();
      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(fs.readFile).toHaveBeenCalledWith(store.path);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.writeJson).not.toHaveBeenCalled();
      expect(records.some(r => r.level === 'warn' && r.message === `Could not read ${store.path} (EBUSY); using defaults and not saving settings this session so the file is left untouched`)).toBe(true);
    } finally { remove(); log.setConsole(true); }
  });

  it.each(['{ not json', '{"plugins":"invalid"}'])('disables saving when an unreadable profile cannot be backed up: %s', text => {
    vi.useFakeTimers();
    const fs: ProfileFs = {
      readFile: vi.fn(() => text),
      rename: vi.fn(() => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }),
      writeJson: vi.fn(),
    };
    const store = new ProfileStore({ dir: tempDir(), fs });
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      expect(store.load()).toEqual(emptyProfile());
      expect(store.savingDisabled).toBe(true);
      expect(fs.rename).toHaveBeenCalledWith(store.path, `${store.path}.corrupt-${Date.now()}`);
      store.scheduleSave(emptyProfile());
      store.flush();
      vi.runAllTimers();
      expect(fs.writeJson).not.toHaveBeenCalled();
      expect(records.some(r => r.level === 'warn' && r.message.includes('could not be backed up'))).toBe(true);
      expect(records.some(r => r.message.includes('kept it as'))).toBe(false);
    } finally { remove(); log.setConsole(true); }
  });

  it.each([false, true])('retains a failed save for retry (schedule a newer profile: %s)', scheduleNewer => {
    vi.useFakeTimers();
    const writeJson = vi.fn().mockImplementationOnce(() => { throw new Error('locked'); });
    const fs: ProfileFs = { readFile: vi.fn(), rename: vi.fn(), writeJson };
    const store = new ProfileStore({ dir: tempDir(), fs });
    const profile = { schemaVersion: 1, plugins: { a: { enabled: true } } };
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      store.scheduleSave(profile);
      store.flush();
      expect(records.some(r => r.level === 'error' && r.message.startsWith(`Could not save ${store.path}:`))).toBe(true);
      expect(writeJson).toHaveBeenNthCalledWith(1, store.path, profile);
      expect(vi.getTimerCount()).toBe(0);
      vi.runAllTimers();
      expect(writeJson).toHaveBeenCalledTimes(1);
      const latest = scheduleNewer ? emptyProfile() : profile;
      if (scheduleNewer) {
        store.scheduleSave(latest);
        vi.advanceTimersByTime(800);
      } else {
        store.flush();
      }
      expect(writeJson).toHaveBeenNthCalledWith(2, store.path, latest);
      store.flush();
      expect(writeJson).toHaveBeenCalledTimes(2);
    } finally { remove(); log.setConsole(true); }
  });

  it('keeps a corrupt profile aside and starts from defaults', () => {
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(store.path, '{ not json');
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      expect(store.load()).toEqual(emptyProfile());
      expect(store.savingDisabled).toBe(false);
    } finally { remove(); log.setConsole(true); }
    expect(existsSync(store.path)).toBe(false);
    expect(readdirSync(join(dir, 'profiles')).some(n => n.startsWith('default.json.corrupt-'))).toBe(true);
    expect(records.some(r => r.level === 'warn')).toBe(true);
  });

  it('drops malformed entries but keeps valid ones, tolerating a BOM', () => {
    const dir = tempDir();
    const store = new ProfileStore({ dir });
    mkdirSync(join(dir, 'profiles'), { recursive: true });
    writeFileSync(store.path, '\uFEFF' + JSON.stringify({ schemaVersion: 1, plugins: {
      good: { enabled: false, settings: { x: 1 } }, bad: 5, partial: { enabled: 'yes', settings: [] },
    } }));
    const records: LogRecord[] = [];
    log.setConsole(false);
    const remove = log.addSink(r => records.push(r));
    try {
      expect(store.load().plugins).toEqual({ good: { enabled: false, settings: { x: 1 } }, partial: {} });
    } finally { remove(); log.setConsole(true); }
    expect(records.some(r => r.level === 'warn')).toBe(true);
  });

  it('rejects a non-object profile', () => {
    expect(() => normalizeProfile([])).toThrow();
    expect(() => normalizeProfile({ plugins: 'x' })).toThrow();
  });

  it('debounces saves and flushes the latest profile', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const store = new ProfileStore({ dir, debounceMs: 800 });
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: true } } });
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: false } } });
    expect(existsSync(store.path)).toBe(false);
    vi.advanceTimersByTime(800);
    expect(JSON.parse(readFileSync(store.path, 'utf8')).plugins.a.enabled).toBe(false);
    store.scheduleSave({ schemaVersion: 1, plugins: { a: { enabled: true } } });
    store.flush();
    expect(JSON.parse(readFileSync(store.path, 'utf8')).plugins.a.enabled).toBe(true);
    store.flush();
  });
});
