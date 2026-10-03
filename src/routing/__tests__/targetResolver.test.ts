import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles, targetFilePath } from '../targetResolver.ts';

const identity = { pid: 777, processStartTime: '1' };

describe('target resolver', () => {
  it('accepts only non-loopback IPv4 dotted quads', () => {
    expect(parseTargetFile(' 54.86.47.176\r\n')).toBe('54.86.47.176');
    expect(parseTargetFile('127.0.0.1')).toBeNull();
    expect(parseTargetFile('256.1.1.1')).toBeNull();
    expect(parseTargetFile('01.2.3.4')).toBeNull();
    expect(parseTargetFile('example.com')).toBeNull();
    expect(parseTargetFile('')).toBeNull();
  });

  it('reads and deletes the per-PID file for the identified game process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    const resolve = createTargetResolver({ tempDir: dir, identify: () => identity });
    expect(resolve(50123)).toEqual({ host: '18.144.30.153', port: 2050 });
    expect(readdirSync(dir)).toEqual([]);
    expect(resolve(50123)).toBeNull();
  });

  it('returns null when the socket owner is unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    expect(createTargetResolver({ tempDir: dir, identify: () => null })(50123)).toBeNull();
  });

  it('removes stale target files only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
    writeFileSync(targetFilePath(1, dir), '1.2.3.4');
    writeFileSync(targetFilePath(2, dir), '1.2.3.4');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    expect(removeStaleTargetFiles(dir)).toBe(2);
    expect(readdirSync(dir)).toEqual(['unrelated.txt']);
  });
});
