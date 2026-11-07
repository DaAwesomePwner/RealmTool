import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { isGameRunning } from '../gameProcess.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(execFile).mockReset(); });

describe('game process check', () => {
  it('does not enumerate on unsupported platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(await isGameRunning()).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each([
    [null, '"RotMG Exalt.exe","123","Console","1","42 K"', true],
    [null, 'INFO: no tasks match', false],
    [new Error('timeout'), '', null],
  ])('handles bounded tasklist results', async (error, stdout, expected) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args[3](error, stdout);
      return {} as ReturnType<typeof execFile>;
    });
    expect(await isGameRunning()).toBe(expected);
    expect(execFile).toHaveBeenCalledWith('tasklist.exe',
      ['/FI', 'IMAGENAME eq RotMG Exalt.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, expect.any(Function));
  });
});
