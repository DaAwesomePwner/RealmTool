import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConsumables } from '../consumables.ts';
import { appDataDir } from '../../config/store.ts';

const dirs: string[] = [];
const fixture = () => ({ schemaVersion: 1, gameBuild: 'fixture-build', source: { objectsSha256: 'a'.repeat(64) },
  items: [{ type: 42, name: 'Fixture', hp: 20, mp: 0, healingDurationMs: 0, quickslot: true }] });
function setup() {
  const appDataDir = mkdtempSync(join(tmpdir(), 'catalog-test-'));
  dirs.push(appDataDir);
  return { appDataDir, bundledPath: join(appDataDir, 'bundled.json') };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('consumables JSON runtime loader', () => {
  it('loads the real catalog from the default bundled path', () => {
    const { appDataDir } = setup();
    const result = loadConsumables({ appDataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.path).toBe(fileURLToPath(new URL('../../../data/catalogs/consumables.json', import.meta.url)));
    expect(result.catalog.schemaVersion).toBe(1);
    expect(result.catalog.gameBuild.trim().length).toBeGreaterThan(0);
    expect(result.catalog.items.some(item => item.quickslot && item.hp > 0)).toBe(true);
  });
  it('loads a valid bundled file', () => {
    const options = setup();
    writeFileSync(options.bundledPath, JSON.stringify(fixture()));
    expect(loadConsumables(options)).toEqual({ ok: true, catalog: fixture(), path: options.bundledPath });
  });
  it('prefers the appdata override', () => {
    const options = setup();
    writeFileSync(options.bundledPath, JSON.stringify(fixture()));
    const dir = join(options.appDataDir, 'data/catalogs');
    mkdirSync(dir, { recursive: true });
    const catalog = { ...fixture(), gameBuild: 'override' };
    const path = join(dir, 'consumables.json');
    writeFileSync(path, JSON.stringify(catalog));
    expect(loadConsumables(options)).toEqual({ ok: true, catalog, path });
    writeFileSync(path, '{bad');
    expect(loadConsumables(options)).toMatchObject({ ok: false, reason: expect.stringContaining(path) });
  });
  it('uses the override under appDataDir() for both default and explicit application directories', () => {
    const options = setup();
    vi.stubEnv('APPDATA', options.appDataDir);
    const applicationDir = appDataDir();
    const dir = join(applicationDir, 'data', 'catalogs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'consumables.json');
    const catalog = { ...fixture(), gameBuild: 'application-directory-override' };
    writeFileSync(path, JSON.stringify(catalog));
    expect(loadConsumables()).toEqual({ ok: true, catalog, path });
    expect(loadConsumables({ appDataDir: applicationDir })).toEqual({ ok: true, catalog, path });
  });
  it.each([
    ['malformed JSON', '{bad', 'JSON'],
    ['wrong schemaVersion', JSON.stringify({ ...fixture(), schemaVersion: 2 }), 'schemaVersion'],
    ['missing gameBuild', JSON.stringify({ ...fixture(), gameBuild: undefined }), 'gameBuild'],
    ['empty gameBuild', JSON.stringify({ ...fixture(), gameBuild: ' ' }), 'gameBuild'],
    ['invalid source hash', JSON.stringify({ ...fixture(), source: {} }), 'objectsSha256'],
    ['duplicate types', JSON.stringify({ ...fixture(), items: [...fixture().items, ...fixture().items] }), 'duplicate'],
    ...[
      { type: -1 }, { type: 0x80000000 }, { type: 1.5 }, { name: 1 }, { quickslot: 'true' },
      { hp: -1 }, { mp: null }, { healingDurationMs: 86_400_001 }, { hp: 0 },
    ].map(patch => ['invalid item ' + JSON.stringify(patch), JSON.stringify({ ...fixture(), items: [{ ...fixture().items[0], ...patch }] }), 'item']),
  ])('rejects %s with file and problem', (_name, json, problem) => {
    const options = setup();
    writeFileSync(options.bundledPath, json);
    const result = loadConsumables(options);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(options.bundledPath) });
    expect(result).toMatchObject({ reason: expect.stringContaining(problem) });
  });
  it('returns the exact missing-file reason', () => {
    expect(loadConsumables(setup())).toEqual({ ok: false, reason: 'consumables catalog not found' });
  });
});
