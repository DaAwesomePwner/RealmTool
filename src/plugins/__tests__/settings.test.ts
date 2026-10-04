import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, validateSetting } from '../settings.ts';
import type { SettingDef } from '../api.ts';
import { log, type LogRecord } from '../../util/log.ts';

const def = (over: Partial<SettingDef>): SettingDef => ({ key: 'k', label: 'K', type: 'text', value: '', ...over });

describe('validateSetting', () => {
  it('checks types, bounds, options and length', () => {
    expect(validateSetting(def({ type: 'boolean', value: false }), true)).toBe(true);
    expect(() => validateSetting(def({ type: 'boolean', value: false }), 'yes')).toThrow();
    expect(validateSetting(def({ type: 'number', value: 1, min: 0, max: 10 }), 10)).toBe(10);
    expect(() => validateSetting(def({ type: 'number', value: 1, min: 0, max: 10 }), 11)).toThrow();
    expect(() => validateSetting(def({ type: 'range', value: 1 }), Number.NaN)).toThrow();
    expect(validateSetting(def({ type: 'select', value: 'a', options: [{ label: 'A', value: 'a' }] }), 'a')).toBe('a');
    expect(() => validateSetting(def({ type: 'select', value: 'a', options: [{ label: 'A', value: 'a' }] }), 'b')).toThrow();
    expect(() => validateSetting(def({ type: 'text', value: '', maxLength: 3 }), 'abcd')).toThrow();
  });
});

describe('SettingsStore', () => {
  it('stores defaults, notifies on every accepted update, and rejects invalid values', () => {
    const store = new SettingsStore();
    const seen = vi.fn();
    store.register('count', { label: 'Count', type: 'number', value: 3, min: 1, max: 5 }, seen);
    expect(store.get('count')).toBe(3);
    expect(seen).not.toHaveBeenCalled();
    expect(store.update('count', 4)).toBe(true);
    expect(store.update('count', 4)).toBe(true);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(store.update('count', 9)).toBe(false);
    expect(store.get('count')).toBe(4);
    expect(store.update('missing', 1)).toBe(false);
  });

  it('runs buttons without storing them and leaves buttons and transients out of persistable values', () => {
    const store = new SettingsStore();
    const pressed = vi.fn();
    store.register('go', { label: 'Go', type: 'button', value: undefined }, pressed);
    store.register('draft', { label: 'Draft', type: 'text', value: '', transient: true });
    store.register('keep', { label: 'Keep', type: 'boolean', value: true });
    expect(store.update('go', 'anything')).toBe(true);
    expect(pressed).toHaveBeenCalledWith(true);
    expect(store.persistable()).toEqual({ keep: true });
  });

  it('uses a plugin validator instead of generic validation', () => {
    const store = new SettingsStore((key, value) => {
      if (key !== 'mode' || (value !== 'x' && value !== 'y')) throw new Error('bad');
      return value;
    });
    store.register('mode', { label: 'Mode', type: 'text', value: 'x' });
    expect(store.update('mode', 'y')).toBe(true);
    expect(store.update('mode', 'z')).toBe(false);
  });

  it('reports any change through onChange and isolates callback errors', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    try {
      const changed = vi.fn();
      const store = new SettingsStore(undefined, changed);
      store.register('a', { label: 'A', type: 'boolean', value: false }, () => { throw new Error('boom'); });
      expect(store.update('a', true)).toBe(true);
      expect(store.get('a')).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: 'error', module: 'Settings' });
      expect(records[0].message).toMatch(/^Setting a callback failed: .*boom/s);
    } finally {
      remove();
      log.setConsole(true);
    }
  });

  it('keeps accepted updates and logs errors when the store change listener throws', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    try {
      const store = new SettingsStore(undefined, () => { throw new Error('listener boom'); });
      store.register('a', { label: 'A', type: 'boolean', value: false });
      expect(store.update('a', true)).toBe(true);
      expect(store.get('a')).toBe(true);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ level: 'error', module: 'Settings' });
      expect(records[0].message).toMatch(/^Settings change listener failed: .*listener boom/s);
    } finally {
      remove();
      log.setConsole(true);
    }
  });

  it('rejects duplicate registration', () => {
    const store = new SettingsStore();
    store.register('a', { label: 'A', type: 'boolean', value: false });
    expect(() => store.register('a', { label: 'A', type: 'boolean', value: false })).toThrow('already registered');
  });
});
