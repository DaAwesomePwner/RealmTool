import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, type LogRecord } from '../log.ts';
import { attachFileLog, LogRing } from '../logStore.ts';

const record = (message: string): LogRecord => ({ at: 0, level: 'info', module: 'test', message });
const cleanup: (() => void)[] = [];
let dir: string;
beforeEach(() => {
  log.setConsole(false);
  dir = mkdtempSync(join(tmpdir(), 'realmtool-log-'));
});
afterEach(() => {
  cleanup.splice(0).forEach(fn => fn());
  vi.restoreAllMocks();
  log.setConsole(true);
  rmSync(dir, { recursive: true, force: true });
});

describe('LogRing', () => {
  it('bounds capacity and reports only missing records as dropped', () => {
    const ring = new LogRing(2);
    for (const message of ['a', 'b', 'c']) ring.push(record(message));
    expect(ring.since(0)).toEqual({ records: [
      { ...record('b'), seq: 2 }, { ...record('c'), seq: 3 },
    ], next: 3, dropped: true });
    expect(ring.since(1).dropped).toBe(false);
    const defaults = new LogRing();
    for (let i = 0; i < 1001; i++) defaults.push(record(String(i)));
    expect(defaults.since(0).records).toHaveLength(1000);
    expect(defaults.since(0).dropped).toBe(true);
  });

  it('pages after an exclusive sequence cursor', () => {
    const ring = new LogRing();
    expect(ring.since(0)).toEqual({ records: [], next: 0, dropped: false });
    expect(ring.push(record('a')).seq).toBe(1);
    const first = ring.since(0);
    ring.push(record('b'));
    expect(ring.since(first.next)).toEqual({ records: [{ ...record('b'), seq: 2 }], next: 2, dropped: false });
    expect(ring.since(2)).toEqual({ records: [], next: 2, dropped: false });
  });

  it('subscribes and unsubscribes without replaying history', () => {
    const ring = new LogRing();
    ring.push(record('before'));
    const listener = vi.fn();
    const detach = ring.subscribe(listener);
    const stored = ring.push(record('during'));
    detach();
    detach();
    ring.push(record('after'));
    expect(listener).toHaveBeenCalledExactlyOnceWith(stored);
  });
});

describe('log sinks', () => {
  it('removes a throwing sink once and continues delivering to other sinks', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('failure'); });
    const good = vi.fn();
    cleanup.push(log.addSink(bad), log.addSink(good));
    expect(() => log.info('test', 'one')).not.toThrow();
    expect(() => log.info('test', 'two')).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('rotates before the byte limit and retains exactly files files', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const line = '1970-01-01T00:00:00.000Z INFO [test] éé\n';
    const maxBytes = Buffer.byteLength(line) * 2;
    const detach = attachFileLog(dir, { maxBytes, files: 3 });
    cleanup.push(detach);
    for (let i = 0; i < 9; i++) log.info('test', 'éé');
    expect(readdirSync(dir).sort()).toEqual(['realmtool.log', 'realmtool.log.1', 'realmtool.log.2']);
    expect(readFileSync(join(dir, 'realmtool.log'), 'utf8')).toBe(line);
    for (const suffix of ['.1', '.2']) expect(readFileSync(join(dir, `realmtool.log${suffix}`), 'utf8')).toBe(line.repeat(2));
    detach();
    log.info('test', 'detached');
    expect(readFileSync(join(dir, 'realmtool.log'), 'utf8')).toBe(line);
  });

  it('detaches without throwing when the directory cannot be written', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const good = vi.fn();
    cleanup.push(log.addSink(good));
    expect(() => cleanup.push(attachFileLog(blocked))).not.toThrow();
    expect(() => log.info('test', 'one')).not.toThrow();
    rmSync(blocked);
    mkdirSync(blocked);
    log.info('test', 'two');
    expect(readdirSync(blocked)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('detaches after a later write failure without interrupting other sinks', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanup.push(attachFileLog(dir));
    log.info('test', 'before');
    const path = join(dir, 'realmtool.log');
    rmSync(path);
    mkdirSync(path);
    const good = vi.fn();
    cleanup.push(log.addSink(good));
    expect(() => log.info('test', 'failed')).not.toThrow();
    rmSync(path, { recursive: true });
    log.info('test', 'after');
    expect(readdirSync(dir)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('keeps multiline messages on one physical line and supports a single retained file', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    cleanup.push(attachFileLog(dir, { maxBytes: 64, files: 1 }));
    log.info('test', 'first');
    log.error('test', 'second\nthird\r\nfourth');
    expect(readdirSync(dir)).toEqual(['realmtool.log']);
    expect(readFileSync(join(dir, 'realmtool.log'), 'utf8'))
      .toBe('1970-01-01T00:00:00.000Z ERROR [test] second\\nthird\\r\\nfourth\n');
  });
});
