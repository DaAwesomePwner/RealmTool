import { spawnSync } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface Snapshot { exists: boolean; files: Record<string, { size: number; mtimeMs: number }> }
export interface KnownFolderSnapshot { path: string; snapshot: Snapshot }

/** Empty directory creation is harmless; every file creation/change/deletion fails. */
export function compareSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const old = before.files[path], current = after.files[path];
    if (!old) changes.push(`created ${path}`);
    else if (!current) changes.push(`deleted ${path}`);
    else if (old.size !== current.size || old.mtimeMs !== current.mtimeMs) changes.push(`modified ${path}`);
  }
  return changes;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

interface EntryStat { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number }
/** The two calls the walk needs; injectable so tests can make entries vanish mid-walk. */
export interface SnapshotFs { lstat(path: string): Promise<EntryStat>; readdir(path: string): Promise<string[]> }
const nodeFs: SnapshotFs = { lstat: path => lstat(path), readdir: path => readdir(path) };

export async function snapshotDirectory(root: string, fs: SnapshotFs = nodeFs): Promise<Snapshot> {
  const files: [string, { size: number; mtimeMs: number }][] = [];
  async function walk(path: string, relative: string): Promise<void> {
    // WebView2 removes files such as EBWebView/lockfile while it exits; an entry that vanishes
    // between readdir and lstat is simply absent from this snapshot (comparisons still see it).
    let stat: EntryStat;
    try { stat = await fs.lstat(path); } catch (error) { if (relative && missing(error)) return; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Cannot safely snapshot profile link: ${path}`);
    if (stat.isDirectory()) {
      let names: string[];
      try { names = await fs.readdir(path); } catch (error) { if (relative && missing(error)) return; throw error; }
      for (const name of names.sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) files.push([relative, { size: stat.size, mtimeMs: stat.mtimeMs }]);
    else throw new Error(`Unexpected profile entry: ${path}`);
  }
  try { await fs.lstat(root); }
  catch (error) {
    if (missing(error)) return { exists: false, files: {} };
    throw error;
  }
  await walk(root, '');
  return { exists: true, files: Object.fromEntries(files) };
}

export async function snapshotKnownFolders(): Promise<KnownFolderSnapshot[]> {
  // Deliberately resolve via the Windows known-folder API before overriding env.
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @{ local=[Environment]::GetFolderPath('LocalApplicationData'); roaming=[Environment]::GetFolderPath('ApplicationData') } | ConvertTo-Json -Compress"],
  { encoding: 'utf8', timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Known-folder lookup failed: ${result.stderr}`);
  const folders = JSON.parse(result.stdout);
  if (typeof folders.local !== 'string' || !isAbsolute(folders.local)
    || typeof folders.roaming !== 'string' || !isAbsolute(folders.roaming)) throw new Error('Invalid Windows known folders');
  const paths = [join(folders.local, 'net.realmtool.app'), join(folders.roaming, 'RealmTool')];
  return Promise.all(paths.map(async path => ({ path, snapshot: await snapshotDirectory(path) })));
}

export async function verifyIsolation(before: KnownFolderSnapshot[], root: string, requireWebViewData: boolean): Promise<void> {
  const changes: string[] = [];
  for (const folder of before) {
    for (const change of compareSnapshots(folder.snapshot, await snapshotDirectory(folder.path))) changes.push(`${folder.path}: ${change}`);
  }
  if (changes.length) throw new Error(`Known-folder isolation violated (only empty directories may be created):\n${changes.join('\n')}`);
  if (requireWebViewData) {
    const webview = await snapshotDirectory(join(root, 'webview/EBWebView'));
    if (!webview.exists || !Object.keys(webview.files).length) {
      throw new Error('No WebView2 data in temporary WEBVIEW2_USER_DATA_FOLDER/EBWebView; environment override not proven');
    }
  }
}
