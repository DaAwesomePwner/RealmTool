import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
const NODE_VERSION = '24.21.0';

describe('verified Node runtime download', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let badHash: boolean;
  let downloads: number;
  const binary = Buffer.from('local fixture node executable');
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'realmtool-node-'));
    badHash = false;
    downloads = 0;
    server = createServer((req, res) => {
      if (req.url === `/v${NODE_VERSION}/SHASUMS256.txt`) {
        res.end(`${badHash ? '0'.repeat(64) : createHash('sha256').update(binary).digest('hex')}  win-x64/node.exe\n`);
      } else if (req.url === `/v${NODE_VERSION}/win-x64/node.exe`) {
        downloads++;
        res.end(binary);
      } else { res.writeHead(404).end(); }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  it('accepts a good hash and reuses the verified cached copy', async () => {
    const { fetchNode } = await import('../fetch-node.ts');
    await fetchNode({ root, baseUrl });
    await fetchNode({ root, baseUrl });
    expect(downloads).toBe(1);
    expect(readFileSync(join(root, 'dist/runtime/node.exe'))).toEqual(binary);
    expect(readFileSync(join(root, `.cache/node/${NODE_VERSION}/node.exe`))).toEqual(binary);
    expect(existsSync(join(root, `.cache/node/${NODE_VERSION}/SHASUMS256.txt`))).toBe(true);
  });
  it('rejects a bad hash without leaving a runtime executable', async () => {
    const { fetchNode } = await import('../fetch-node.ts');
    badHash = true;
    await expect(fetchNode({ root, baseUrl })).rejects.toThrow(/SHA-256/i);
    expect(existsSync(join(root, 'dist/runtime/node.exe'))).toBe(false);
  });
  it('redownloads a cached executable that was corrupted', async () => {
    const { fetchNode } = await import('../fetch-node.ts');
    await fetchNode({ root, baseUrl });
    writeFileSync(join(root, `.cache/node/${NODE_VERSION}/node.exe`), 'corrupt');
    await fetchNode({ root, baseUrl });
    expect(downloads).toBe(2);
    expect(readFileSync(join(root, 'dist/runtime/node.exe'))).toEqual(binary);
  });
});
