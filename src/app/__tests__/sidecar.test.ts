import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runSidecar } from '../sidecar.ts';
import { AppController } from '../controller.ts';
import { log } from '../../util/log.ts';

let root: string, detach: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realmtool-sidecar-')); vi.stubEnv('APPDATA', root);
  log.setConsole(false); detach = log.addSink(() => {});
});
afterEach(() => {
  detach(); log.setConsole(true); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each([undefined, 'short', '!'.repeat(43)])('rejects invalid token %s without READY', async token => {
  const env = { REALMTOOL_API_TOKEN: token }, stdout = new PassThrough();
  const write = vi.spyOn(stdout, 'write'), startApi = vi.fn();
  expect(await runSidecar({ env, stdin: new PassThrough(), stdout, startApi })).toBe(2);
  expect(env.REALMTOOL_API_TOKEN).toBeUndefined(); expect(write).not.toHaveBeenCalled(); expect(startApi).not.toHaveBeenCalled();
});

it.each(['stdin', 'api', 'SIGINT', 'SIGTERM'])('prints one safe READY and shuts down on %s', async trigger => {
  const token = 'a'.repeat(43), env = { APPDATA: root, REALMTOOL_API_TOKEN: token, REALMTOOL_UI_ORIGINS: 'http://tauri.localhost,tauri://localhost' };
  const stdin = new PassThrough(), stdout = new PassThrough(), close = vi.fn(async () => {});
  const shutdown = vi.spyOn(AppController.prototype, 'shutdown');
  let output = '', controller!: AppController;
  stdout.on('data', chunk => { output += chunk.toString(); });
  const startApi = vi.fn(async (app: AppController, received: string, origins: string[]) => {
    controller = app; expect(received).toBe(token); expect(env.REALMTOOL_API_TOKEN).toBeUndefined();
    expect(origins).toEqual(['http://tauri.localhost', 'tauri://localhost']);
    return { port: 12345, close };
  });
  const running = runSidecar({ env, stdin, stdout, startApi });
  await vi.waitFor(() => expect(output).toBe('REALMTOOL_READY {"port":12345}\n'));
  if (trigger === 'stdin') stdin.end();
  else if (trigger === 'api') await controller.shutdown();
  else process.emit(trigger as 'SIGINT');
  expect(await running).toBe(0); expect(shutdown).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  expect(output).toBe('REALMTOOL_READY {"port":12345}\n'); expect(output).not.toContain(token);
});

it('cleans up and returns an exit code when API close fails without exposing its error', async () => {
  const token = 'b'.repeat(43), env = { APPDATA: root, REALMTOOL_API_TOKEN: token };
  const stdin = new PassThrough(), stdout = new PassThrough();
  let output = ''; stdout.on('data', chunk => { output += chunk.toString(); });
  const running = runSidecar({ env, stdin, stdout, startApi: async () => ({ port: 12345, close: async () => { throw new Error(token); } }) });
  await vi.waitFor(() => expect(output).toContain('READY'));
  stdin.end(); expect(await running).toBe(1); expect(output).not.toContain(token);
});
