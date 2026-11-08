import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Records, PACKETS } from '../records.ts';
import { CaptureWriter } from '../writer.ts';
import { Correlation } from '../correlation.ts';
import plugin from '../index.ts';
import { createPacket } from '../../../src/protocol/Packet.ts';
import type { ClientConnection, PluginContext, PacketHook } from '../../../src/plugins/api.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
const client = { playerData: { ownerObjectId: 7, name: 'PRIVATE_NAME' }, clientId: 'PRIVATE_ACCOUNT' } as ClientConnection;
function packet(name: string, data: Record<string, unknown> = {}) {
  const p = createPacket(0, name, ['AOEACK', 'ESCAPE'].includes(name) ? 'client' : 'server');
  p.data = data; p.isDefined = true; return p;
}
it('strictly selects fields, rejects arbitrary packets, nested secrets and names', () => {
  const r = new Records();
  expect(r.record(client, packet('HELLO', { accessToken: 'SECRET' }), false)).toBeUndefined();
  expect(r.record(client, packet('TEXT', { name: 'PRIVATE_NAME' }), false)).toBeUndefined();
  const common = { name: 'PRIVATE_NAME', accessToken: 'SECRET', host: 'SECRET', key: 'SECRET' };
  const aoe = r.record(client, packet('AOE', { ...common, position: { x: 1, y: 2, name: 'PRIVATE_NAME' }, radius: 3, damage: 4, effect: 5, effectDuration: 6, originType: 7, color: 8, armorPierce: true }), false)!;
  expect(Object.keys(aoe).sort()).toEqual(['client', 'dir', 'type', 't', 'iso', 'position', 'radius', 'damage', 'effect', 'duration', 'origType', 'color', 'seq'].sort());
  expect(aoe.position).toEqual({ x: 1, y: 2 });
  for (const name of ['DEATH', 'RECONNECT', 'ESCAPE']) {
    const record = r.record(client, packet(name, common), false)!;
    expect(Object.keys(record).sort()).toEqual(['client', 'dir', 'type', 't', 'iso'].sort());
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE|SECRET/);
  }
  expect(JSON.stringify(aoe)).not.toMatch(/PRIVATE|SECRET/);
  expect(r.record(client, packet('MAPINFO', { ...common, name: 'Nexus' }), false)).toMatchObject({ name: 'Nexus' });
  expect(r.record(client, packet('CREATESUCCESS', { ...common, objectId: 7 }), false)).toMatchObject({ objectId: 7 });
});
it('filters damage by own ID and retains only permitted scalar fields', () => {
  const r = new Records();
  const damage = { targetId: 8, damageAmount: 10, kill: true, effects: [1, 'SECRET', { name: 'PRIVATE' }], bulletId: 2, objectId: 3, armorPierce: true };
  expect(r.record(client, packet('DAMAGE', damage), false)).toBeUndefined();
  const all = r.record(client, packet('DAMAGE', damage), true)!;
  expect(all.effects).toEqual([1]); expect(all).not.toHaveProperty('kill'); expect(all).not.toHaveProperty('armorPierce');
  expect(r.record(client, packet('DAMAGE', { ...damage, targetId: 7 }), false)).toBeDefined();
});
it('records only changed own stats and resets omitted full-update masks', () => {
  const r = new Records();
  const own = { objectId: 7, data: [{ id: 1, value: 100 }, { id: 29, value: 4 }, { id: 31, value: 'PRIVATE_NAME' }] };
  expect(r.record(client, packet('NEWTICK', { statuses: [{ ...own, objectId: 8 }] }), false)).toBeUndefined();
  expect(r.record(client, packet('NEWTICK', { statuses: [own] }), false)?.stats).toEqual({ 1: 100, 29: 4 });
  expect(r.record(client, packet('NEWTICK', { statuses: [own] }), false)).toBeUndefined();
  expect(r.record(client, packet('UPDATE', { newObjs: [{ status: { objectId: 7, data: [{ id: 1, value: 90 }] } }] }), false)?.stats).toEqual({ 1: 90, 29: 0, 95: 0 });
});
it('writes lazily, stops at cap without splitting records, flushes and closes idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capture-'));
  try {
    const path = join(dir, 'sub', 'a.jsonl'), log = vi.fn(), stop = vi.fn();
    const w = new CaptureWriter(path, 16, log, stop);
    await expect(stat(path)).rejects.toThrow();
    w.write({ a: 1 }); w.write({ a: 2 }); w.write({ a: 3 });
    await w.close(); await w.close(); w.write({ a: 4 });
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
    expect(stop).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(' ')).toContain('Capture stopped:');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('counts ACKs, near and unknown unacked AOEs with pending separately', () => {
  const c = new Correlation();
  const r = (type: string, t: number, x: number) => ({ client: 'c1', dir: '', iso: '', type, t, position: { x, y: 0 }, radius: 1 });
  c.add(r('AOE', 0, 0)); c.add(r('AOEACK', 100, 0));
  c.add(r('AOE', 200, 1)); c.add(r('AOE', 300, 9));
  expect(c.summary('c1', 2000)).toContain('AOE=3 AOEACK=1 no ACK within 1500ms=2 near(radius+0.5)=1 position unknown=0 pending=0');
  const unknown = new Correlation(); unknown.add(r('AOE', 0, 0));
  expect(unknown.summary('c2', 1600)).toContain('position unknown=1');
});
it('defaults off and removes observer interest again when disabled', () => {
  const f = startHost([plugin]);
  try {
    expect(f.proxy.interest.observe?.server).toEqual(expect.arrayContaining(['CREATESUCCESS', 'NEWTICK', 'UPDATE']));
    expect(f.proxy.interest.observe?.server).not.toContain('AOE');
    f.host.setEnabled('capture', true);
    expect(f.proxy.interest.observe?.server).toContain('AOE');
    f.host.setEnabled('capture', false);
    expect(f.proxy.interest.observe?.server).not.toContain('AOE');
    f.host.setEnabled('capture', true);
    expect(f.proxy.interest.observe?.server).toContain('AOE');
  } finally { f.host.stop(); }
});
it('disable and cleanup drain writes; re-enable creates a fresh file without duplicate observers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capture-plugin-'));
  vi.stubEnv('APPDATA', dir);
  const hooks = new Map<string, PacketHook>(); let enabledChanged = (_v: boolean) => {}; let cleanup = () => {};
  const settings = new Map<string, unknown>(); const logs: string[] = [];
  const ctx = { enabled: false, on: vi.fn(), registerSetting: (k: string, d: { value: unknown }) => settings.set(k, d.value),
    getSetting: (k: string) => settings.get(k), observePacket: (k: string, fn: PacketHook) => { expect(hooks.has(k)).toBe(false); hooks.set(k, fn); },
    onEnabledChange: (fn: typeof enabledChanged) => { enabledChanged = fn; }, registerCleanup: (fn: typeof cleanup) => { cleanup = fn; }, log: (s: string) => logs.push(s),
  } as unknown as PluginContext;
  try {
    plugin.register(ctx); expect(ctx.enabled).toBe(false); expect(hooks.size).toBe(0);
    for (let i = 0; i < 2; i++) {
      ctx.enabled = true; enabledChanged(true);
      hooks.get('AOE')!(client, packet('AOE', { radius: 1 }));
      if (i === 0) { ctx.enabled = false; enabledChanged(false); } else cleanup();
      await vi.waitFor(() => expect(logs.filter(s => s.startsWith('Capture stopped:'))).toHaveLength(i + 1));
    }
    expect(hooks.size).toBe(PACKETS.length);
    expect(await readdir(join(dir, 'RealmTool', 'captures'))).toHaveLength(2);
    expect(logs.filter(s => s.includes('heuristic spatial-first'))).toHaveLength(2);
  } finally { cleanup(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});
