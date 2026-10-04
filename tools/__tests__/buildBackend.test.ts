import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'realmtool-bundle-'));
const env = { ...process.env, REALMTOOL_RESOURCES: out, APPDATA: join(out, 'appdata') };

let built: ReturnType<typeof exec> | undefined;
const build = () => built ??= exec(process.execPath, [join(root, 'tools/build-backend.ts'), '--out-dir', out, '--allow-missing-helper'], { cwd: root });

describe('backend bundle', () => {
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  it('stages both bundles, linked maps and data', async () => {
    await build();
    for (const file of ['backend/main.mjs', 'backend/worker.mjs', 'backend/main.mjs.map', 'backend/worker.mjs.map',
      'data/packet-definitions.json', 'data/stat-types.json', 'data/servers.json', 'data/catalogs/consumables.json', 'data/catalogs/safety.json']) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
  });
  it('ships only the required win32_x64 Koffi runtime', async () => {
    await build();
    const koffi = join(out, 'backend/node_modules/koffi');
    expect(readdirSync(koffi).sort()).toEqual(['LICENSE.txt', 'build', 'index.js', 'package.json']);
    expect(readdirSync(join(koffi, 'build/koffi'))).toEqual(['win32_x64']);
    expect(readdirSync(join(koffi, 'build/koffi/win32_x64'))).toEqual(['koffi.node']);
  });
  it('leaves no TypeScript or source module specifiers', async () => {
    await build();
    for (const name of ['main', 'worker']) {
      const code = readFileSync(join(out, `backend/${name}.mjs`), 'utf8');
      expect(code).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:\.ts["']|\/src\/)/);
    }
  });
  it('runs help from outside the repository', async () => {
    await build();
    const { stdout } = await exec(process.execPath, [join(out, 'backend/main.mjs'), 'help'], { cwd: out, env });
    expect(stdout).toContain('Usage: realmtool <command> [options]');
    expect(stdout).toMatch(/start/);
    expect(stdout).not.toContain('selftest');
  });
  it('loads packaged schema and both catalogs and starts and stops the packaged worker', async () => {
    await build();
    const { stdout } = await exec(process.execPath, [join(out, 'backend/main.mjs'), 'selftest'], { cwd: out, env, timeout: 10_000 });
    expect(stdout).toContain('selftest ok');
  });
});
