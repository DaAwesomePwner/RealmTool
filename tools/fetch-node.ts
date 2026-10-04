import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const NODE_VERSION = '24.21.0';
export const NODE_DIST = 'https://nodejs.org/dist';

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchNode(options: { root?: string; baseUrl?: string } = {}): Promise<void> {
  const root = options.root ?? fileURLToPath(new URL('../', import.meta.url));
  const cache = join(root, '.cache/node', NODE_VERSION);
  const runtime = join(root, 'dist/runtime');
  const output = join(runtime, 'node.exe');
  const binary = join(cache, 'node.exe');
  const sums = join(cache, 'SHASUMS256.txt');
  const base = `${(options.baseUrl ?? NODE_DIST).replace(/\/$/, '')}/v${NODE_VERSION}`;
  mkdirSync(cache, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  // A failed verification must never leave a previously staged runtime usable.
  rmSync(output, { force: true });
  if (!existsSync(sums)) writeFileSync(sums, await download(`${base}/SHASUMS256.txt`));
  const lines = readFileSync(sums, 'utf8').split(/\r?\n/);
  const hashes = lines.map(line => /^([a-fA-F0-9]{64})\s+\*?win-x64\/node\.exe\s*$/.exec(line)).filter(match => match !== null);
  if (hashes.length !== 1) throw new Error('Missing or ambiguous SHA-256 for win-x64/node.exe');
  const expected = hashes[0][1].toLowerCase();
  const valid = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex') === expected;
  if (!existsSync(binary) || !valid(readFileSync(binary))) {
    rmSync(binary, { force: true });
    const bytes = await download(`${base}/win-x64/node.exe`);
    if (!valid(bytes)) throw new Error('Node SHA-256 verification failed');
    writeFileSync(`${binary}.tmp`, bytes);
    renameSync(`${binary}.tmp`, binary);
  }
  copyFileSync(binary, `${output}.tmp`);
  renameSync(`${output}.tmp`, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string' } } });
  await fetchNode({ baseUrl: values['base-url'] });
}
