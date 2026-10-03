import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchExalt } from '../launcher.ts';

it('reports a missing game directory asynchronously without throwing synchronously', async () => {
  const gameDir = mkdtempSync(join(tmpdir(), 'realmtool-launch-'));
  rmdirSync(gameDir);
  let onError!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => { onError = resolve; });
  expect(() => launchExalt(gameDir, [], onError)).not.toThrow();
  const error = await failed;
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
});
