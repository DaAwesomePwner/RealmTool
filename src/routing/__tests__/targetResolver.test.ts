import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles, targetFilePath } from '../targetResolver.ts';

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const identity = { pid: 777, processStartTime: '1' };
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realmtool-target-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('target resolver', () => {
  function candidateDirs() {
    const dirs = [createTempDir(), createTempDir(), createTempDir(), createTempDir()];
    vi.spyOn(os, 'tmpdir').mockReturnValue(dirs[0]!);
    vi.stubEnv('TMP', dirs[1]!);
    vi.stubEnv('TEMP', dirs[2]!);
    vi.stubEnv('USERPROFILE', dirs[3]!);
    return dirs;
  }

  it.each([0, 1, 2, 3])('finds and consumes a file in candidate directory %i when TMP differs from TEMP', index => {
    const dirs = candidateDirs();
    writeFileSync(targetFilePath(777, dirs[index]!), '18.144.30.153');
    const resolve = createTargetResolver({ identify: () => identity });
    expect(resolve(50123)).toEqual({ host: '18.144.30.153', port: 2050 });
    expect(readdirSync(dirs[index]!)).toEqual([]);
    expect(resolve(50123)).toBeNull();
  });

  it('skips unset and empty environment variables', () => {
    const dirs = candidateDirs();
    vi.stubEnv('TMP', undefined);
    vi.stubEnv('TEMP', '');
    writeFileSync(targetFilePath(777, dirs[3]!), '18.144.30.153');
    expect(createTargetResolver({ identify: () => identity })(50123))
      .toEqual({ host: '18.144.30.153', port: 2050 });
  });

  it('resolves and de-duplicates candidate directories before reading', () => {
    const dirs = candidateDirs();
    vi.stubEnv('TMP', relative(process.cwd(), dirs[0]!));
    vi.stubEnv('TEMP', dirs[0]!);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(createTargetResolver({ identify: () => identity })(50123)).toBeNull();
    expect(read.mock.calls.map(call => call[0])).toEqual([
      targetFilePath(777, dirs[0]!), targetFilePath(777, dirs[3]!),
    ]);
  });

  it.each([1, 2, 3, 0])('uses GetTempPathW order from candidate %i and clears other PID records', first => {
    const dirs = candidateDirs();
    const order = [1, 2, 3, 0];
    for (const index of order.slice(order.indexOf(first))) {
      writeFileSync(targetFilePath(777, dirs[index]!), index === first ? '18.144.30.153' : '1.2.3.4');
    }
    writeFileSync(targetFilePath(778, dirs[0]!), '1.2.3.4');
    const resolve = createTargetResolver({ identify: () => identity });
    expect(resolve(50123)).toEqual({ host: '18.144.30.153', port: 2050 });
    expect(resolve(50123)).toBeNull();
    expect(readdirSync(dirs[0]!)).toEqual(['realmtool_target_778.txt']);
    for (const index of [1, 2, 3]) expect(readdirSync(dirs[index]!)).toEqual([]);
  });

  it('sweeps stale targets in every candidate directory without removing unrelated files', () => {
    const dirs = candidateDirs();
    for (const dir of dirs) {
      writeFileSync(targetFilePath(777, dir), '18.144.30.153');
      writeFileSync(join(dir, 'unrelated.txt'), 'keep');
    }
    expect(removeStaleTargetFiles()).toBe(4);
    for (const dir of dirs) expect(readdirSync(dir)).toEqual(['unrelated.txt']);
    expect(createTargetResolver({ identify: () => identity })(50123)).toBeNull();
  });

  it('de-duplicates sweep directories and skips missing directories', () => {
    const dirs = candidateDirs();
    vi.stubEnv('TMP', relative(process.cwd(), dirs[0]!));
    vi.stubEnv('TEMP', join(dirs[0]!, 'missing'));
    writeFileSync(targetFilePath(777, dirs[3]!), '18.144.30.153');
    const read = vi.spyOn(fs, 'readdirSync');
    expect(removeStaleTargetFiles()).toBe(1);
    expect(read.mock.calls.map(call => call[0])).toEqual([
      dirs[0], join(dirs[0]!, 'missing'), dirs[3],
    ]);
  });

  it.each(['127.0.0.1', '127.5.6.7', '256.1.1.1', '01.2.3.4', 'example.com', ''])
    ('rejects invalid first file %j without falling through to another target', text => {
      const dirs = candidateDirs();
      writeFileSync(targetFilePath(777, dirs[1]!), text);
      writeFileSync(targetFilePath(777, dirs[2]!), '1.2.3.4');
      expect(createTargetResolver({ identify: () => identity })(50123)).toBeNull();
      expect(readdirSync(dirs[1]!)).toEqual([]);
      expect(readdirSync(dirs[2]!)).toEqual([]);
    });

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
