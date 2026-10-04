import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import autoNexus from '../../plugins/auto-nexus/index.ts';
import { createAutoDrinkPlugin } from '../../plugins/auto-drink/index.ts';
import type { AutoDrinkStatus } from '../auto-drink/AutoDrinkTypes.ts';
import { ProfileStore, writeJsonAtomic, type Profile } from '../config/store.ts';
import { loadConsumables } from '../data/consumables.ts';
import { definePlugin, type PluginDefinition } from '../plugins/api.ts';
import { PluginHost } from '../plugins/host.ts';
import { createFactory, loadSchema } from '../protocol/schema.ts';
import { connectGame, until } from '../testing/net.ts';
import { helloBytes, reconnectBytes } from '../testing/wire.ts';
import { ProxyHost } from '../transport/host.ts';
import { log, type LogRecord } from '../util/log.ts';

const factory = createFactory();
const cleanups: (() => Promise<void> | void)[] = [];
const records: LogRecord[] = [];
let removeSink: () => void;
beforeEach(() => { records.length = 0; log.setConsole(false); removeSink = log.addSink(record => records.push(record)); });
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { removeSink(); log.setConsole(true); vi.restoreAllMocks(); }
});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const packet = (name: string, data: Record<string, unknown> = {}) => {
  const value = factory.createByName(name);
  value.data = data;
  return factory.serialize(value);
};
const stat = (id: number, value: number, stackCount = 0) => ({ id, value, stackCount, stringValue: '' });
const position = { x: 1.5, y: 2.5 };

