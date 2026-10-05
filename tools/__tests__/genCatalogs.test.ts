import { serializedFile } from '../../src/testing/unityAssets.ts';
import { generateCatalogs as runtimeGenerateCatalogs } from '../../src/catalogs/generate.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { consumablesFromObjectsXml } from '../catalogs/consumables.ts';
import { extractXmlTextAssets } from '../catalogs/unityText.ts';
import { readBuildGuid } from '../../src/game/gameBuild.ts';
import { generateCatalog, generateCatalogs } from '../gen-catalogs.ts';
import { loadConsumables } from '../../src/data/consumables.ts';

const dirs: string[] = [];
function temp() { const dir = fs.mkdtempSync(join(tmpdir(), 'gen-catalog-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const object = (type: string) => `<Object type='${type}'><Consumable/><Activate amount='20'>Heal</Activate></Object>`;

describe('catalog generation', () => {
  it('keeps the tools wrapper on the runtime implementation', () => { expect(generateCatalogs).toBe(runtimeGenerateCatalogs); });
  it('writes both XML catalogs deterministically, compact safety, and stages both before renaming', () => {
    const dir = temp(); const objects = join(dir, 'objects.xml'); const tiles = join(dir, 'tiles.xml'); const out = join(dir, 'out');
    fs.writeFileSync(objects, `<Objects>${object('42')}<Object type='1'><Projectile/></Object></Objects>`);
    fs.writeFileSync(tiles, '<GroundTypes><Ground type="2"><MaxDamage>10</MaxDamage></Ground></GroundTypes>');
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination).endsWith('consumables.json')) {
        expect(fs.readdirSync(out).filter(name => name.endsWith('.tmp'))).toHaveLength(2);
      }
      originalRename(source, destination);
    });
    const args = ['--objects', objects, '--tiles', tiles, '--build', 'fixture', '--out-dir', out];
    const result = generateCatalogs(args, { writeSource: true });
    expect(result).toMatchObject({ gameBuild: 'fixture', consumables: { items: 1 }, safety: { projectiles: 1, tiles: 1 } });
    expect(rename).toHaveBeenCalledTimes(2);
    const safety = fs.readFileSync(result.safety.path, 'utf8'); const consumables = fs.readFileSync(result.consumables.path, 'utf8');
    expect(safety).toBe(JSON.stringify(JSON.parse(safety)) + '\n');
    expect(JSON.parse(safety).source).toEqual({ objectsSha256: createHash('sha256').update(fs.readFileSync(objects)).digest('hex'), tilesSha256: createHash('sha256').update(fs.readFileSync(tiles)).digest('hex') });
    generateCatalogs(args); expect(fs.readFileSync(result.safety.path, 'utf8')).toBe(safety);
    for (const invalid of [
      `<Objects>${object('42')}<Object type='1'><Projectile id='256'/></Object></Objects>`,
      `<Objects>${object('42')}${object('42').replace("'20'", "'30'")}</Objects>`,
    ]) {
      fs.writeFileSync(objects, invalid); expect(() => generateCatalogs(args)).toThrow();
      expect(fs.readFileSync(result.safety.path, 'utf8')).toBe(safety);
      expect(fs.readFileSync(result.consumables.path, 'utf8')).toBe(consumables);
      expect(fs.readdirSync(out).sort()).toEqual(['consumables.json', 'safety.json']);
    }
  });
  it('reads the asset once and verifies the build before and after when generating both catalogs', () => {
    const dir = temp(); const data = join(dir, 'RotMG Exalt_Data'); fs.mkdirSync(data);
    fs.writeFileSync(join(data, 'boot.config'), 'build-guid=fixture-guid');
    fs.writeFileSync(join(data, 'resources.assets'), serializedFile([
      { classId: 49, text: `<?xml version="1.0"?><Objects>${object('42')}<Object type='1'><Projectile/></Object></Objects>` },
      { classId: 49, text: '<?xml version="1.0"?><GroundTypes><Ground type="2"><MinDamage>1</MinDamage></Ground></GroundTypes>' },
    ]));
    const read = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    expect(generateCatalogs(['--game-dir', dir, '--out-dir', join(dir, 'out')])).toMatchObject({ gameBuild: 'fixture-guid', safety: { projectiles: 1, tiles: 1 } });
    for (const name of ['resources.assets', 'boot.config']) expect(read.mock.calls.filter(([path]) => path === join(data, name))).toHaveLength(name === 'boot.config' ? 2 : 1);
  });
  it('publishes nothing if the build changes during extraction', () => {
    const dir = temp(), data = join(dir, 'RotMG Exalt_Data'), out = join(dir, 'out'); fs.mkdirSync(data);
    fs.writeFileSync(join(data, 'boot.config'), 'build-guid=before');
    fs.writeFileSync(join(data, 'resources.assets'), serializedFile([
      { classId: 49, text: `<?xml version="1.0"?><Objects>${object('42')}</Objects>` },
      { classId: 49, text: '<?xml version="1.0"?><GroundTypes></GroundTypes>' },
    ]));
    const original = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
      const value = (original as any)(path, ...args);
      if (String(path).endsWith('resources.assets')) fs.writeFileSync(join(data, 'boot.config'), 'build-guid=after');
      return value;
    }) as any);
    syncBuiltinESMExports();
    expect(() => generateCatalogs(['--game-dir', dir, '--out-dir', out])).toThrow('game files changed during refresh; retrying later');
    expect(fs.existsSync(out)).toBe(false);
  });
  function installFixture() {
    const dir = temp(), data = join(dir, 'RotMG Exalt_Data'), out = join(dir, 'out'); fs.mkdirSync(data);
    fs.writeFileSync(join(data, 'boot.config'), 'build-guid=fixture');
    fs.writeFileSync(join(data, 'resources.assets'), serializedFile([
      { classId: 49, text: `<?xml version="1.0"?><Objects>${object('42')}</Objects>` },
      { classId: 49, text: '<?xml version="1.0"?><GroundTypes></GroundTypes>' },
    ]));
    return { dir, data, out, args: ['--game-dir', dir, '--out-dir', out] };
  }
  it.each([['resources.assets', 'mtime'], ['boot.config', 'mtime'], ['resources.assets', 'size'], ['boot.config', 'size']])('publishes nothing if %s %s changes with the same build', (name, field) => {
    const f = installFixture(), original = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: any, ...args: any[]) => {
      const value = (original as any)(path, ...args);
      if (String(path).endsWith('resources.assets')) {
        const target = join(f.data, name), stat = fs.statSync(target);
        if (field === 'mtime') fs.utimesSync(target, stat.atime, new Date(stat.mtimeMs + 2000));
        else { fs.appendFileSync(target, ' '); fs.utimesSync(target, stat.atime, stat.mtime); }
      }
      return value;
    }) as any);
    syncBuiltinESMExports();
    expect(() => generateCatalogs(f.args, { writeSource: true })).toThrow('game files changed during refresh; retrying later');
    expect(fs.existsSync(f.out)).toBe(false);
  });
  it('stages the fingerprint with both catalogs and publishes it last, only after success', () => {
    const f = installFixture(), original = fs.renameSync.bind(fs), published: string[] = [];
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!published.length) expect(fs.readdirSync(f.out).filter(p => p.endsWith('.tmp'))).toHaveLength(3);
      published.push(String(to)); original(from, to);
    });
    generateCatalogs(f.args, { writeSource: true });
    expect(published).toEqual(['consumables.json', 'safety.json', 'source.json'].map(p => join(f.out, p)));
    const stamp = (name: string) => { const { size, mtimeMs } = fs.statSync(join(f.data, name)); return { size, mtimeMs }; };
    const source = fs.readFileSync(join(f.out, 'source.json'), 'utf8');
    expect(JSON.parse(source)).toEqual({ schemaVersion: 1, gameBuild: 'fixture', resourcesAssets: stamp('resources.assets'), bootConfig: stamp('boot.config') });
    fs.writeFileSync(join(f.data, 'resources.assets'), 'broken');
    expect(() => generateCatalogs(f.args, { writeSource: true })).toThrow();
    expect(fs.readFileSync(join(f.out, 'source.json'), 'utf8')).toBe(source);
  });
  it('checks parent liveness immediately before publishing staged catalogs', () => {
    const f = installFixture();
    const beforePublish = vi.fn(() => {
      expect(fs.readdirSync(f.out).filter(p => p.endsWith('.tmp'))).toHaveLength(3);
      throw new Error('refresh parent disconnected');
    });
    expect(() => generateCatalogs(f.args, { writeSource: true, beforePublish })).toThrow('parent disconnected');
    expect(beforePublish).toHaveBeenCalledOnce(); expect(fs.readdirSync(f.out)).toEqual([]);
  });
  it('keeps ordinary generator output free of local source fingerprints', () => {
    const f = installFixture(); generateCatalogs(f.args);
    expect(fs.readdirSync(f.out).sort()).toEqual(['consumables.json', 'safety.json']);
  });
  it('treats decimal and hex types and single-quoted attributes equivalently', () => {
    expect(consumablesFromObjectsXml(`<Objects>${object('42')}</Objects>`))
      .toEqual(consumablesFromObjectsXml(`<Objects>${object('0x2a')}</Objects>`));
  });
  it('sorts, deduplicates, and ignores commented, CDATA, and nested fake Objects', () => {
    const xml = `<Objects><!--${object('7')}--><Notes><![CDATA[${object('8')}]]></Notes><Wrapper>${object('9')}</Wrapper>${object('42')}${object('1')}${object('0x2a')}</Objects>`;
    expect(consumablesFromObjectsXml(xml).map(item => item.type)).toEqual([1, 42]);
  });
  it('rejects conflicting duplicate definitions and malformed documents', () => {
    expect(() => consumablesFromObjectsXml(`<Objects>${object('42')}${object('42').replace("'20'", "'30'")}</Objects>`)).toThrow(/duplicate/i);
    expect(() => consumablesFromObjectsXml('<Objects><broken></Objects>')).toThrow();
    expect(() => consumablesFromObjectsXml(`<Wrapper>${object('42')}</Wrapper>`)).toThrow();
    expect(() => consumablesFromObjectsXml('<Objects/><Objects/>')).toThrow();
  });
  it('writes deterministic, build-stamped JSON atomically and preserves output on invalid input', () => {
    const dir = temp();
    const objects = join(dir, 'objects.xml');
    const out = join(dir, 'data/consumables.json');
    const xml = `<Objects>${object('42')}${object('1')}</Objects>`;
    fs.writeFileSync(objects, xml);
    const rename = vi.spyOn(fs, 'renameSync');
    generateCatalog(['--objects', objects, '--build', 'fixture-build', '--out', out]);
    const first = fs.readFileSync(out, 'utf8');
    expect(rename).toHaveBeenCalledWith(expect.stringContaining(out + '.'), out);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: 1, gameBuild: 'fixture-build', source: {
      objectsSha256: createHash('sha256').update(xml).digest('hex'),
    }, items: [{ type: 1 }, { type: 42 }] });
    expect(first).toBe(JSON.stringify(JSON.parse(first), null, 2) + '\n');
    expect(loadConsumables({ appDataDir: dir, bundledPath: out })).toMatchObject({ ok: true });
    generateCatalog(['--objects', objects, '--build', 'fixture-build', '--out', out]);
    expect(fs.readFileSync(out, 'utf8')).toBe(first);
    fs.writeFileSync(objects, '<broken>');
    expect(() => generateCatalog(['--objects', objects, '--build', 'fixture-build', '--out', out])).toThrow();
    expect(fs.readFileSync(out, 'utf8')).toBe(first);
    expect(fs.readdirSync(join(dir, 'data'))).toEqual(['consumables.json']);
  });
  it('leaves the previous file intact until rename and cleans up after a rename failure', () => {
    const dir = temp(); const objects = join(dir, 'objects.xml'); const out = join(dir, 'catalog.json');
    fs.writeFileSync(objects, `<Objects>${object('42')}</Objects>`);
    fs.writeFileSync(out, 'previous bytes');
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      expect(destination).toBe(out);
      expect(fs.readFileSync(out, 'utf8')).toBe('previous bytes');
      expect(JSON.parse(fs.readFileSync(source, 'utf8'))).toMatchObject({ gameBuild: 'fixture' });
      throw new Error('simulated rename failure');
    });
    expect(() => generateCatalog(['--objects', objects, '--build', 'fixture', '--out', out])).toThrow('simulated rename failure');
    expect(fs.readFileSync(out, 'utf8')).toBe('previous bytes');
    expect(fs.readdirSync(dir).sort()).toEqual(['catalog.json', 'objects.xml']);
  });
  it('requires an explicit build for XML and rejects ambiguous CLI input', () => {
    for (const args of [['--objects', 'x'], ['--game-dir', 'x', '--objects', 'x', '--build', 'b'], ['--wat'], ['--out'], ['--build', 'b']]) {
      expect(() => generateCatalog(args)).toThrow();
    }
  });
  it('extracts only XML Objects and GroundTypes TextAssets', () => {
    const objects = '<?xml version="1.0"?><Objects></Objects>';
    const tiles = '<?xml version="1.0"?><GroundTypes></GroundTypes>';
    const buf = serializedFile([
      { classId: 49, text: objects }, { classId: 49, text: tiles },
      { classId: 28, text: objects }, { classId: 49, text: '<Objects></Objects>' },
      { classId: 49, text: '<?xml version="1.0"?><Other/>' },
    ]);
    expect(extractXmlTextAssets(buf)).toEqual({ objects: [objects], tiles: [tiles] });
    const wrongVersion = Buffer.from(buf); wrongVersion.writeUInt32BE(21, 8);
    expect(() => extractXmlTextAssets(wrongVersion)).toThrow(/version/);
    expect(() => extractXmlTextAssets(buf.subarray(0, 60))).toThrow();
  });
  it('handles v22 enabled type trees and their dependency table', () => {
    const objects = '<?xml version="1.0"?><Objects></Objects>';
    expect(extractXmlTextAssets(serializedFile([{ classId: 49, text: objects }], true)))
      .toEqual({ objects: [objects], tiles: [] });
  });
  it('reads build-guid and generates from a synthetic install without writing there', () => {
    const dir = temp(); const data = join(dir, 'RotMG Exalt_Data'); fs.mkdirSync(data);
    fs.writeFileSync(join(data, 'boot.config'), 'other=value\r\nbuild-guid=fixture-guid\r\n');
    expect(readBuildGuid(data)).toBe('fixture-guid');
    fs.writeFileSync(join(data, 'resources.assets'), serializedFile([
      { classId: 49, text: `<?xml version="1.0"?><!-- build fixture --><Objects>${object('42')}</Objects><!-- end -->` },
      { classId: 49, text: `<?xml version="1.0"?><Objects>${object('1')}</Objects>` },
    ]));
    const out = join(dir, 'catalog.json');
    generateCatalog(['--game-dir', dir, '--out', out]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ gameBuild: 'fixture-guid', items: [{ type: 1 }, { type: 42 }] });
    expect(fs.readdirSync(data).sort()).toEqual(['boot.config', 'resources.assets']);
    fs.writeFileSync(join(data, 'boot.config'), 'other=value');
    expect(() => readBuildGuid(data)).toThrow(/build-guid/);
  });
});
