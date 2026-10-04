import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readBuildGuid, readGameBuild, readGameBuildAsync } from '../gameBuild.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(contents?: string) {
  const gameDir = mkdtempSync(join(tmpdir(), 'realmtool-build-'));
  roots.push(gameDir);
  const dataDir = join(gameDir, 'RotMG Exalt_Data');
  mkdirSync(dataDir);
  const path = join(dataDir, 'boot.config');
  if (contents !== undefined) writeFileSync(path, contents);
  return { gameDir, dataDir, path };
}
it('reads the installed build-guid and preserves the generator data-directory API', () => {
  const f = fixture('wait-for-native-debugger=0\r\nbuild-guid=fixture-build  \r\ngc-max-time-slice=3\r\n');
  expect(readGameBuild(f.gameDir)).toBe('fixture-build');
  expect(readBuildGuid(f.dataDir)).toBe('fixture-build');
});
it.each(['other=value\n', 'build-guid=   \r\n'])('reports the boot.config path when build-guid is missing (%#)', contents => {
  const f = fixture(contents);
  expect(() => readGameBuild(f.gameDir)).toThrow(`${f.path}: missing build-guid`);
});
it('reports the boot.config path and read failure when the file is unavailable', () => {
  const f = fixture();
  expect(() => readGameBuild(f.gameDir)).toThrow(f.path);
  expect(() => readGameBuild(f.gameDir)).toThrow('ENOENT');
});

it('reads the same build asynchronously for the worker', async () => {
  const f = fixture('wait-for-native-debugger=0\r\nbuild-guid=fixture-build  \r\ngc-max-time-slice=3\r\n');
  await expect(readGameBuildAsync(f.gameDir)).resolves.toBe('fixture-build');
});
it.each(['other=value\n', 'build-guid=   \r\n'])('rejects a missing worker build stamp (%#)', async contents => {
  const f = fixture(contents);
  await expect(readGameBuildAsync(f.gameDir)).rejects.toThrow(`${f.path}: missing build-guid`);
});
it('reports the path and I/O failure from the asynchronous worker read', async () => {
  const f = fixture();
  await expect(readGameBuildAsync(f.gameDir)).rejects.toThrow(`${f.path}: unable to read boot.config`);
  await expect(readGameBuildAsync(f.gameDir)).rejects.toThrow('ENOENT');
});
