import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApp } from '../gui-smoke/process.ts';

it.each([false, true])('collects evidence before kill even when work fails: %s', async fail => {
  const events: string[] = [];
  const result = withApp(async () => { events.push('work'); if (fail) throw new Error('CDP unavailable'); }, {
    diagnose: async () => { events.push('diagnose'); },
    stop: async () => { events.push('kill'); },
    verify: async () => { events.push('verify'); },
    remove: async () => { events.push('remove'); },
  });
  if (fail) await expect(result).rejects.toThrow('CDP unavailable'); else await result;
  expect(events).toEqual(['work', 'diagnose', 'kill', 'verify', 'remove']);
});

it('preserves the startup error and all cleanup guarantees when diagnostics fails', async () => {
  const events: string[] = [];
  const result = withApp(async () => { throw new Error('startup'); }, {
    diagnose: async () => { throw new Error('capture failed'); },
    stop: async () => { events.push('kill'); throw new Error('kill failed'); },
    verify: async () => { events.push('verify'); throw new Error('isolation'); },
    remove: async () => { events.push('remove'); },
  });
  await expect(result).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error), expect.any(Error), expect.any(Error)] });
  expect(events).toEqual(['kill', 'verify', 'remove']);
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('selects descendants independent of order, including an exited parent, without unrelated listeners', async () => {
  const { summarizeProcesses } = await import('../gui-smoke/diagnostics.ts');
  const inventory = [
    { ProcessId: 12, ParentProcessId: 11, Name: 'msedgewebview2.exe', CommandLine: '--user-data-dir=temp --remote-debugging-port=9241' },
    { ProcessId: 50, ParentProcessId: 1, Name: 'realmtool-shell.exe', CommandLine: 'installed app' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'msedgewebview2.exe', CommandLine: 'browser' },
    { ProcessId: 99, ParentProcessId: 1, Name: 'other.exe', CommandLine: 'unrelated' },
  ];
  const report = summarizeProcesses(inventory, [
    { OwningProcess: 12, LocalPort: 9241 }, { OwningProcess: 99, LocalPort: 4444 },
    { OwningProcess: 50, LocalPort: 2050 },
  ], 10);
  expect(report.tree.map(p => p.ProcessId)).toEqual([12, 11]);
  expect(report.tree[0].CommandLine).toContain('--remote-debugging-port=9241');
  expect(report.listeners).toEqual([{ OwningProcess: 12, LocalPort: 9241 }]);
  expect(report.otherAppProcesses.map(p => p.ProcessId)).toEqual([50]);
  expect(summarizeProcesses(inventory, [], null).tree).toEqual([]);
});

it('bounds the printed log tail by bytes and lines without changing the source', async () => {
  const { readTail } = await import('../gui-smoke/diagnostics.ts');
  const root = await mkdtemp(join(tmpdir(), 'gui-diagnostics-')); roots.push(root);
  const path = join(root, 'app.log'); const contents = 'x'.repeat(100_000) + '\nold\nnew\nlast\n';
  await writeFile(path, contents);
  expect(await readTail(path, 2, 1024)).toBe('new\nlast');
  expect(await readFile(path, 'utf8')).toBe(contents);
});

it('retains output and exit status even when the Windows collector fails', async () => {
  const { captureDiagnostics } = await import('../gui-smoke/diagnostics.ts');
  const root = await mkdtemp(join(tmpdir(), 'gui-diagnostics-')); roots.push(root);
  const output = join(root, 'app-output.log'); await writeFile(output, 'panic: window build failed\n');
  const directory = join(root, 'evidence');
  await expect(captureDiagnostics({ root, directory, pid: 123, exe: 'app.exe', port: 9241,
    child: { exitCode: 101, signalCode: null },
  }, async () => { throw new Error('CIM unavailable'); })).rejects.toThrow('CIM unavailable');
  expect(await readFile(join(directory, 'app-output.log'), 'utf8')).toContain('panic');
  expect(JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'))).toMatchObject({
    pid: 123, alive: false, exitCode: 101,
  });
  expect(await readFile(join(directory, 'collector-error.txt'), 'utf8')).toContain('CIM unavailable');
});

it('keeps evidence outside the disposable profile and excludes inherited secrets', async () => {
  const { captureDiagnostics } = await import('../gui-smoke/diagnostics.ts');
  const base = await mkdtemp(join(tmpdir(), 'gui-diagnostics-')); roots.push(base);
  const root = join(base, 'profile'); const directory = join(base, 'evidence');
  const { mkdir } = await import('node:fs/promises'); await mkdir(root);
  await writeFile(join(root, 'app-output.log'), 'app output');
  await captureDiagnostics({ root, directory, exe: 'app.exe', pid: 10, port: 9241,
    child: { exitCode: 0, signalCode: null }, environment: { APPDATA: 'temp', GITHUB_TOKEN: 'secret' },
  }, async () => ({ processes: [], listeners: [], errors: [], sessionId: 1, rootAlive: false, exitCode: null }));
  await rm(root, { recursive: true });
  const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'));
  expect(launch).toMatchObject({ alive: false, exitCode: 0, environment: { APPDATA: 'temp' } });
  expect(launch.environment.GITHUB_TOKEN).toBeUndefined();
  expect(await readFile(join(directory, 'app-output.log'), 'utf8')).toBe('app output');
  expect(JSON.parse(await readFile(join(directory, 'complete.json'), 'utf8')).capturedAt).toEqual(expect.any(String));
});

it('retains partial process evidence and reports individual Windows capture failures', async () => {
  const { captureDiagnostics } = await import('../gui-smoke/diagnostics.ts');
  const root = await mkdtemp(join(tmpdir(), 'gui-diagnostics-')); roots.push(root);
  await writeFile(join(root, 'app-output.log'), 'output'); const directory = join(root, 'evidence');
  await expect(captureDiagnostics({ root, directory, pid: null, exe: 'app.exe', port: 9241 }, async () => ({
    processes: [], listeners: [], errors: ['desktop: locked session'], sessionId: 1, rootAlive: false, exitCode: null,
  }))).rejects.toThrow('desktop: locked session');
  expect(JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8')).errors).toEqual(['desktop: locked session']);
  await expect(readFile(join(directory, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
