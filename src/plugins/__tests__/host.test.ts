import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type ClientConnection, type PluginContext, type PluginDefinition, type WorkerChannel } from '../api.ts';
import { log, type LogRecord } from '../../util/log.ts';
import { startHost, textData, type Harness } from '../../testing/pluginHarness.ts';
import { FakeProxy } from '../../testing/pluginHarness.ts';
import { ProfileStore } from '../../config/store.ts';
import { PluginHost, type ProxyLike } from '../host.ts';
import { createFactory } from '../../protocol/schema.ts';

const records: LogRecord[] = [];
let removeSink: () => void = () => {};
afterEach(() => { vi.restoreAllMocks(); removeSink(); log.setConsole(true); records.length = 0; });
function quietLogs() { log.setConsole(false); removeSink = log.addSink(r => records.push(r)); }

const plugin = (id: string, register: (ctx: PluginContext) => void, extra: Partial<PluginDefinition> = {}) =>
  definePlugin({ id, name: id, apiVersion: 1, capabilities: ['packets', 'commands', 'notifications', 'inject'], register, ...extra });
const decode = (h: Harness, data: Buffer | null, dir: 'client' | 'server') => h.factory.createFromBytes(data!, dir);
const helloData = () => ({ gameId: -2, buildVersion: 'b', accessToken: 'regression-secret-token', keyTime: -1, key: Buffer.alloc(0), gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: '', userToken: '', clientIdentification: '' });

