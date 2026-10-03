import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles, targetFilePath } from '../targetResolver.ts';

const identity = { pid: 777, processStartTime: '1' };
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

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
    const dir = createTempDir();
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    const resolve = createTargetResolver({ tempDir: dir, identify: () => identity });
    expect(resolve(50123)).toEqual({ host: '18.144.30.153', port: 2050 });
    expect(readdirSync(dir)).toEqual([]);
    expect(resolve(50123)).toBeNull();
  });

  it('returns null when the socket owner is unknown', () => {
    const dir = createTempDir();
    writeFileSync(targetFilePath(777, dir), '18.144.30.153');
    expect(createTargetResolver({ tempDir: dir, identify: () => null })(50123)).toBeNull();
  });

  it('removes stale target files only', () => {
    const dir = createTempDir();
    writeFileSync(targetFilePath(1, dir), '1.2.3.4');
    writeFileSync(targetFilePath(2, dir), '1.2.3.4');
    writeFileSync(join(dir, 'unrelated.txt'), 'x');
    writeFileSync(join(dir, 'realmtool_target_backup.txt'), 'x');
    expect(removeStaleTargetFiles(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['realmtool_target_backup.txt', 'unrelated.txt']);
  });
});
