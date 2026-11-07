import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { gameProcessIds } from '../gameProcess.ts';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(execFile).mockReset(); });

describe('game process check', () => {
  it('does not enumerate on unsupported platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(await gameProcessIds()).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each([
    [null, '"RotMG Exalt.exe","123","Console","1","42 K"', [123]],
    [null, 'INFO: no tasks match', []],
    [new Error('timeout'), '', null],
  ])('handles bounded tasklist results', async (error, stdout, expected) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('SystemRoot', 'D:\\Windows');
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args[3](error, stdout);
      return {} as ReturnType<typeof execFile>;
    });
    expect(await gameProcessIds()).toEqual(expected);
    expect(execFile).toHaveBeenCalledWith('D:\\Windows\\System32\\tasklist.exe',
      ['/FI', 'IMAGENAME eq RotMG Exalt.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, expect.any(Function));
  });
  it.each([
    ['D:\\Windows', 'E:\\Windows', 'D:\\Windows'],
    [undefined, 'E:\\Windows', 'E:\\Windows'],
    ['', 'E:\\Windows', 'E:\\Windows'],
    [undefined, undefined, 'C:\\Windows'],
    ['', '', 'C:\\Windows'],
  ])('resolves SystemRoot=%s before windir=%s then the fallback', async (systemRoot, windir, expected) => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('SystemRoot', systemRoot);
    vi.stubEnv('windir', windir);
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      args[3](null, ''); return {} as ReturnType<typeof execFile>;
    });
    expect(await gameProcessIds()).toEqual([]);
    expect(vi.mocked(execFile).mock.calls[0][0]).toBe(expected + '\\System32\\tasklist.exe');
  });

});
