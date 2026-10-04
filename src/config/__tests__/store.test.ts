import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDataDir, emptyProfile, normalizeProfile, ProfileStore, writeJsonAtomic } from '../store.ts';
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
    expect(new ProfileStore({ dir: tempDir() }).load()).toEqual(emptyProfile());
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
