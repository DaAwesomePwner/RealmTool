import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import plugin from '../index.ts';
import { Records } from '../records.ts';
import { CaptureWriter } from '../writer.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
import { ProfileStore } from '../../../src/config/store.ts';
import { createPacket } from '../../../src/protocol/Packet.ts';
import type { ClientConnection, PluginContext, PacketHook } from '../../../src/plugins/api.ts';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
const client = { playerData: { ownerObjectId: 7, name: 'PRIVATE' } } as ClientConnection;
function status(x: number, objectId = 7, name = 'NEWTICK') {
  const p = createPacket(0, name, 'server'); p.isDefined = true;
  const own = { objectId, position: { x, y: 0, secret: 'PRIVATE' }, data: [] };
  p.data = name === 'UPDATE' ? { newObjs: [{ status: own }] } : { statuses: [own] };
  return p;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
it('refuses saved enabled=true on every host/profile load, then permits a manual enable', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capture-profile-'));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const profile = new ProfileStore({ dir, debounceMs: 0 });
      profile.scheduleSave({ schemaVersion: 1, plugins: { capture: { enabled: true } } }); profile.flush();
      const f = startHost([plugin], { profileDir: dir });
      try {
        expect(f.host.snapshot()[0].enabled).toBe(false);
        expect(f.proxy.interest.observe?.server).not.toContain('AOE');
        f.host.setEnabled('capture', true);
        expect(f.host.snapshot()[0].enabled).toBe(true);
        f.host.flush();
        expect(f.profile.load().plugins.capture).toEqual({ settings: { maxFileMB: 50, includeAllDamage: false } });
      } finally { f.host.stop(); }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
it('samples only own position at >=0.1 tile and >=100ms, without leaking nested fields', () => {
  let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const r = new Records();
  expect(r.record(client, status(99, 8), false)).toBeUndefined();
  expect(r.record(client, status(0), false)?.position).toEqual({ x: 0, y: 0 });
  now = 99; expect(r.record(client, status(1), false)).toBeUndefined();
  now = 100; expect(r.record(client, status(0.09), false)).toBeUndefined();
  expect(r.record(client, status(0.1), false)?.position).toEqual({ x: 0.1, y: 0 });
  now = 200; expect(r.record(client, status(1, 7, 'UPDATE'), false)?.position).toEqual({ x: 1, y: 0 });
  expect(r.disconnect(client)).toBe('c1'); expect(r.id(client)).toBeUndefined();
  expect(r.record(client, status(1), false)?.client).toBe('c2');
});
function fixture() {
  const hooks = new Map<string, PacketHook>(); const events = new Map<string, (c: ClientConnection) => void>();
  const settings = new Map<string, unknown>(); const logs: string[] = [];
  let enabled = false, change = (_v: boolean) => {}, cleanup = () => {};
  const ctx = { get enabled() { return enabled; }, set enabled(v: boolean) { enabled = v; change(v); },
    registerSetting: (k: string, d: { value: unknown }) => settings.set(k, d.value), getSetting: (k: string) => settings.get(k),
    observePacket: (k: string, fn: PacketHook) => hooks.set(k, fn), on: (k: string, fn: (c: ClientConnection) => void) => events.set(k, fn),
    onEnabledChange: (fn: typeof change) => { change = fn; }, registerCleanup: (fn: typeof cleanup) => { cleanup = fn; }, log: (s: string) => logs.push(s),
  } as unknown as PluginContext;
  plugin.register(ctx);
  return { ctx, hooks, events, logs, cleanup: () => cleanup() };
}
it('logs write error codes, and an old writer failure cannot disable a new capture', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capture-error-')); vi.stubEnv('APPDATA', dir);
  let rejectOpen!: (error: Error) => void;
  const spy = vi.spyOn(fs, 'open').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOpen = reject; }));
  const f = fixture();
  try {
    f.ctx.enabled = true;
    f.hooks.get('NEWTICK')!(client, status(0));
    await vi.waitFor(() => expect(rejectOpen).toBeTypeOf('function'));
    f.ctx.enabled = false; f.ctx.enabled = true;
    f.hooks.get('NEWTICK')!(client, status(2));
    rejectOpen(Object.assign(new Error('not logged'), { code: 'EACCES' }));
    await vi.waitFor(() => expect(f.logs.some(s => s.includes('write failed (EACCES)'))).toBe(true));
    expect(f.ctx.enabled).toBe(true);
    f.ctx.enabled = false;
    await vi.waitFor(() => expect(f.logs.some(s => s.startsWith('Capture stopped:'))).toBe(true));
  } finally { f.cleanup(); spy.mockRestore(); await fs.rm(dir, { recursive: true, force: true }); }
});
it('a current writer failure stops capture and reports its code', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capture-error-'));
  try {
    const path = join(dir, 'exists.jsonl'); await fs.writeFile(path, 'original');
    const log = vi.fn(), stop = vi.fn(); const writer = new CaptureWriter(path, 100, log, stop);
    writer.write({ a: 1 }); await writer.close();
    expect(stop).toHaveBeenCalledOnce(); expect(log.mock.calls.flat().join(' ')).toContain('EEXIST');
    expect(await fs.readFile(path, 'utf8')).toBe('original');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
it('periodic summaries omit idle clients and disconnect prunes both maps without reusing IDs', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.spyOn(CaptureWriter.prototype, 'write').mockImplementation(() => {});
  const f = fixture();
  try {
    f.ctx.enabled = true;
    f.hooks.get('NEWTICK')!(client, status(0));
    vi.advanceTimersByTime(60_000);
    expect(f.logs.filter(s => s.includes('heuristic'))).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(f.logs.filter(s => s.includes('heuristic'))).toHaveLength(1);
    f.events.get('clientDisconnected')!(client);
    expect(f.logs.filter(s => s.includes('heuristic'))).toHaveLength(2);
    f.ctx.enabled = false; // No disconnected client remains for this final summary.
    expect(f.logs.filter(s => s.includes('heuristic'))).toHaveLength(2);
  } finally { f.cleanup(); }
});
