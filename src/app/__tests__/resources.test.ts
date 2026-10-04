import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('resource paths', () => {
  it('resolves existing development resources independently of cwd', async () => {
    const { resourcePaths } = await import('../resources.ts');
    const paths = resourcePaths({});
    expect(paths.packaged).toBe(false);
    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(join(paths.dataDir, 'packet-definitions.json'))).toBe(true);
    expect(existsSync(join(paths.dataDir, 'catalogs', 'consumables.json'))).toBe(true);
    expect(existsSync(join(paths.dataDir, 'catalogs', 'safety.json'))).toBe(true);
    expect(existsSync(fileURLToPath(paths.workerUrl))).toBe(true);
    // The optional native build is not present in a fresh checkout.
    expect(paths.helperDll).toBe(join(paths.root, 'native/helper/bin/winhttp.dll'));
  });
  it('selects the packaged layout from an absolute environment path', async () => {
    const { resourcePaths } = await import('../resources.ts');
    const root = mkdtempSync(join(tmpdir(), 'realmtool-resources-'));
    try {
      const paths = resourcePaths({ REALMTOOL_RESOURCES: root });
      expect(paths).toMatchObject({ root, packaged: true, dataDir: join(root, 'data'), helperDll: join(root, 'native/winhttp.dll') });
      expect(fileURLToPath(paths.workerUrl)).toBe(join(root, 'backend/worker.mjs'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects a relative resources root', async () => {
    const { resourcePaths } = await import('../resources.ts');
    expect(() => resourcePaths({ REALMTOOL_RESOURCES: './resources' })).toThrow(/absolute/i);
  });
});
