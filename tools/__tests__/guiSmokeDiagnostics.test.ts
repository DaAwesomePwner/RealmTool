import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApp } from '../gui-smoke/process.ts';

it.each([false, true])('collects evidence before kill even when work fails: %s', async fail => {
  const events: string[] = [];
  const result = withApp(async () => { events.push('work'); if (fail) throw new Error('CDP unavailable'); }, {
    diagnose: async failed => { expect(failed).toBe(fail); events.push('diagnose'); },
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
  await expect(result).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error), expect.any(Error)] });
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
  const report = summarizeProcesses(inventory.map(row => ({ ...row, CreationDate: '2026-10-14T10:01:00Z' })), [
    { OwningProcess: 12, LocalPort: 9241 }, { OwningProcess: 99, LocalPort: 4444 },
    { OwningProcess: 50, LocalPort: 2050 },
  ], 10, '2026-10-14T10:00:00Z');
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
  }, async () => { throw new Error('CIM unavailable'); })).resolves.toBeUndefined();
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
  }))).resolves.toBeUndefined();
  expect(JSON.parse(await readFile(join(directory, 'processes.json'), 'utf8')).errors).toEqual(['desktop: locked session']);
  await expect(readFile(join(directory, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not fail successful work when diagnostics fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(withApp(async () => {}, {
      diagnose: async failed => { expect(failed).toBe(false); throw new Error('capture'); },
      stop: async () => {}, remove: async () => {},
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capture'));
  } finally { warn.mockRestore(); }
});

it('marks attempts before collecting, tolerates missing roots and bounds output artifacts', async () => {
  const { captureDiagnostics } = await import('../gui-smoke/diagnostics.ts');
  const root = await mkdtemp(join(tmpdir(), 'gui-diagnostics-')); roots.push(root);
  const directory = join(root, 'evidence');
  await writeFile(join(root, 'app-output.log'), 'x'.repeat(300_000) + 'end');
  const collect = async () => {
    expect(JSON.parse(await readFile(join(directory, 'attempted.json'), 'utf8')).capturedAt).toEqual(expect.any(String));
    return { processes: [], listeners: [], errors: [], sessionId: 1, rootAlive: false, exitCode: null };
  };
  await captureDiagnostics({ root, directory, pid: null, exe: 'app.exe', port: 9241 }, collect);
  const output = await readFile(join(directory, 'app-output.log'));
  expect(output.length).toBe(256 * 1024); expect(output.toString().endsWith('end')).toBe(true);
  await expect(captureDiagnostics({ root: join(root, 'missing'), directory, pid: null, exe: 'app.exe', port: 9241 }, collect))
    .resolves.toBeUndefined();
});

it('excludes PID reuse ghosts and identifies installed RealmTool processes', async () => {
  const { summarizeProcesses } = await import('../gui-smoke/diagnostics.ts');
  const row = (pid: number, parent: number, date: string, name = 'msedgewebview2.exe') => ({
    ProcessId: pid, ParentProcessId: parent, CreationDate: date, Name: name, CommandLine: '',
  });
  const report = summarizeProcesses([
    row(10, 1, '2026-10-14T10:00:00Z', 'realmtool-shell.exe'),
    row(11, 10, '2026-10-14T09:00:00Z'), row(12, 11, '2026-10-14T11:00:00Z'),
    row(13, 10, '2026-10-14T10:00:00Z'), row(14, 13, '2026-10-14T10:01:00Z'),
    row(50, 1, '2026-10-14T08:00:00Z', 'RealmTool.EXE'),
  ], [], 10);
  expect(report.tree.map(p => p.ProcessId)).toEqual([10, 13, 14]);
  expect(report.otherAppProcesses.map(p => p.ProcessId)).toContain(50);
});

it('does not attribute a reused root PID or its listeners to the launched app', async () => {
  const { summarizeProcesses } = await import('../gui-smoke/diagnostics.ts');
  const report = summarizeProcesses([
    { ProcessId: 10, ParentProcessId: 1, Name: 'RealmTool.exe', CommandLine: '', CreationDate: '2026-10-14T11:00:00Z' },
    { ProcessId: 11, ParentProcessId: 10, Name: 'msedgewebview2.exe', CommandLine: '', CreationDate: '2026-10-14T11:01:00Z' },
  ], [{ OwningProcess: 10, LocalPort: 9241 }], 10, '2026-10-14T10:00:00Z');
  expect(report.tree).toEqual([]); expect(report.listeners).toEqual([]);
});