describe('PluginHost', () => {
  it.each(['RECONNECT', 'DEATH', 'MAPINFO', 'ESCAPE'])('warns at registration and runs %s hooks only as isolated observers', name => {
    quietLogs();
    const order: string[] = [];
    const h = startHost([plugin('critical', ctx => {
      ctx.observePacket(name, (_c, p) => {
        order.push('observer');
        expect(p.send).not.toBe(false);
        expect(p.rawBytes.readInt32BE(0)).toBe(p.rawBytes.length);
      });
      ctx.hookPacket(name, (_c, p) => {
        order.push('hook');
        p.send = false;
        p.modified = true;
        p.rawBytes.fill(0);
      }, { prepend: true });
    })]);
    const side = h.factory.getPacketDirection(name)!;
    expect(h.proxy.interest.verdict?.[side]).not.toContain(name);
    expect(h.proxy.interest.observe?.[side]).toContain(name);
    const warnings = () => records.filter(r => r.level === 'warn');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toBe(`${name} is safety-critical; this packet hook runs as observe-only (drop and modification requests are ignored)`);
    const client = h.connect();
    const data = h.factory.createByName(name).data;
    h.packet(client, name, data, { observeOnly: true });
    h.packet(client, name, data, { observeOnly: true });
    expect(order).toEqual(['hook', 'observer', 'hook', 'observer']);
    expect(h.proxy.forwards).toEqual([]);
    expect(warnings()).toHaveLength(1); // Registration warning, never repeated per packet.
    expect(records.filter(r => r.level === 'error')).toEqual([]);
    h.host.stop();
  });

  it.each([undefined, null, 'C:/fixture/game'])('passes gameDir through the harness without a capability (%s)', gameDir => {
    const h = startHost([plugin('p', () => {}, { capabilities: [] })], { gameDir });
    expect(h.host.context('p')!.gameDir).toBe(gameDir ?? null);
    h.host.stop();
  });
  it('coalesces registration and saved settings into one worker configuration batch', () => {
    quietLogs();
    vi.spyOn(ProfileStore.prototype, 'load').mockReturnValue({ schemaVersion: 1, plugins: {
      a: { enabled: false, settings: { n: 3, m: 4 } },
      b: { enabled: true, settings: { n: 7, m: 8 } },
    } });
    const h = startHost(['a', 'b'].map(id => plugin(id, ctx => {
      const configure = () => ctx.worker.configure({ n: ctx.getSetting('n'), m: ctx.getSetting('m'), enabled: ctx.enabled });
      ctx.worker.configure('initial');
      ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }, configure);
      ctx.registerSetting('m', { label: 'M', type: 'number', value: 2 }, configure);
      ctx.onEnabledChange(configure);
      configure();
    }, { capabilities: ['worker'] })));
    expect(h.host.loaded()).toEqual(['a', 'b']);
    expect(h.proxy.configured).toEqual([{
      a: { n: 3, m: 4, enabled: false }, b: { n: 7, m: 8, enabled: true },
    }]);
    h.host.stop();
  });

  it('sends each worker configuration immediately after startup', () => {
    quietLogs();
    const h = startHost([plugin('p', () => {}, { capabilities: ['worker'] })]);
    expect(h.proxy.configured).toEqual([]);
    h.host.context('p')!.worker.configure({ value: 1 });
    h.host.context('p')!.worker.configure(undefined);
    expect(h.proxy.configured).toEqual([{ p: { value: 1 } }, { p: undefined }]);
    h.host.stop();
  });

  it('sends worker commands only for a live client facade', () => {
    quietLogs();
    let client!: ClientConnection;
    const h = startHost([plugin('p', ctx => ctx.on('clientConnected', c => { client = c; }), { capabilities: ['worker'] })]);
    const id = h.connect();
    const worker = h.host.context('p')!.worker;
    worker.send(client, { action: 'status' });
    h.close(id);
    worker.send(client, 'closed');
    expect(h.proxy.commands).toEqual([{ moduleId: 'p', id, message: { action: 'status' } }]);
    h.host.stop();
  });

  it('routes worker messages by plugin and live client even while disabled, and removes them on stop', () => {
    quietLogs();
    let client!: ClientConnection;
    const received = vi.fn();
    const other = vi.fn();
    const h = startHost([
      plugin('p', ctx => {
        ctx.on('clientConnected', c => { client = c; });
        ctx.worker.onMessage(received);
      }, { capabilities: ['worker'] }),
      plugin('other', ctx => ctx.worker.onMessage(other), { capabilities: ['worker'] }),
    ]);
    const id = h.connect();
    h.host.context('p')!.enabled = false;
    h.workerMessage(id, 'p', { hp: 50 });
    expect(received).toHaveBeenCalledExactlyOnceWith(client, { hp: 50 });
    expect(client.clientId).toBe(id);
    expect(client.sendToServer).toBeTypeOf('function');
    h.workerMessage('unknown', 'p', 'ignored');
    h.workerMessage(id, 'unknown', 'ignored');
    h.proxy.emit('module', { moduleId: 'p', message: 'no session' });
    h.close(id);
    h.workerMessage(id, 'p', 'closed');
    expect(received).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    const live = h.connect('live');
    expect(h.proxy.listenerCount('module')).toBe(1);
    h.host.stop();
    expect(h.proxy.listenerCount('module')).toBe(0);
    h.workerMessage(live, 'p', 'stopped');
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('rejects worker access without the worker capability', () => {
    const h = startHost([plugin('p', () => {})]);
    expect(() => h.host.context('p')!.worker).toThrow('p did not declare the "worker" capability');
    h.host.stop();
  });

  it('discards failed plugin worker configuration and handlers, including cleanup and delayed registrations', async () => {
    quietLogs();
    const received = vi.fn();
    const cleanup = vi.fn();
    let channel!: WorkerChannel;
    let client!: ClientConnection;
    const h = startHost([
      plugin('bad', ctx => {
        channel = ctx.worker;
        channel.configure('before failure');
        channel.onMessage(received);
        channel.onHealth(received);
        ctx.registerCleanup(() => {
          cleanup();
          channel.configure('cleanup');
          channel.onMessage(received);
          channel.onHealth(received);
        });
        queueMicrotask(() => {
          channel.configure('delayed');
          channel.onMessage(received);
          channel.onHealth(received);
          channel.send(client, 'delayed');
        });
        throw new Error('register failed');
      }, { capabilities: ['worker'] }),
      plugin('good', ctx => {
        ctx.worker.configure('good');
        ctx.on('clientConnected', c => { client = c; });
      }, { capabilities: ['worker'] }),
    ]);
    const id = h.connect();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(h.host.loaded()).toEqual(['good']);
    expect(h.proxy.configured).toEqual([{ good: 'good' }]);
    expect(h.proxy.commands).toEqual([]);
    h.workerMessage(id, 'bad', 'ignored');
    h.proxy.emit('moduleStatus', { moduleId: 'bad', state: 'failing', since: 1 });
    h.proxy.emit('moduleConfig', { moduleId: 'bad', type: 'moduleConfig', ok: false, error: 'invalid' });
    expect(received).not.toHaveBeenCalled();
    h.host.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('logs worker handler errors with plugin name and details and continues dispatch', () => {
    quietLogs();
    const next = vi.fn();
    const h = startHost([plugin('p', ctx => {
      ctx.worker.onMessage(() => { throw new Error('worker detail'); });
      ctx.worker.onMessage(next);
    }, { name: 'Worker Plugin', capabilities: ['worker'] })]);
    h.workerMessage(h.connect(), 'p', 'status');
    expect(next).toHaveBeenCalledTimes(1);
    expect(records.filter(r => r.level === 'error')).toEqual([
      expect.objectContaining({ module: 'Worker Plugin', message: expect.stringContaining('worker detail') }),
    ]);
    h.host.stop();
  });

  it.each(['observer', 'hook'] as const)('withholds credentials from HELLO %s errors', kind => {
    quietLogs();
    const h = startHost([plugin('p', ctx => {
      ctx[kind === 'observer' ? 'observePacket' : 'hookPacket']('HELLO', (_c, packet) => {
        throw new Error(`bad ${packet.data.accessToken}`);
      });
    })]);
    const data = helloData();
    h.packet(h.connect(), 'HELLO', data, { observeOnly: kind === 'observer' });
    expect(JSON.stringify(records)).not.toContain(data.accessToken);
    expect(records.filter(r => r.level === 'error')).toEqual([
      expect.objectContaining({ module: 'p', message: `HELLO ${kind} failed (details withheld: this packet carries credentials)` }),
    ]);
    expect(h.proxy.forwards).toHaveLength(kind === 'observer' ? 0 : 1);
    h.host.stop();
  });

  it('withholds credentials in the packet handling catch-all', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => {
      ctx.observePacket('HELLO', (_c, packet) => {
        // The next enabled check is outside the callback try/catch.
        Object.defineProperty(ctx, 'enabled', { get() { throw new Error(`bad ${packet.data.accessToken}`); } });
      });
      ctx.hookPacket('HELLO', () => {});
    })]);
    const data = helloData();
    h.packet(h.connect(), 'HELLO', data);
    expect(JSON.stringify(records)).not.toContain(data.accessToken);
    expect(records.filter(r => r.level === 'error')).toEqual([
      expect.objectContaining({ message: 'Packet handling failed (details withheld: this packet carries credentials)' }),
    ]);
    expect(h.proxy.forwards).toHaveLength(1);
    expect(decode(h, h.proxy.forwards[0].data, 'client').data.accessToken).toBe(data.accessToken);
    h.host.stop();
  });

  it('withholds credentials on serialization failure and forwards the original', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookPacket('HELLO', (_c, packet) => {
      packet.modified = true;
      const token = packet.data.accessToken;
      Object.defineProperty(packet.data, 'accessToken', { get() { throw new Error(`bad ${token}`); } });
    }))]);
    const data = helloData();
    h.packet(h.connect(), 'HELLO', data);
    expect(JSON.stringify(records)).not.toContain(data.accessToken);
    expect(records.filter(r => r.level === 'warn')).toEqual([
      expect.objectContaining({ message: 'Could not apply a change to HELLO; forwarding the original (details withheld: this packet carries credentials)' }),
    ]);
    expect(h.proxy.forwards).toHaveLength(1);
    expect(decode(h, h.proxy.forwards[0].data, 'client').data.accessToken).toBe(data.accessToken);
    h.host.stop();
  });

  it.each([null, undefined, 'invalid'])('loads defaults and later plugins when migration throws %s', error => {
    quietLogs();
    vi.spyOn(ProfileStore.prototype, 'load').mockReturnValue({ schemaVersion: 1, plugins: {
      p: { enabled: true, settings: { n: 3 } },
    } });
    const migrate = vi.fn((_saved: unknown, present: boolean) => { if (present) throw error; return { n: 7 }; });
    const later = vi.fn();
    const h = startHost([
      plugin('p', ctx => ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }), { settings: { migrate } }),
      plugin('later', ctx => ctx.hookPacket('TEXT', later)),
    ]);
    expect(migrate.mock.calls).toEqual([[{ n: 3 }, true], [undefined, false]]);
    expect(h.host.context('p')!.getSetting('n')).toBe(7);
    expect(h.host.loaded()).toEqual(['p', 'later']);
    expect(records.filter(r => r.level === 'warn')).toEqual([
      expect.objectContaining({ message: `p: saved settings are invalid (${String(error)}); using defaults` }),
    ]);
    h.packet(h.connect(), 'TEXT', textData());
    expect(later).toHaveBeenCalledTimes(1);
    h.host.stop();
  });

  it('disables a plugin when defaults migration also throws and loads later plugins', () => {
    quietLogs();
    vi.spyOn(ProfileStore.prototype, 'load').mockReturnValue({ schemaVersion: 1, plugins: {
      bad: { enabled: true, settings: { n: 3 } },
    } });
    const migrate = vi.fn(() => { throw new Error('migration failed'); });
    const cleanup = vi.fn();
    const bad = vi.fn();
    const later = vi.fn();
    let h!: Harness;
    expect(() => {
      h = startHost([
        plugin('bad', ctx => {
          ctx.hookPacket('TEXT', bad);
          ctx.registerCleanup(cleanup);
        }, { settings: { migrate } }),
        plugin('later', ctx => ctx.observePacket('TEXT', later)),
      ]);
    }).not.toThrow();
    expect(migrate.mock.calls).toEqual([[{ n: 3 }, true], [undefined, false]]);
    expect(h.host.loaded()).toEqual(['later']);
    expect(h.host.context('bad')).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(h.proxy.interest.verdict?.server).toEqual([]);
    expect(records.filter(r => r.level === 'error')).toEqual([
      expect.objectContaining({ module: 'Plugins', message: expect.stringContaining('bad failed to load and is disabled') }),
    ]);
    h.packet(h.connect(), 'TEXT', textData());
    expect(bad).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.proxy.forwards).toHaveLength(1);
    h.host.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('forwards original bytes when serialization throws null', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, packet) => {
      packet.modified = true;
      vi.spyOn(h.factory, 'serialize').mockImplementation(() => { throw null; });
    }))]);
    const verdict = h.packet(h.connect(), 'TEXT', textData())!;
    expect(h.proxy.forwards).toHaveLength(1);
    expect(decode(h, verdict.data, 'server').data.text).toBe('hello');
    expect(records.filter(r => r.level === 'warn')).toEqual([
      expect.objectContaining({ message: 'Could not apply a change to TEXT; forwarding the original (null)' }),
    ]);
    h.host.stop();
  });

  it('sets initial interest before subscribing and refreshes it for late registrations', () => {
    const counts: number[] = [];
    const original = FakeProxy.prototype.setInterest;
    vi.spyOn(FakeProxy.prototype, 'setInterest').mockImplementation(function (this: FakeProxy, interest) {
      counts.push(this.listenerCount('packet'));
      original.call(this, interest);
    });
    const h = startHost([plugin('p', () => {})]);
    expect(counts).toEqual([0]);
    expect(h.proxy.interest.commands).toEqual([]);
    expect(h.proxy.interest.verdict?.client).not.toContain('PLAYERTEXT');
    const ctx = h.host.context('p')!;
    ctx.hookPacket('TEXT', () => {});
    ctx.observePacket('HELLO', () => {});
    ctx.hookCommand('late', () => {});
    expect(counts).toEqual([0, 1, 1, 1]);
    expect(h.proxy.interest.commands).toEqual(['late']);
    ctx.hookCommand('/CON', () => {});
    expect(counts).toEqual([0, 1, 1, 1, 1]);
    expect(h.proxy.interest.commands).toEqual(['late', 'con']);
    expect(h.proxy.interest.verdict).toEqual({ client: ['PLAYERTEXT'], server: ['TEXT'] });
    expect(h.proxy.interest.observe?.client).toEqual(['HELLO']);
    h.host.stop();
  });

  it('ignores observer mutations, including raw bytes, on verdict events', () => {
    quietLogs();
    const seen: string[] = [];
    const h = startHost([plugin('p', ctx => {
      ctx.observePacket('TEXT', (_c, p) => {
        p.data.text = 'changed';
        p.send = false;
        p.modified = true;
        p.rawBytes.fill(0);
        throw new Error('observer failed');
      });
      ctx.observePacket('TEXT', (_c, p) => seen.push(p.data.text));
      ctx.hookPacket('TEXT', (_c, p) => seen.push(p.data.text));
    })]);
    const verdict = h.packet(h.connect(), 'TEXT', textData())!;
    expect(seen).toEqual(['hello', 'hello']);
    expect(decode(h, verdict.data, 'server').data.text).toBe('hello');
    expect(h.proxy.forwards).toHaveLength(1);
    h.host.stop();
  });

  it('drops only when send is exactly false', () => {
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, p) => { p.send = undefined as never; }))]);
    expect(h.packet(h.connect(), 'TEXT', textData())!.data).not.toBeNull();
    h.host.stop();
  });

  it('schedules saves for all accepted updates and enabled assignments, but not rejected updates', () => {
    const save = vi.spyOn(ProfileStore.prototype, 'scheduleSave');
    const h = startHost([plugin('p', ctx => {
      ctx.registerSetting('run', { label: 'Run', type: 'button', value: undefined });
      ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 });
      ctx.enabled = true;
      ctx.updateSetting('n', 2);
    })]);
    expect(save).not.toHaveBeenCalled();
    const ctx = h.host.context('p')!;
    expect(ctx.updateSetting('run', true)).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(ctx.updateSetting('n', 'invalid')).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    ctx.enabled = true;
    ctx.enabled = true;
    expect(save).toHaveBeenCalledTimes(3);
    h.host.stop();
    expect(JSON.parse(readFileSync(h.profile.path, 'utf8')).plugins.p.settings).toEqual({ n: 2 });
  });

  it('passes unknown clients and decode failures through exactly once, retaining verdict metadata', () => {
    quietLogs();
    const hook = vi.fn();
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', hook))]);
    const data = Buffer.from([0, 0, 0, 5, 255]);
    const event = { id: 'unknown', sequence: 7, generation: 8, fromClient: true, observeOnly: false, data };
    h.proxy.emit('packet', event);
    expect(h.proxy.forwards).toEqual([{ id: 'unknown', sequence: 7, generation: 8, data }]);
    const id = h.connect();
    vi.spyOn(h.factory, 'createFromBytes').mockImplementation(() => { throw new Error('decode failed'); });
    h.proxy.emit('packet', { ...event, id });
    h.proxy.emit('packet', { ...event, id, observeOnly: true });
    expect(h.proxy.forwards).toHaveLength(2);
    expect(h.proxy.forwards[1].data).toBe(data);
    expect(hook).not.toHaveBeenCalled();
    h.host.stop();
  });

  it('runs observers, every enabled command handler, and prepended hooks in order after consumption', () => {
    quietLogs();
    const calls: string[] = [];
    const h = startHost([
      plugin('p', ctx => {
        ctx.observePacket('PLAYERTEXT', () => calls.push('observer'));
        ctx.hookCommand('x', () => { calls.push('throw'); throw new Error('command failed'); });
        ctx.hookCommand('x', () => calls.push('handled'));
        ctx.hookCommand('x', () => calls.push('also handled'));
        ctx.hookPacket('PLAYERTEXT', () => calls.push('last'));
        ctx.hookPacket('PLAYERTEXT', () => calls.push('first'), { prepend: true });
      }),
      plugin('disabled', ctx => {
        ctx.observePacket('PLAYERTEXT', () => calls.push('disabled observer'));
        ctx.hookCommand('x', () => calls.push('disabled command'));
        ctx.enabled = false;
      }),
    ]);
    const id = h.connect();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/x' })!.data).toBeNull();
    expect(calls).toEqual(['observer', 'throw', 'handled', 'also handled', 'first', 'last']);
    calls.length = 0;
    h.packet(id, 'PLAYERTEXT', { text: '/x' }, { observeOnly: true });
    expect(calls).toEqual(['observer']);
    expect(h.proxy.forwards).toHaveLength(1);
    h.host.stop();
  });

  it.each(['hookPacket', 'observePacket'] as const)('rejects unknown names in %s and removes all partial registrations', method => {
    quietLogs();
    const partial = vi.fn();
    const h = startHost([plugin('bad', ctx => {
      ctx.hookPacket('TEXT', partial);
      ctx.observePacket('HELLO', partial);
      ctx.hookCommand('bad', partial);
      ctx.on('clientConnected', partial);
      ctx[method]('NOPE', partial);
    })]);
    expect(h.host.loaded()).toEqual([]);
    expect(h.host.context('bad')).toBeUndefined();
    expect(h.host.data('bad')).toBeUndefined();
    expect(h.proxy.interest.verdict).toEqual({ client: [], server: [] });
    expect(h.proxy.interest.observe?.client).toEqual([]);
    h.packet(h.connect(), 'PLAYERTEXT', { text: '/bad' });
    expect(partial).not.toHaveBeenCalled();
    h.host.stop();
  });

  it('serializes facade sends in both directions and ignores sends once disconnected', () => {
    let client: import('../api.ts').ClientConnection | undefined;
    const h = startHost([plugin('p', ctx => ctx.on('clientConnected', c => { client = c; }))]);
    const id = h.connect();
    const packet = h.host.context('p')!.createPacket('PLAYERTEXT');
    packet.data = { text: 'hello' };
    client!.sendToServer(packet);
    client!.sendToClient(packet);
    expect(h.proxy.injected.map(p => [p.id, p.toClient])).toEqual([[id, false], [id, true]]);
    expect(decode(h, h.proxy.injected[0].data, 'client').data.text).toBe('hello');
    h.close(id);
    packet.data.text = {};
    expect(() => client!.sendToServer(packet)).not.toThrow();
    expect(() => client!.sendToClient(packet)).not.toThrow();
    expect(h.proxy.injected).toHaveLength(2);
    h.host.stop();
  });

  it('preserves unknown profile entries and skips transient, button and rejected saved values', () => {
    quietLogs();
    vi.spyOn(ProfileStore.prototype, 'load').mockReturnValue({ schemaVersion: 1, plugins: {
      unknown: { enabled: false, settings: { keep: 'saved' } },
      p: { enabled: false, settings: { n: 'invalid', draft: 'secret', run: true } },
    } });
    const save = vi.spyOn(ProfileStore.prototype, 'scheduleSave');
    const clicked = vi.fn();
    const h = startHost([plugin('p', ctx => {
      ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 });
      ctx.registerSetting('draft', { label: 'Draft', type: 'text', value: '', transient: true });
      ctx.registerSetting('run', { label: 'Run', type: 'button', value: undefined }, clicked);
    })]);
    expect(save).not.toHaveBeenCalled();
    const ctx = h.host.context('p')!;
    expect(ctx.getSetting('n')).toBe(1);
    expect(ctx.getSetting('draft')).toBe('');
    expect(ctx.enabled).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
    expect(records.some(r => r.level === 'warn' && r.message.includes('invalid saved value'))).toBe(true);
    ctx.updateSetting('n', 4);
    h.host.stop();
    expect(JSON.parse(readFileSync(h.profile.path, 'utf8'))).toEqual({ schemaVersion: 1, plugins: {
      unknown: { enabled: false, settings: { keep: 'saved' } }, p: { enabled: false, settings: { n: 4 } },
    } });
  });

  it('exposes runtime data, routes broadcasts, isolates callbacks and cleanups, unsubscribes and flushes', () => {
    quietLogs();
    const proxy = new FakeProxy();
    const onData = vi.fn();
    const writeJson = vi.fn();
    const profile = new ProfileStore({ dir: '.', fs: {
      readFile: () => '{"schemaVersion":1,"plugins":{}}', rename: vi.fn(), writeJson,
    } });
    const cleanup = vi.fn();
    const enabled = vi.fn();
    const connected = vi.fn();
    const host = new PluginHost({ proxy: proxy as unknown as ProxyLike, factory: createFactory(), profile, onData, definitions: [plugin('p', ctx => {
      ctx.setData('count', 3);
      ctx.broadcastData('ready', { ok: true });
      ctx.onEnabledChange(() => { throw new Error('enable failed'); });
      ctx.onEnabledChange(enabled);
      ctx.on('clientConnected', () => { throw new Error('connection failed'); });
      ctx.on('clientConnected', connected);
      ctx.registerCleanup(() => { throw new Error('cleanup failed'); });
      ctx.registerCleanup(cleanup);
    })] });
    host.start();
    expect(host.data('p')?.get('count')).toBe(3);
    expect(host.data('missing')).toBeUndefined();
    expect(onData).toHaveBeenCalledWith('p', 'ready', { ok: true });
    host.context('p')!.enabled = true;
    expect(enabled).toHaveBeenCalledWith(true);
    proxy.emit('session', { id: 'c1', remotePort: 50000 });
    expect(connected).toHaveBeenCalledTimes(1);
    host.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(writeJson).toHaveBeenCalledTimes(1);
    for (const event of ['session', 'routed', 'closed', 'packet'] as const) expect(proxy.listenerCount(event)).toBe(0);
  });

  it.each([
    ['packets', (ctx: PluginContext) => ctx.hookPacket('TEXT', () => {})],
    ['packets', (ctx: PluginContext) => ctx.observePacket('HELLO', () => {})],
    ['commands', (ctx: PluginContext) => ctx.hookCommand('x', () => {})],
    ['inject', (ctx: PluginContext) => ctx.createPacket('TEXT')],
    ['notifications', (ctx: PluginContext) => ctx.sendNotification({} as import('../api.ts').ClientConnection, 'sender', 'message')],
  ] as const)('requires the %s capability', (capability, invoke) => {
    quietLogs();
    const h = startHost([plugin('p', invoke, { capabilities: [] })]);
    expect(h.host.loaded()).toEqual([]);
    expect(records.some(r => r.message.includes(`p did not declare the "${capability}" capability`))).toBe(true);
    h.host.stop();
  });

  it('maps hook outcomes to exactly one verdict: pass, drop, modify', () => {
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, p) => {
      if (p.data.text === 'drop') p.send = false;
      if (p.data.text === 'edit') { p.data.text = 'edited'; p.data.cleanText = 'edited'; p.modified = true; }
    }))]);
    const id = h.connect();
    const pass = h.packet(id, 'TEXT', textData({ text: 'hi' }))!;
    expect(decode(h, pass.data, 'server').data.text).toBe('hi');
    expect(h.packet(id, 'TEXT', textData({ text: 'drop' }))!.data).toBeNull();
    expect(decode(h, h.packet(id, 'TEXT', textData({ text: 'edit' }))!.data, 'server').data.text).toBe('edited');
    expect(h.proxy.forwards).toHaveLength(3);
  });

  it('still forwards once when a hook throws, and runs later hooks after a drop', () => {
    quietLogs();
    const later = vi.fn();
    const h = startHost([plugin('p', ctx => {
      ctx.hookPacket('TEXT', () => { throw new Error('boom'); });
      ctx.hookPacket('TEXT', (_c, p) => { p.send = false; });
      ctx.hookPacket('TEXT', later);
    })]);
    const id = h.connect();
    expect(h.packet(id, 'TEXT', textData())!.data).toBeNull();
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.proxy.forwards).toHaveLength(1);
    expect(records.some(r => r.level === 'error' && r.message.includes('boom'))).toBe(true);
  });

  it('forwards the original bytes when a modification cannot be serialized', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookPacket('TEXT', (_c, p) => { p.data.objectId = 2147483648; p.modified = true; }))]);
    const id = h.connect();
    const verdict = h.packet(id, 'TEXT', textData({ text: 'keep' }))!;
    expect(decode(h, verdict.data, 'server').data.text).toBe('keep');
    expect(decode(h, verdict.data, 'server').data.objectId).toBe(1);
    expect(h.proxy.forwards).toHaveLength(1);
    expect(records.some(r => r.level === 'warn')).toBe(true);
  });

  it('runs observers on observe-only events and never forwards them', () => {
    const seen = vi.fn();
    const h = startHost([plugin('p', ctx => ctx.observePacket('HELLO', (_c, p) => seen(p.data.accessToken)))]);
    const id = h.connect();
    h.packet(id, 'HELLO', { gameId: -2, buildVersion: 'b', accessToken: 'secret-token', keyTime: -1, key: Buffer.alloc(0), gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: '', userToken: '', clientIdentification: '' }, { observeOnly: true });
    expect(seen).toHaveBeenCalledWith('secret-token');
    expect(h.proxy.forwards).toHaveLength(0);
  });

  it('builds interest from hooks, observers, commands and identity', () => {
    const h = startHost([plugin('p', ctx => {
      ctx.hookPacket('TEXT', () => {});
      ctx.observePacket('HELLO', () => {});
      ctx.hookCommand('con', () => {});
    })]);
    expect(h.proxy.interest.verdict).toEqual({ client: ['PLAYERTEXT'], server: ['TEXT'] });
    expect([...(h.proxy.interest.observe?.client ?? [])]).toEqual(['HELLO']);
    expect([...(h.proxy.interest.observe?.server ?? [])].sort()).toEqual(['CREATESUCCESS', 'NEWTICK', 'UPDATE']);
  });

  it('consumes handled commands with lowercased args and passes unknown or disabled ones through', () => {
    quietLogs();
    const calls: string[][] = [];
    const h = startHost([plugin('p', ctx => {
      ctx.hookCommand('/CON', (_c, command, args) => calls.push([command, ...args]));
      ctx.hookCommand('broken', () => { throw new Error('nope'); });
    })]);
    const id = h.connect();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/CON USWest  ' })!.data).toBeNull();
    expect(calls).toEqual([['con', 'uswest']]);
    expect(h.packet(id, 'PLAYERTEXT', { text: '/unknown x' })!.data).not.toBeNull();
    expect(h.packet(id, 'PLAYERTEXT', { text: ' /con usw' })!.data).not.toBeNull();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/broken' })!.data).not.toBeNull();
    h.host.context('p')!.enabled = false;
    expect(h.packet(id, 'PLAYERTEXT', { text: '/con usw' })!.data).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('skips a disabled plugin\'s hooks and listeners', () => {
    const hook = vi.fn();
    const connected = vi.fn();
    const h = startHost([plugin('p', ctx => { ctx.hookPacket('TEXT', hook); ctx.on('clientConnected', connected); })]);
    h.host.context('p')!.enabled = false;
    const id = h.connect();
    expect(h.packet(id, 'TEXT', textData())!.data).not.toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(connected).not.toHaveBeenCalled();
  });

  it('sends notifications as TEXT with the Realm Engine field values', () => {
    let send: (() => void) | undefined;
    const h = startHost([plugin('p', ctx => ctx.on('clientConnected', client => { send = () => ctx.sendNotification(client, 'Server Switch', 'hi there'); }))]);
    h.connect();
    send!();
    expect(h.proxy.injected).toHaveLength(1);
    expect(h.proxy.injected[0].toClient).toBe(true);
    expect(decode(h, h.proxy.injected[0].data, 'server').data).toEqual({
      name: 'Server Switch', objectId: -1, numStars: -1, bubbleTime: 0, recipient: '', text: 'hi there', cleanText: 'hi there', isSupporter: false, starBg: 0,
    });
  });

  it('tracks identity, server and lifecycle on the client facade', () => {
    const events: string[] = [];
    let client: import('../api.ts').ClientConnection | undefined;
    const h = startHost([plugin('p', ctx => {
      ctx.on('clientConnected', c => { client = c; events.push('up'); });
      ctx.on('clientDisconnected', () => events.push('down'));
    })]);
    const id = h.connect();
    h.route(id, '1.2.3.4');
    h.packet(id, 'CREATESUCCESS', { objectId: 42, charId: 1, stats: '' });
    h.packet(id, 'NEWTICK', { tickId: 1, tickTime: 0, serverRealTimeMs: 0, serverLastRttMs: 0, statuses: [{ objectId: 42, position: { x: 0, y: 0 }, data: [{ id: 31, value: 'Me', stackCount: 0 }] }] });
    expect(client!.playerData).toEqual({ name: 'Me', ownerObjectId: 42 });
    expect(client!.server).toEqual({ host: '1.2.3.4', port: 2050 });
    h.close(id);
    expect(client!.connected).toBe(false);
    expect(events).toEqual(['up', 'down']);
  });

  it('enforces declared capabilities', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.hookCommand('x', () => {}), { capabilities: ['packets'] })]);
    expect(h.host.loaded()).toEqual([]);
    expect(records.some(r => r.level === 'error' && r.message.includes('"commands"'))).toBe(true);
  });

  it('isolates a plugin whose register throws and removes its partial hooks', () => {
    quietLogs();
    const good = vi.fn();
    const h = startHost([
      plugin('bad', ctx => { ctx.hookPacket('TEXT', () => {}); throw new Error('nope'); }),
      plugin('good', ctx => ctx.hookPacket('NEWTICK', good)),
    ]);
    expect(h.host.loaded()).toEqual(['good']);
    expect(h.proxy.interest.verdict?.server).toEqual(['NEWTICK']);
  });

  it('cleans up a failed plugin immediately and ignores its delayed registrations', async () => {
    quietLogs();
    const failed = vi.fn();
    const cleanup = vi.fn();
    const lateCleanup = vi.fn();
    const later = vi.fn();
    const delayed = vi.fn();
    let failedContext!: PluginContext;
    const h = startHost([
      plugin('bad', ctx => {
        failedContext = ctx;
        const register = () => {
          ctx.hookPacket('TEXT', failed);
          ctx.observePacket('HELLO', failed);
          ctx.hookCommand('bad', failed);
          ctx.on('clientConnected', failed);
          ctx.on('clientDisconnected', failed);
        };
        register();
        ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }, failed);
        ctx.onEnabledChange(failed);
        ctx.registerCleanup(() => { throw new Error('cleanup failed'); });
        ctx.registerCleanup(() => { cleanup(); register(); });
        queueMicrotask(() => {
          delayed();
          register();
          ctx.onEnabledChange(failed);
          ctx.enabled = true;
          ctx.registerCleanup(lateCleanup);
        });
        throw new Error('register failed');
      }),
      plugin('later', ctx => ctx.observePacket('TEXT', later)),
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(delayed).not.toHaveBeenCalled();
    const interest = vi.spyOn(h.proxy, 'setInterest');
    await Promise.resolve();
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(failedContext.enabled).toBe(false);
    expect(failedContext.updateSetting('n', 2)).toBe(false);
    expect(interest).not.toHaveBeenCalled();
    expect(h.host.loaded()).toEqual(['later']);
    expect(h.proxy.interest.verdict).toEqual({ client: [], server: [] });
    expect(h.proxy.interest.observe?.client).toEqual([]);
    const id = h.connect();
    h.packet(id, 'TEXT', textData());
    h.packet(id, 'HELLO', helloData(), { observeOnly: true });
    expect(h.packet(id, 'PLAYERTEXT', { text: '/bad' })!.data).not.toBeNull();
    h.close(id);
    expect(failed).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.proxy.forwards).toHaveLength(2);
    expect(records.filter(r => r.level === 'error')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('bad failed to load and is disabled') }),
      expect.objectContaining({ module: 'bad', message: expect.stringContaining('Cleanup failed') }),
    ]);
    h.host.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(lateCleanup).not.toHaveBeenCalled();
  });

  it('rejects duplicate ids and unsupported API versions', () => {
    quietLogs();
    const h = startHost([plugin('a', () => {}), plugin('a', () => {}), plugin('b', () => {}, { apiVersion: 2 })]);
    expect(h.host.loaded()).toEqual(['a']);
  });

  it('applies saved settings via migrate, persists changes, and keeps unknown plugin entries', () => {
    const first = startHost([plugin('p', ctx => {
      ctx.registerSetting('words', { label: 'Words', type: 'text', value: '' });
      ctx.registerSetting('draft', { label: 'Draft', type: 'text', value: '', transient: true });
    })]);
    first.host.context('p')!.updateSetting('words', 'spam');
    first.host.context('p')!.updateSetting('draft', 'unsaved');
    first.host.context('p')!.enabled = false;
    first.host.stop();
    const saved = JSON.parse(readFileSync(first.profile.path, 'utf8'));
    expect(saved.plugins.p).toEqual({ enabled: false, settings: { words: 'spam' } });

    const migrate = vi.fn((s: unknown) => ({ ...(s as object), words: `${(s as { words: string }).words}!` }));
    const second = startHost([plugin('p', ctx => ctx.registerSetting('words', { label: 'Words', type: 'text', value: '' }), { settings: { migrate } })], { profileDir: first.profileDir });
    expect(migrate).toHaveBeenCalledWith({ words: 'spam' }, true);
    expect(second.host.context('p')!.getSetting('words')).toBe('spam!');
    expect(second.host.context('p')!.enabled).toBe(false);
  });

  it('falls back to defaults when migrate rejects a saved entry', () => {
    quietLogs();
    const h = startHost([plugin('p', ctx => ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }), {
      settings: { migrate: (saved, present) => { if (present) throw new Error('invalid'); return { n: 7 }; } },
    })], { profileDir: (() => {
      const first = startHost([plugin('p', ctx => ctx.registerSetting('n', { label: 'N', type: 'number', value: 1 }))]);
      first.host.context('p')!.updateSetting('n', 3);
      first.host.stop();
      return first.profileDir;
    })() });
    expect(h.host.context('p')!.getSetting('n')).toBe(7);
    expect(records.some(r => r.level === 'warn' && r.message.includes('invalid'))).toBe(true);
  });

  it('never writes an observed access token into the profile', () => {
    const h = startHost([plugin('p', ctx => ctx.observePacket('HELLO', () => {}))]);
    const id = h.connect();
    h.packet(id, 'HELLO', { gameId: -2, buildVersion: 'b', accessToken: 'secret-token', keyTime: -1, key: Buffer.alloc(0), gameNet: '', playPlatform: '', platformToken: '', userToken: '', clientIdentification: '' }, { observeOnly: true });
    h.host.context('p')!.enabled = true;
    h.host.stop();
    expect(readFileSync(h.profile.path, 'utf8')).not.toContain('secret-token');
  });
});

