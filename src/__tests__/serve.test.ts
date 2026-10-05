import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../cli.ts';
import { AppController, type AppState } from '../app/controller.ts';
import type { StoredLog } from '../util/logStore.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { log } from '../util/log.ts';

it('serve prints READY before background auto-start completes and keeps the API up after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-serve-'));
  const token = 'c'.repeat(43);
  vi.stubEnv('APPDATA', root); vi.stubEnv('REALMTOOL_API_TOKEN', token);
  vi.stubEnv('REALMTOOL_UI_ORIGINS', 'http://tauri.localhost');
  new AppConfigStore(join(root, 'RealmTool')).update({ gameDir: join(root, 'missing-game') });
  log.setConsole(false); const detach = log.addSink(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let ready = '', release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any, ...args: any[]) => {
    if (String(chunk).startsWith('REALMTOOL_READY ')) { ready += String(chunk); return true; }
    return (originalWrite as any)(chunk, ...args);
  }) as typeof process.stdout.write);
  const originalStart = AppController.prototype.startProxy;
  const start = vi.spyOn(AppController.prototype, 'startProxy').mockImplementation(async function (this: AppController) {
    expect(ready).toMatch(/^REALMTOOL_READY /); await gate; return originalStart.call(this);
  });
  const launch = vi.spyOn(AppController.prototype, 'launchGame');
  const running = main(['serve']);
  let port: number | undefined;
  try {
    await vi.waitFor(() => expect(ready).toMatch(/^REALMTOOL_READY \{"port":\d+\}\n$/));
    port = JSON.parse(ready.slice('REALMTOOL_READY '.length)).port;
    const url = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect(process.env.REALMTOOL_API_TOKEN).toBeUndefined();
    expect((await fetch(`${url}/api/state`, { headers })).status).toBe(200);
    release();
    await vi.waitFor(async () => {
      const state = await (await fetch(`${url}/api/state`, { headers })).json() as AppState;
      expect(state.proxy).toMatchObject({ state: 'failed', error: expect.stringContaining('RotMG Exalt.exe') });
    });
    expect(start).toHaveBeenCalledOnce(); expect(launch).not.toHaveBeenCalled();
    const logs = await (await fetch(`${url}/api/logs?since=0`, { headers })).json() as { records: StoredLog[] };
    expect(logs.records).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('RotMG Exalt.exe') }));
    const before = logs.records.at(-1)?.seq ?? 0;
    log.info('ServeTest', 'single API record');
    const updated = await (await fetch(`${url}/api/logs?since=${before}`, { headers })).json() as { records: StoredLog[]; next: number };
    expect(updated.records).toHaveLength(1);
    expect(updated.records[0]).toMatchObject({ seq: before + 1, message: 'single API record' });
    expect(updated.next).toBe(before + 1);
    const res = await fetch(`${url}/api/shutdown`, { method: 'POST', headers, body: '{}' });
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true });
    expect(await running).toBe(0); expect(ready).not.toContain(token);
  } finally {
    release();
    if (port) {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    }
    await running;
    detach(); log.setConsole(true); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
