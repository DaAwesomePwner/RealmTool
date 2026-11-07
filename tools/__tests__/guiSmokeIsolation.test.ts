import { afterEach, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSnapshots, snapshotDirectory, verifyIsolation, type Snapshot } from '../gui-smoke/isolation.ts';

const roots: string[] = [];
const empty: Snapshot = { exists: true, files: {} };
const original: Snapshot = { exists: true, files: { 'config.json': { size: 10, mtimeMs: 123 } } };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('allows absent folders to remain absent or become empty', () => {
  expect(compareSnapshots({ exists: false, files: {} }, empty)).toEqual([]);
  expect(compareSnapshots({ exists: false, files: {} }, { exists: false, files: {} })).toEqual([]);
  expect(compareSnapshots(original, structuredClone(original))).toEqual([]);
});

it('detects created, deleted, resized and same-size modified files', () => {
  expect(compareSnapshots(empty, original)).toEqual(['created config.json']);
  expect(compareSnapshots(original, empty)).toEqual(['deleted config.json']);
  expect(compareSnapshots(original, { exists: true, files: { 'config.json': { size: 11, mtimeMs: 123 } } })).toEqual(['modified config.json']);
  expect(compareSnapshots(original, { exists: true, files: { 'config.json': { size: 10, mtimeMs: 124 } } })).toEqual(['modified config.json']);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'realmtool-gui-isolation-')); roots.push(root);
  return { root, known: join(root, 'known-folder') };
}

it('snapshots nested files but allows empty directory creation', async () => {
  const { known } = await fixture(); const before = await snapshotDirectory(known);
  expect(before.exists).toBe(false);
  await mkdir(join(known, 'nested'), { recursive: true });
  expect(compareSnapshots(before, await snapshotDirectory(known))).toEqual([]);
  await writeFile(join(known, 'nested/file'), 'data');
  expect(compareSnapshots(before, await snapshotDirectory(known))).toEqual(['created nested/file']);
});

it('requires actual WebView2 data under the temp root and unchanged known folders', async () => {
  const { root, known } = await fixture();
  const before = [{ path: known, snapshot: await snapshotDirectory(known) }];
  await expect(verifyIsolation(before, root, true)).rejects.toThrow(/temporary.*EBWebView/);
  await mkdir(join(root, 'webview/EBWebView'), { recursive: true });
  await expect(verifyIsolation(before, root, true)).rejects.toThrow(/temporary.*EBWebView/);
  await writeFile(join(root, 'webview/EBWebView/Local State'), '{}');
  await expect(verifyIsolation(before, root, true)).resolves.toBeUndefined();
  await mkdir(known); await writeFile(join(known, 'unexpected'), 'oops');
  await expect(verifyIsolation(before, root, true)).rejects.toThrow(/Known-folder isolation violated.*created unexpected/s);
});

it('rechecks known folders even after temp data was already verified and removed', async () => {
  const { root, known } = await fixture();
  const before = [{ path: known, snapshot: await snapshotDirectory(known) }];
  await expect(verifyIsolation(before, root, false)).resolves.toBeUndefined();
  await mkdir(known); await writeFile(join(known, 'bad'), 'oops');
  await expect(verifyIsolation(before, root, false)).rejects.toThrow('created bad');
});

it('skips entries that vanish mid-walk (WebView2 lockfile) but still fails on other errors', async () => {
  const { known } = await fixture();
  await mkdir(join(known, 'EBWebView'), { recursive: true });
  await writeFile(join(known, 'EBWebView/Local State'), '{}'); await writeFile(join(known, 'EBWebView/lockfile'), '');
  const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' });
  const vanishing = { readdir, lstat: async (path: string) => {
    if (path.endsWith('lockfile')) throw enoent;
    return lstat(path);
  } };
  expect(Object.keys((await snapshotDirectory(known, vanishing as never)).files)).toEqual(['EBWebView/Local State']);
  const denied = { readdir, lstat: async (path: string) => {
    if (path.endsWith('lockfile')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return lstat(path);
  } };
  await expect(snapshotDirectory(known, denied as never)).rejects.toThrow('denied');
  const rootGone = { readdir, lstat: async () => { throw enoent; } };
  await expect(snapshotDirectory(known, rootGone as never)).resolves.toEqual({ exists: false, files: {} });
});