it('isolates health/config events by plugin and removes callbacks on stop', () => {
  quietLogs();
  const a = vi.fn(), b = vi.fn();
  const h = startHost([
    plugin('a', ctx => ctx.worker.onHealth(a), { capabilities: ['worker'] }),
    plugin('b', ctx => ctx.worker.onHealth(b), { capabilities: ['worker'] }),
  ]);
  h.host.setEnabled('a', false); // Health must keep flowing while disabled.
  h.connect('live'); h.connect('gone'); h.close('gone');
  h.proxy.emit('moduleStatus', { moduleId: 'a', state: 'failing', since: 123 });
  h.proxy.emit('moduleConfig', { type: 'moduleConfig', moduleId: 'a', ok: false, error: 'invalid' });
  expect(b).not.toHaveBeenCalled();
  expect(a.mock.calls.map(call => call[0])).toEqual([{ state: 'failing', since: 123 }, { configOk: false, reason: 'invalid' }]);
  expect(a.mock.calls[0][1].map((c: ClientConnection) => c.clientId)).toEqual(['live']);
  h.proxy.emit('moduleConfig', { type: 'moduleConfig', moduleId: 'b', ok: true });
  expect(b.mock.calls[0][0]).toEqual({ configOk: true });
  h.host.stop();
  h.proxy.emit('moduleStatus', { moduleId: 'a', state: 'healthy', since: 456 });
  expect(a).toHaveBeenCalledTimes(2);
});
