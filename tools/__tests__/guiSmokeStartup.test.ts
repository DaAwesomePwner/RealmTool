import { expect, it, vi, afterEach } from 'vitest';
import { waitForTarget } from '../gui-smoke/cdp.ts';
import { assertAppRunning, existingInstances, assertNoExistingInstances, checkExistingInstances } from '../gui-smoke/startup.ts';
import { cleanupBuildProcesses } from '../gui-smoke/owned-process.ts';

afterEach(() => vi.useRealTimers());

it('waits for our terminating process before launching, without killing again', async () => {
  vi.useFakeTimers();
  const cleanup = vi.fn(async () => {});
  let remaining = [rows[0]];
  const inspect = vi.fn(async () => ({ processes: remaining, sessionId: 1, userSid: 'S-1' }));
  let finished = false;
  const result = checkExistingInstances(rows[0].ExecutablePath, cleanup, inspect).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(750);
  expect(finished).toBe(false);
  remaining = [];
  await vi.advanceTimersByTimeAsync(250);
  await result;
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(5);
});

it('bounds the wait for an exact-path process that never exits', async () => {
  vi.useFakeTimers();
  const result = expect(checkExistingInstances(rows[0].ExecutablePath, async () => {},
    async () => ({ processes: [rows[0]], sessionId: 1, userSid: 'S-1' })))
    .rejects.toThrow('Timed out waiting for GUI smoke processes to exit: 10');
  await vi.advanceTimersByTimeAsync(10_000);
  await result;
});

it('refuses a different installation appearing while our process exits', async () => {
  vi.useFakeTimers();
  let remaining = [rows[0]];
  const result = expect(checkExistingInstances(rows[0].ExecutablePath, async () => {},
    async () => ({ processes: remaining, sessionId: 1, userSid: 'S-1' }))).rejects.toThrow(/PID 11.*installed/s);
  await vi.advanceTimersByTimeAsync(250);
  remaining = [...rows];
  await vi.advanceTimersByTimeAsync(250);
  await result;
});
const rows = [
  { Name: 'REALMTOOL-SHELL.EXE', ProcessId: 10, SessionId: 1, OwnerSid: 'S-1', ExecutablePath: 'D:\\gui\\app.exe', CreationDate: '2026-10-14T10:00:00Z' },
  { Name: 'RealmTool.exe', ProcessId: 11, SessionId: 1, OwnerSid: 'S-1', ExecutablePath: 'C:\\installed\\RealmTool.exe', CreationDate: '2026-10-14T09:00:00Z' },
];
it('matches both app names only for the current user and session', () => {
  expect(existingInstances([...rows,
    { ...rows[0], ProcessId: 12, SessionId: 2 }, { ...rows[0], ProcessId: 13, OwnerSid: 'S-2' },
    { ...rows[0], ProcessId: 14, Name: 'other.exe' },
  ], 1, 'S-1').map(p => p.ProcessId)).toEqual([10, 11]);
  expect(() => assertNoExistingInstances(rows, 1, 'S-1')).toThrow(/PID 10.*D:\\gui\\app.exe.*2026-10-14T10:00:00Z/s);
  expect(() => assertNoExistingInstances(rows, 1, 'S-1')).toThrow(/PID 11.*C:\\installed\\RealmTool.exe/s);
  expect(() => assertNoExistingInstances(rows, 2, 'S-1')).not.toThrow();
});

it.each([false, true])('cleans our leftover then continues or rejects another installation: %s', async otherInstallation => {
  let remaining = otherInstallation ? [...rows] : [rows[0]];
  const removed: number[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = checkExistingInstances('D:\\gui\\app.exe',
      exe => cleanupBuildProcesses(exe, async () => remaining, async pid => {
        removed.push(pid); remaining = remaining.filter(process => process.ProcessId !== pid);
      }),
      async () => ({ processes: remaining, sessionId: 1, userSid: 'S-1' }));
    if (otherInstallation) await expect(result).rejects.toThrow(/PID 11.*C:\\installed\\RealmTool.exe/s);
    else await expect(result).resolves.toBeUndefined();
    expect(removed).toEqual([10]);
  } finally { warn.mockRestore(); }
});
it.each([0, 101])('fails before discovery for an already exited app (%s)', async code => {
  const discover = vi.fn();
  await expect(waitForTarget(9241, discover, 60_000, () => assertAppRunning({ exitCode: code, signalCode: null })))
    .rejects.toThrow(code === 0 ? /code 0 before CDP; likely a single-instance handoff/ : /code 101 before CDP/);
  expect(discover).not.toHaveBeenCalled();
});
it('detects an exit during discovery instead of waiting 60 seconds', async () => {
  vi.useFakeTimers(); const child = { exitCode: null as number | null, signalCode: null };
  const result = expect(waitForTarget(9241, async () => { throw new Error('fetch failed'); }, 60_000,
    () => assertAppRunning(child))).rejects.toThrow(/code 0 before CDP/);
  await vi.advanceTimersByTimeAsync(100); child.exitCode = 0;
  await vi.advanceTimersByTimeAsync(200); await result;
});

it('bounds a stalled discovery request so app exit is detected promptly', async () => {
  vi.useFakeTimers(); const child = { exitCode: null as number | null, signalCode: null };
  const result = expect(waitForTarget(9241, () => new Promise(() => {}), 60_000,
    () => assertAppRunning(child))).rejects.toThrow(/code 101 before CDP/);
  await vi.advanceTimersByTimeAsync(100); child.exitCode = 101;
  await vi.advanceTimersByTimeAsync(1900); await result;
});
