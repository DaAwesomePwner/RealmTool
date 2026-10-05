import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { refreshCatalogs } from '../refreshData.ts';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetAllMocks(); });
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
  return child;
}
it('uses a separate hidden process, scrubs the token, and drains both output pipes', async () => {
  vi.stubEnv('REALMTOOL_API_TOKEN', 'private-test-token');
  const child = fixture(), result = { gameBuild: 'A', items: 1, projectiles: 2, tiles: 3, ms: 4 };
  const pending = refreshCatalogs('game folder', 'output folder');
  expect(spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], 'refresh-data', '--parent-pipe', '--game-dir', 'game folder', '--out-dir', 'output folder'],
    expect.objectContaining({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
  expect(vi.mocked(spawn).mock.calls[0][2]!.env!.REALMTOOL_API_TOKEN).toBeUndefined();
  child.stderr.write('diagnostic'); child.stdout.write(JSON.stringify(result)); child.emit('close', 0);
  await expect(pending).resolves.toEqual(result);
});
it('kills timed out children and waits for close before rejecting', async () => {
  vi.useFakeTimers(); const child = fixture(), pending = refreshCatalogs('game', 'out');
  const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(120_000); expect(child.kill).toHaveBeenCalledOnce();
  child.emit('close', 1); await rejected;
});
it('reports a failed child and malformed success output', async () => {
  const child = fixture(), pending = refreshCatalogs('game', 'out');
  child.stderr.write('fixture failed'); child.emit('close', 1);
  await expect(pending).rejects.toThrow('fixture failed');
  const second = fixture(), malformed = refreshCatalogs('game', 'out');
  second.stdout.write('{}'); second.emit('close', 0); await expect(malformed).rejects.toThrow('Invalid game data refresh result');
});

it('aborts a refresh immediately, kills the child and retains its close handler for reaping', async () => {
  const child = fixture(), abort = new AbortController();
  const pending = refreshCatalogs('game', 'out', abort.signal);
  const rejected = expect(pending).rejects.toThrow(/cancel|abort/i);
  abort.abort();
  expect(child.kill).toHaveBeenCalledOnce(); expect(child.stdin.destroyed).toBe(true);
  expect(child.listenerCount('close')).toBeGreaterThan(0);
  await rejected; child.emit('close', 1);
});