async function fixture(options: { drink?: boolean; profile?: Profile; plugins?: PluginDefinition[]; snapshot?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-realtime-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const catalogLoader = () => loadConsumables({ appDataDir: root,
    bundledPath: fileURLToPath(new URL('../../data/catalogs/consumables.json', import.meta.url)) });
  const loaded = catalogLoader();
  if (!loaded.ok) throw new Error(loaded.reason);
  const item = loaded.catalog.items.find(item => item.name === 'Health Potion');
  if (!item) throw new Error('Bundled catalog must contain Health Potion');
  const gameDir = join(root, 'game');
  mkdirSync(join(gameDir, 'RotMG Exalt_Data'), { recursive: true });
  writeFileSync(join(gameDir, 'RotMG Exalt_Data', 'boot.config'), `build-guid=${loaded.catalog.gameBuild}\n`);
  const profile = new ProfileStore({ dir: root });
  writeJsonAtomic(profile.path, options.profile ?? { schemaVersion: 1, plugins: options.drink
    ? { 'auto-drink': { enabled: true, settings: {} } } : {} });

  const escapeTimes = new BigInt64Array(new SharedArrayBuffer(8 * 16));
  const server = new Worker(new URL('./fixtures/realtime-server.ts', import.meta.url), { workerData: { escapeTimes: escapeTimes.buffer } });
  cleanups.push(async () => { await server.terminate(); });
  const received: { bytes: Buffer; at: bigint }[] = [];
  const faults: string[] = [];
  let serverPort = 0;
  server.on('error', error => faults.push(error.message));
  server.on('message', message => {
    if (message.type === 'listening') serverPort = message.port;
    else if (message.type === 'frame') received.push({ bytes: Buffer.from(message.bytes), at: message.at });
    else if (message.type === 'fault') faults.push(message.message);
  });
  await until(() => serverPort !== 0 || faults.length > 0, 'fake server listening');
  expect(faults).toEqual([]);
  const proxy = new ProxyHost({ schema: loadSchema(), listenPort: 0,
    resolveTarget: () => ({ host: '127.0.0.1', port: serverPort }),
    ...(options.snapshot ? { workerUrl: new URL('./fixtures/realtime-config-worker.ts', import.meta.url) } : {}),
  });
  cleanups.push(() => proxy.stop());
  proxy.on('fault', event => faults.push(event.message));
  proxy.on('diagnostic', event => faults.push(event.message));
  let snapshot: unknown;
  proxy.on('module', event => { if (event.moduleId === 'startup-snapshot') snapshot = event.message; });
  const batches = vi.spyOn(proxy, 'configureModules');
  const singles = vi.spyOn(proxy, 'configureModule');
  const plugins = new PluginHost({ proxy, factory, profile, gameDir,
    definitions: [autoNexus, createAutoDrinkPlugin(catalogLoader), ...(options.plugins ?? [])] });
  cleanups.push(() => plugins.stop());
  plugins.start();
  expect(plugins.loaded()).toContain('auto-nexus');
  expect(plugins.loaded()).toContain('auto-drink');
  const port = await proxy.start();
  const game = await connectGame(port);
  cleanups.push(() => game.destroy());
  game.send(helloBytes(factory, Buffer.alloc(0)));
  await until(() => received.length > 0, 'HELLO through real worker');
  const wire = (name: string) => received.filter(entry => entry.bytes[4] === factory.getPacketId(name));
  const send = (...frames: Buffer[]) => server.postMessage({ type: 'send', frames });
  let tickId = 0;
  const tick = (hp: number, extra: ReturnType<typeof stat>[] = []) => packet('NEWTICK', {
    tickId: ++tickId, tickTime: 200, statuses: [{ objectId: 1, position, data: [stat(1, hp), ...extra] }],
  });
  send(packet('MAPINFO', { name: 'Realm' }), packet('CREATESUCCESS', { objectId: 1, charId: 2 }),
    packet('UPDATE', { tiles: [], drops: [], newObjs: [{ objectType: 768, status: { objectId: 1, position,
      data: [stat(0, 1000), stat(1, 800), stat(3, 500), stat(4, 500), stat(29, 0), stat(95, 0), stat(116, item.type, 3)] } }] }));
  await until(() => game.frames.some(bytes => bytes[4] === factory.getPacketId('UPDATE')), 'healthy spawn delivered');
  game.send(packet('PONG', { serial: 1, time: 2000 }));
  await until(() => wire('PONG').length === 1, 'accepted game clock');
  const status = () => plugins.data('auto-drink')?.get('status') as AutoDrinkStatus | undefined;
  const healthy = () => {
    expect(faults).toEqual([]);
    expect(game.errors).toEqual([]);
    expect(records.filter(record => record.level === 'error' || record.level === 'warn')).toEqual([]);
  };
  return { proxy, plugins, server, game, item, escapeTimes, send, tick, wire, status, healthy, batches, singles,
    snapshot: () => snapshot, catalog: loaded.catalog };
}

describe('realtime plugins through the encrypted ProxyHost worker', () => {
  it('writes ESCAPE and its first retry while a TEXT plugin hook busy-waits 500 ms', async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    let started = 0n, returned = 0n, firstDuringHook = 0n, retryDuringHook = 0n;
    const slow = definePlugin({ id: 'slow-text', name: 'Slow TEXT', apiVersion: 1, capabilities: ['packets'], register(ctx) {
      ctx.hookPacket('TEXT', (_client, text) => {
        if (text.data.text !== 'block now') return;
        started = process.hrtime.bigint();
        f.send(f.tick(200));
        while (process.hrtime.bigint() - started < 500_000_000n) { /* deliberate main-thread stall */ }
        firstDuringHook = Atomics.load(f.escapeTimes, 0);
        retryDuringHook = Atomics.load(f.escapeTimes, 1);
        returned = process.hrtime.bigint();
      });
    } });
    f = await fixture({ plugins: [slow] });
    f.send(packet('TEXT', { name: 'server', objectId: -1, numStars: -1, bubbleTime: 0, recipient: '',
      text: 'block now', cleanText: 'block now', isSupporter: false, starBg: 0 }));
    await until(() => returned !== 0n, 'slow hook returned');
    expect(Number(returned - started) / 1e6).toBeGreaterThanOrEqual(500);
    expect(firstDuringHook).toBeGreaterThan(started);
    expect(firstDuringHook).toBeLessThan(returned);
    expect(retryDuringHook).toBeGreaterThan(firstDuringHook);
    expect(retryDuringHook).toBeLessThan(returned);
    f.healthy();
  });

  it('sends the default five ESCAPEs 400 ms apart (±100 ms), then none for 2 s', async () => {
    const f = await fixture();
    f.send(f.tick(200));
    await until(() => f.wire('ESCAPE').length >= 5, 'five default ESCAPEs');
    const escapes = f.wire('ESCAPE');
    expect(escapes).toHaveLength(5);
    for (let i = 1; i < escapes.length; i++) {
      const interval = Number(escapes[i].at - escapes[i - 1].at) / 1e6;
      expect(interval).toBeGreaterThanOrEqual(300);
      expect(interval).toBeLessThanOrEqual(500);
    }
    await pause(2000);
    expect(f.wire('ESCAPE')).toHaveLength(5);
    f.healthy();
  });

  it.each([false, true])('only a written RECONNECT stops retries (plugin drops = %s)', async drop => {
    let verdicts = 0;
    const verdict = definePlugin({ id: 'reconnect-verdict', name: 'Reconnect verdict', apiVersion: 1, capabilities: ['packets'],
      register(ctx) { ctx.hookPacket('RECONNECT', (_client, packet) => { verdicts++; if (drop) packet.send = false; }); } });
    const f = await fixture({ plugins: [verdict] });
    f.send(f.tick(200));
    await until(() => f.wire('ESCAPE').length === 1, 'initial escape');
    f.send(reconnectBytes(factory, { host: '127.0.0.1', port: 2050, key: Buffer.from([1, 2, 3]) }));
    await until(() => verdicts === 1, 'RECONNECT verdict');
    if (drop) {
      await until(() => f.wire('ESCAPE').length === 5, 'retries survive dropped transfer');
      expect(f.game.frames.filter(bytes => bytes[4] === factory.getPacketId('RECONNECT'))).toHaveLength(0);
    } else {
      await until(() => f.game.frames.some(bytes => bytes[4] === factory.getPacketId('RECONNECT')), 'accepted transfer written to game');
      await pause(2000);
      expect(f.wire('ESCAPE')).toHaveLength(1);
    }
    f.healthy();
  });

  it('prioritizes Auto Nexus below both thresholds and disarms Auto Drink for the generation', async () => {
    const f = await fixture({ drink: true });
    f.send(f.tick(200));
    await until(() => f.wire('ESCAPE').length > 0 && f.status()?.reason === 'escape lifecycle', 'escape disarmed drink');
    f.send(f.tick(800), f.tick(400, [stat(116, f.item.type, 2)]));
    await pause(500);
    expect(f.wire('USEITEM')).toHaveLength(0);
    expect(f.status()?.reason).toBe('escape lifecycle');
    f.healthy();
  });

  it('uses one decoded quickslot potion below only the drink threshold', async () => {
    const f = await fixture({ drink: true });
    f.send(f.tick(400));
    await until(() => f.wire('USEITEM').length === 1, 'automatic drink');
    const use = factory.createFromBytes(f.wire('USEITEM')[0].bytes, 'client');
    expect(use.isDefined).toBe(true);
    expect(use.data).toEqual({ time: expect.any(Number), slotObject: { objectId: 1, slotId: 1_000_000, objectType: f.item.type },
      itemUsePos: position, useType: 0, unknownInt: 0 });
    expect(use.data.time).toBeGreaterThanOrEqual(2000);
    await pause(500);
    expect(f.wire('USEITEM')).toHaveLength(1);
    expect(f.wire('ESCAPE')).toHaveLength(0);
    f.healthy();
  });

  it('keeps its own USEITEM untainted so a stock decrease clears the pending status', async () => {
    const f = await fixture({ drink: true });
    f.send(f.tick(400));
    // Status and receipt arrive from independent workers; neither orders the other.
    await until(() => f.status()?.reason === 'awaiting stock decrease' && f.wire('USEITEM').length > 0,
      'own-use pending status and USEITEM receipt');
    expect(f.wire('USEITEM')).toHaveLength(1);
    expect(f.status()?.pending).toBe(true);
    f.send(f.tick(800, [stat(116, f.item.type, 2)]));
    await until(() => f.status()?.reason === 'above thresholds', 'own-use stock acknowledgement', 1000);
    expect(f.status()).toMatchObject({ state: 'ready', pending: false, hp: 800, slotId: 1_000_000, itemType: f.item.type });
    expect(f.wire('USEITEM')).toHaveLength(1);
    f.healthy();
  });

  it('loads both profile configurations as one batch before the worker starts', async () => {
    const f = await fixture({ snapshot: true, profile: { schemaVersion: 1, plugins: {
      'auto-nexus': { enabled: true, settings: { ForceAutoNexusHealth: 17, EscapeRetryCount: 2, EscapeRetryIntervalMs: 650 } },
      'auto-drink': { enabled: true, settings: { hpThresholdPct: 65, drinkIntervalMs: 750, slotPriority: '3,1,2' } },
    } } });
    await until(() => f.snapshot() !== undefined, 'worker startup snapshot');
    expect(f.singles).not.toHaveBeenCalled();
    expect(f.batches).toHaveBeenCalledTimes(1);
    const batch = f.batches.mock.calls[0][0];
    expect(Object.keys(batch)).toEqual(['auto-nexus', 'auto-drink']);
    expect(batch['auto-nexus']).toMatchObject({ settings: { enabled: true, thresholdPct: 17, retryCount: 2, retryMs: 650 } });
    expect(batch['auto-drink']).toMatchObject({ settings: { enabled: true, hpThresholdPct: 65, intervalMs: 750, slotPriority: [2, 0, 1] }, items: f.catalog.items });
    expect(f.snapshot()).toEqual([{ id: 'auto-nexus', config: batch['auto-nexus'] }, { id: 'auto-drink', config: batch['auto-drink'] }]);
    f.healthy();
  });
});
