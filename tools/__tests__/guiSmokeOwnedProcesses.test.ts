import { expect, it, vi } from 'vitest';
import { cleanupBuildProcesses, sameExecutablePath, stopBuildProcess } from '../gui-smoke/owned-process.ts';

const exe = 'C:\\work\\RealmTool\\target\\gui\\debug\\realmtool-shell.exe';
it.each([
  ['c:/work/realmtool/target/gui/debug/REALMTOOL-SHELL.EXE', true],
  ['C:\\work\\RealmTool\\target\\gui\\debug\\..\\debug\\realmtool-shell.exe', true],
  ['C:\\work\\RealmTool\\target\\build\\debug\\realmtool-shell.exe', false],
  ['C:\\installed\\realmtool-shell.exe', false],
  ['C:\\installed\\RealmTool.exe', false],
  ['C:\\work\\RealmTool\\target\\gui-other\\debug\\realmtool-shell.exe', false],
  ['realmtool-shell.exe', false], [null, false],
])('matches only the normalized complete build path: %s', (path, expected) => {
  expect(sameExecutablePath(path, exe)).toBe(expected);
});

it('cleans all build-path leftovers without depending on user, session or creation time', async () => {
  const removed: number[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await cleanupBuildProcesses(exe, async () => [
      { ProcessId: 10, ExecutablePath: exe, CreationDate: '2020-01-01T00:00:00Z' },
      { ProcessId: 11, ExecutablePath: exe.toUpperCase() },
      { ProcessId: 12, ExecutablePath: 'C:\\installed\\RealmTool.exe' },
      { ProcessId: 13, ExecutablePath: 'C:\\installed\\realmtool-shell.exe' },
    ], async pid => { removed.push(pid); });
    expect(removed).toEqual([10, 11]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PID 10'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PID 11'));
  } finally { warn.mockRestore(); }
});

it('checks PID and exact path again before killing, leaving other installations alone', async () => {
  const terminate = vi.fn(async () => {});
  await stopBuildProcess(10, exe, async () => ({ ProcessId: 10, ExecutablePath: 'C:\\installed\\RealmTool.exe' }), terminate);
  await stopBuildProcess(10, exe, async () => undefined, terminate);
  expect(terminate).not.toHaveBeenCalled();
  await stopBuildProcess(10, exe, async () => ({ ProcessId: 10, ExecutablePath: exe }), terminate);
  expect(terminate).toHaveBeenCalledWith(10);
});

it('throws when tree kill fails and the build-path process remains, but tolerates an exit race', async () => {
  const process = { ProcessId: 10, ExecutablePath: exe };
  const terminate = async () => { throw new Error('taskkill denied'); };
  await expect(stopBuildProcess(10, exe, async () => process, terminate)).rejects.toThrow('taskkill denied');
  let queries = 0;
  await expect(stopBuildProcess(10, exe, async () => ++queries === 1 ? process : undefined, terminate)).resolves.toBeUndefined();
});
