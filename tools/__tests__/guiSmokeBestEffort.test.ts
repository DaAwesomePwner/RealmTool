import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiagnostics, diagnosticAttempt } from '../gui-smoke/diagnostics.ts';
import { withApp } from '../gui-smoke/process.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const inventory = async () => ({ processes: [], listeners: [], errors: [], sessionId: 1, rootAlive: false, exitCode: null });

it.each([false, true])('records a failed metadata query without changing smoke success/failure: %s', async fail => {
  const root = await mkdtemp(join(tmpdir(), 'gui-metadata-')); roots.push(root);
  await writeFile(join(root, 'app-output.log'), 'output');
  const directory = join(root, 'diagnostics');
  const diagnosticErrors: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('real CDP failure');
  const result = withApp(async () => {
    const date = await diagnosticAttempt('launch creation date', async () => { throw new Error('CIM timeout'); }, diagnosticErrors);
    expect(date).toBeUndefined();
    if (fail) throw failure;
  }, {
    diagnose: () => captureDiagnostics({ root, directory, exe: 'app.exe', pid: 10, port: 9241, diagnosticErrors }, inventory),
    stop: async () => {}, remove: async () => {},
  });
  if (fail) await expect(result).rejects.toBe(failure); else await expect(result).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('launch creation date: Error: CIM timeout'));
  expect(await readFile(join(directory, 'collector-error.txt'), 'utf8')).toContain('CIM timeout');
  expect(JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8')).diagnosticErrors).toEqual(diagnosticErrors);
});

it('returns successful diagnostic metadata and tolerates failure to persist it', async () => {
  const errors: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await diagnosticAttempt('query', async () => '2026-10-14', errors)).toBe('2026-10-14');
  await expect(diagnosticAttempt('save launch metadata', async () => { throw new Error('disk full'); }, errors))
    .resolves.toBeUndefined();
  expect(errors).toEqual(['save launch metadata: Error: disk full']);
});

it.each(['directory', 'error-report', 'completion'])('does not reject when diagnostic %s writes fail', async target => {
  const root = await mkdtemp(join(tmpdir(), 'gui-metadata-')); roots.push(root);
  const directory = join(root, 'diagnostics');
  await writeFile(join(root, 'app-output.log'), 'output');
  if (target === 'directory') await writeFile(directory, 'not a directory');
  else {
    await mkdir(directory);
    await mkdir(join(directory, target === 'error-report' ? 'collector-error.txt' : 'complete.json'));
  }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(captureDiagnostics({ root, directory, exe: 'app.exe', pid: 10, port: 9241 }, async () => {
    if (target === 'error-report') throw new Error('collector failed');
    return inventory();
  })).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('GUI diagnostics incomplete: capture:'));
});
