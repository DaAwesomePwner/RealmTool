import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { consumablesFromObjectsXml } from '../catalogs/consumables.ts';
import { extractXmlTextAssets, readBuildGuid } from '../catalogs/unityText.ts';
import { generateCatalog } from '../gen-catalogs.ts';
import { loadConsumables } from '../../src/data/consumables.ts';

const dirs: string[] = [];
function temp() { const dir = fs.mkdtempSync(join(tmpdir(), 'gen-catalog-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const object = (type: string) => `<Object type='${type}'><Consumable/><Activate amount='20'>Heal</Activate></Object>`;

// Synthetic SerializedFile v22: little-endian metadata, no type tree, two class IDs.
function serializedFile(entries: { classId: number; text: string }[], typeTree = false): Buffer {
  const header = Buffer.alloc(48);
  header.writeUInt32BE(22, 8);
  const chunks: Buffer[] = [];
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  chunks.push(Buffer.from('fixture\0'), int(19), Buffer.from([typeTree ? 1 : 0]), int(2));
  for (const id of [49, 28]) {
    chunks.push(int(id), Buffer.alloc(19));
    if (typeTree) chunks.push(int(1), int(4), Buffer.alloc(32), Buffer.from('str\0'), int(1), int(0));
  }
  chunks.push(int(entries.length));
  const data: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const position = 48 + chunks.reduce((n, b) => n + b.length, 0);
    chunks.push(Buffer.alloc((4 - position % 4) % 4));
    const text = Buffer.from(entry.text);
    const payload = Buffer.concat([int(4), Buffer.from('name'), int(text.length), text]);
    const row = Buffer.alloc(24);
    row.writeBigInt64LE(BigInt(data.length + 1));
    row.writeBigInt64LE(BigInt(offset), 8);
    row.writeUInt32LE(payload.length, 16);
    row.writeInt32LE(entry.classId === 49 ? 0 : 1, 20);
    chunks.push(row);
    const padded = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4)]);
    data.push(padded);
    offset += padded.length;
  }
  const meta = Buffer.concat(chunks);
  header.writeUInt32BE(meta.length, 20);
  header.writeBigUInt64BE(BigInt(48 + meta.length + offset), 24);
  header.writeBigUInt64BE(BigInt(48 + meta.length), 32);
  return Buffer.concat([header, meta, ...data]);
}

describe('catalog generation', () => {
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
