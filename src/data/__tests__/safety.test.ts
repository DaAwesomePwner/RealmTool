import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSafetyCatalog, toSafetyCatalog, validateSafetyCatalog } from '../safety.ts';
import { SAFETY_CATALOG_LIMITS as limits, type SafetyCatalogFile } from '../../safety/SafetyCatalog.ts';

const fixture = (): SafetyCatalogFile => ({ schemaVersion: 1, gameBuild: 'fixture',
  source: { objectsSha256: 'a'.repeat(64), tilesSha256: 'b'.repeat(64) },
  projectiles: [[42, 0, 100, 3, 0.5, [['Sick', 2]]], [43, 1, 0, 0, 0, []]], tiles: [[2, 10]] });
const dirs: string[] = [];
function setup() {
  const appDataDir = fs.mkdtempSync(join(tmpdir(), 'safety-catalog-')); dirs.push(appDataDir);
  const bundledPath = join(appDataDir, 'bundled.json');
  const path = join(appDataDir, 'data/catalogs/safety.json'); fs.mkdirSync(join(appDataDir, 'data/catalogs'), { recursive: true });
  return { appDataDir, bundledPath, path };
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('safety catalog JSON boundary', () => {
  it('rejects stale appdata before plugin configuration, while accepting a verified replacement', () => {
    const options = setup(), out = join(options.appDataDir, 'data/catalogs'), gameDir = join(options.appDataDir, 'game');
    const data = join(gameDir, 'RotMG Exalt_Data'); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(join(data, 'resources.assets'), 'assets'); fs.writeFileSync(join(data, 'boot.config'), 'build');
    fs.writeFileSync(join(out, 'safety.json'), JSON.stringify(fixture()));
    const selected = { ...options, gameDir, gameBuild: fixture().gameBuild };
    expect(loadSafetyCatalog(selected)).toMatchObject({ ok: false });
    const stamp = (name: string) => { const { size, mtimeMs } = fs.statSync(join(data, name)); return { size, mtimeMs }; };
    const source = { schemaVersion: 1, gameBuild: fixture().gameBuild, resourcesAssets: stamp('resources.assets'), bootConfig: stamp('boot.config') };
    fs.writeFileSync(join(out, 'source.json'), JSON.stringify(source));
    expect(loadSafetyCatalog(selected)).toMatchObject({ ok: true });
    fs.utimesSync(join(data, 'resources.assets'), new Date(), new Date(source.resourcesAssets.mtimeMs + 2000));
    expect(loadSafetyCatalog(selected)).toMatchObject({ ok: false });
    fs.writeFileSync(options.bundledPath, JSON.stringify(fixture()));
    expect(loadSafetyCatalog(selected)).toMatchObject({ ok: true, path: options.bundledPath });
  });
  it('prefers a matching bundle over stale or invalid overrides, then matching overrides', () => {
    const options = setup();
    const dir = join(options.appDataDir, 'data/catalogs'); fs.mkdirSync(dir, { recursive: true });
    const path = join(dir, 'safety.json');
    fs.writeFileSync(options.bundledPath, JSON.stringify(fixture()));
    fs.writeFileSync(path, JSON.stringify({ ...fixture(), gameBuild: 'old' }));
    expect(loadSafetyCatalog({ ...options, gameBuild: 'fixture' })).toMatchObject({ ok: true, path: options.bundledPath });
    fs.writeFileSync(path, '{bad');
    expect(loadSafetyCatalog({ ...options, gameBuild: 'fixture' })).toMatchObject({ ok: true, path: options.bundledPath });
    fs.writeFileSync(path, JSON.stringify(fixture()));
    expect(loadSafetyCatalog({ ...options, gameBuild: 'fixture' })).toMatchObject({ ok: true, path });
  });
  it('validates the bundle and enforces the individual and total byte budgets', () => {
    const safety = fs.readFileSync(new URL('../../../data/catalogs/safety.json', import.meta.url));
    const consumables = fs.readFileSync(new URL('../../../data/catalogs/consumables.json', import.meta.url));
    expect(validateSafetyCatalog(JSON.parse(safety.toString())).projectiles.length).toBeGreaterThan(0);
    expect(safety.length).toBeLessThanOrEqual(limits.maxFileBytes);
    expect(safety.length + consumables.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('expands tuples to explicit flags and effects without retaining mutable input', () => {
    const input = fixture(); const file = validateSafetyCatalog(input);
    expect(file).toEqual(input); expect(file).not.toBe(input);
    expect(toSafetyCatalog(file)).toEqual({ projectiles: [
      [42, 0, { lifetimeMs: 100, multiHit: true, armorPiercing: true, maxHealthDamage: 0.5, conditionEffects: [{ effect: 'Sick', durationSec: 2 }] }],
      [43, 1, { lifetimeMs: 0, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] }],
    ], tiles: [[2, 10]] });
    input.projectiles[0][5][0][0] = 'changed'; expect(file.projectiles[0][5][0][0]).toBe('Sick');
  });
  it.each([
    ['schemaVersion', (f: any) => { f.schemaVersion = 2; }],
    ['gameBuild', (f: any) => { f.gameBuild = ' '; }],
    ...['objectsSha256', 'tilesSha256'].map(key => [key, (f: any) => { f.source[key] = 'bad'; }] as const),
    ...[[0, 1.5, 'type'], [0, 65536, 'type'], [1, -1, 'id'], [1, 256, 'id'], [1, 0.5, 'id'],
      [2, Infinity, 'lifetimeMs'], [2, 1000000001, 'lifetimeMs'], [3, 4, 'flags'], [3, 0.5, 'flags'],
      [4, NaN, 'maxHealthDamage'], [4, 1000001, 'maxHealthDamage']].map(([index, value, field]) =>
      [field, (f: any) => { f.projectiles[0][index] = value; }] as const),
    ['duplicate', (f: any) => { f.projectiles.push(f.projectiles[0]); }],
    ['duplicate', (f: any) => { f.tiles.push(f.tiles[0]); }],
    ['durationSec', (f: any) => { f.projectiles[0][5][0][1] = Infinity; }],
    ['durationSec', (f: any) => { f.projectiles[0][5][0][1] = 1000001; }],
    ['effect', (f: any) => { f.projectiles[0][5][0][0] = ''; }],
    ['damage', (f: any) => { f.tiles[0][1] = -1; }],
    ['type', (f: any) => { f.tiles[0][0] = 1.5; }],
  ] as [string, (f: any) => void][])('rejects invalid %s', (field, mutate) => { const f = fixture(); mutate(f); expect(() => validateSafetyCatalog(f)).toThrow(field); });
  it('prefers overrides, falls through only on ENOENT, and reports invalid overrides', () => {
    const options = setup();
    expect(loadSafetyCatalog(options)).toEqual({ ok: false, reason: 'safety catalog not found' });
    fs.writeFileSync(options.bundledPath, JSON.stringify(fixture()));
    expect(loadSafetyCatalog(options)).toEqual({ ok: true, catalog: fixture(), path: options.bundledPath });
    const override = { ...fixture(), gameBuild: 'override' }; fs.writeFileSync(options.path, JSON.stringify(override));
    expect(loadSafetyCatalog(options)).toEqual({ ok: true, catalog: override, path: options.path });
    fs.writeFileSync(options.path, '{bad');
    expect(loadSafetyCatalog(options)).toMatchObject({ ok: false, reason: expect.stringContaining('Invalid JSON') });
    fs.rmSync(options.path); fs.mkdirSync(options.path);
    expect(loadSafetyCatalog(options)).toMatchObject({ ok: false, reason: expect.stringContaining(options.path) });
  });
  it('rejects oversized files before JSON parsing', () => {
    const options = setup(); fs.writeFileSync(options.path, ' '.repeat(limits.maxFileBytes + 1));
    const parse = vi.spyOn(JSON, 'parse');
    expect(loadSafetyCatalog(options)).toMatchObject({ ok: false, reason: expect.stringMatching(/size|bytes/i) });
    expect(parse).not.toHaveBeenCalled();
  });
});
