import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, type SessionEnv } from '../session.ts';
import { Interest } from '../interest.ts';
import { DEFAULTS, type WorkerEvent } from '../messages.ts';
import type { PreparedWrite, WorkerModule, WorkerSessionContext } from '../modules.ts';
import type { Packet } from '../../protocol/Packet.ts';
import { Router } from '../../routing/router.ts';
import { createFactory } from '../../protocol/schema.ts';
import { RC4_KEYS } from '../../protocol/constants.ts';
import { RC4Cipher } from '../../protocol/RC4Cipher.ts';
import { frame, helloBytes, reconnectBytes, unknownId } from '../../testing/wire.ts';
import { connectGame, FakeServer, until, type Peer } from '../../testing/net.ts';

const factory = createFactory();
const id = (name: string) => factory.getPacketId(name)!;
const UNKNOWN = unknownId(factory);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function harness(overrides: Partial<SessionEnv> = {}) {
  const events: WorkerEvent[] = [];
  const sessions = new Map<string, Session>();
  let count = 0;
  const env: SessionEnv = {
    factory, router: new Router(), interest: new Interest(), modules: [],
    post: event => events.push(event), now: () => performance.now(),
    fallbackDestination: null, targetTimeoutMs: 1000, helloTimeoutMs: DEFAULTS.helloTimeoutMs,
    maxPendingBytes: DEFAULTS.maxPendingBytes, onClosed: sessionId => { sessions.delete(sessionId); },
    ...overrides,
  };
  const all: Session[] = [];
  const listener = net.createServer(socket => {
    const session = new Session(`s${++count}`, socket, env);
    sessions.set(session.id, session);
    all.push(session);
  });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  env.router = overrides.router ?? new Router({ loopbackPort: port });
  cleanups.push(() => new Promise<void>(resolve => { for (const s of all) s.close(); listener.close(() => resolve()); }));
  return { env, events, sessions, all, port };
}

async function fakeServer(): Promise<FakeServer> {
  const server = new FakeServer();
  await server.listen();
  cleanups.push(() => server.close());
  return server;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Game connects, sends HELLO, the main thread answers with `server` as the target. */
async function connected(h: Harness, server: FakeServer): Promise<{ game: Peer; upstream: Peer; session: Session }> {
  const peersBefore = server.peers.length;
  const game = await connectGame(h.port);
  cleanups.push(() => game.destroy());
  game.send(helloBytes(factory, Buffer.alloc(0)));
  await until(() => h.all.length > 0 && !!h.all.at(-1), 'session accepted');
  const session = h.all.at(-1)!;
  session.setTarget({ host: '127.0.0.1', port: server.port });
  await until(() => (server.peers[peersBefore]?.frames.length ?? 0) >= 1, 'HELLO upstream');
  return { game, upstream: server.peers[peersBefore], session };
}

const packets = (h: Harness) => h.events.filter((e): e is Extract<WorkerEvent, { type: 'packet' }> => e.type === 'packet');

describe('Session', () => {
  it('drops a newly guarded observation before posting it, then suppresses the next at entry', async () => {
    let armed = false;
    const observe = vi.fn(() => { armed = true; });
    const dropped = vi.fn();
    const module: WorkerModule = {
      id: 'guard', priority: 0, observe: { client: ['PLAYERHIT'] },
      createSession: () => ({ suppressEntry: name => name === 'PLAYERHIT' && armed, observe, dropped }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    game.send(frame(id('PLAYERHIT')));
    game.send(frame(id('PLAYERHIT')));
    game.send(frame(UNKNOWN, Buffer.from('after')));
    await until(() => upstream.frames.length === 2, 'unguarded following frame');
    expect(observe).toHaveBeenCalledOnce();
    expect(dropped).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 'PLAYERHIT', true, expect.any(Number));
    expect(packets(h)).toEqual([]);
    expect(upstream.frames[1].subarray(5).toString()).toBe('after');
  });

  it('exposes awaiting and ready deliveries, excluding drops immediately and old server generations', async () => {
    let context!: WorkerSessionContext;
    const module: WorkerModule = { id: 'pending', priority: 0, createSession: ctx => { context = ctx; return {}; } };
    const h = await harness({ modules: [module], now: () => 123,
      interest: new Interest({ verdict: { server: ['TEXT'], client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    upstream.send(frame(id('TEXT')));
    upstream.send(frame(UNKNOWN));
    upstream.send(frame(id('TEXT')));
    upstream.send(frame(id('TEXT')));
    game.send(frame(id('PLAYERHIT')));
    await until(() => packets(h).length === 4, 'all verdicts held');
    const texts = packets(h).filter(p => !p.fromClient);
    session.forward(texts[2].sequence, texts[2].generation, Buffer.from(texts[2].data));
    expect(context.pendingDelivery().filter(p => !p.fromClient)).toEqual([
      expect.objectContaining({ name: 'TEXT', receivedAt: 123, generation: 1, state: 'awaiting' }),
      expect.objectContaining({ name: factory.getPacketName(UNKNOWN, 'server'), state: 'ready' }),
      expect.objectContaining({ name: 'TEXT', state: 'awaiting' }),
      expect.objectContaining({ name: 'TEXT', state: 'ready' }),
    ]);
    const ids = context.pendingDelivery().map(p => p.observationId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    session.forward(texts[1].sequence, texts[1].generation, null);
    expect(context.pendingDelivery()).toHaveLength(4);
    expect(context.held()).toHaveLength(2); // Only the outstanding TEXT and PLAYERHIT verdicts.
    const next = await fakeServer();
    session['connect']({ host: '127.0.0.1', port: next.port }, helloBytes(factory, Buffer.alloc(0)));
    expect(context.pendingDelivery()).toEqual([expect.objectContaining({ name: 'PLAYERHIT', generation: 1 })]);
    await until(() => next.peers[0]?.frames.length === 1, 'new generation connected');
  });

  it('prepares final reports with correlated identities and outcomes before written callbacks', async () => {
    const prepared: PreparedWrite[] = [];
    const order: string[] = [];
    const observed: number[] = [];
    let context!: WorkerSessionContext;
    const module: WorkerModule = {
      id: 'prepare', priority: 0, observe: { client: ['PLAYERHIT'] }, prepare: ['PLAYERHIT', 'AOEACK'], written: ['PLAYERHIT', 'AOEACK'],
      createSession: ctx => {
        context = ctx;
        return {
          observe: (_p, _c, _n, oid) => { observed.push(oid); },
          prepareWrite: write => { prepared.push(write); order.push(`prepare:${write.token}`); },
          writeOutcome: (token, accepted) => { order.push(`outcome:${token}:${accepted}`); },
          written: (_p, _k, _n, oid) => { order.push(`written:${oid}`); },
          dropped: oid => { order.push(`dropped:${oid}`); },
        };
      },
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    const report = factory.serialize(factory.createByName('PLAYERHIT'));
    for (let i = 0; i < 3; i++) game.send(report);
    await until(() => packets(h).length === 3, 'reports held');
    const changed = factory.createByName('PLAYERHIT');
    changed.data.bulletId = 42;
    const replacements = [report, factory.serialize(changed), factory.serialize(factory.createByName('AOEACK'))];
    packets(h).forEach((p, i) => session.forward(p.sequence, p.generation, replacements[i]));
    expect(session.inject(report, false)).toBe(true);
    expect(context.writePriority(report, false, undefined, 'prepare')).toBe(true);
    await until(() => upstream.frames.length === 6, 'five reports accepted');
    expect(prepared.map(p => [p.packet.name, p.kind, p.observationId, p.origin])).toEqual([
      ['PLAYERHIT', 'normal', observed[0], null], ['PLAYERHIT', 'normal', observed[1], null],
      ['AOEACK', 'normal', null, null], ['PLAYERHIT', 'injected', null, null], ['PLAYERHIT', 'priority', null, 'prepare'],
    ]);
    expect(prepared[1].packet.data.bulletId).toBe(42);
    expect(new Set(prepared.map(p => p.token)).size).toBe(5);
    expect(order).toEqual(prepared.flatMap((p, i) => [
      ...(i === 2 ? [`dropped:${observed[2]}`] : []),
      `prepare:${p.token}`, `outcome:${p.token}:true`, `written:${p.observationId}`,
    ]));
  });

  it('writes nested priority ESCAPE before vetoing the prepared report without consuming its RC4', async () => {
    const prepared: PreparedWrite[] = [];
    const outcomes: unknown[][] = [];
    let guarded = false;
    const module: WorkerModule = {
      id: 'escape', priority: 0, prepare: ['PLAYERHIT', 'ESCAPE'],
      createSession: context => ({
        prepareWrite: write => {
          prepared.push(write);
          if (write.packet.name === 'PLAYERHIT') {
            expect(context.writePriority(frame(id('ESCAPE')), false, undefined, 'escape')).toBe(true);
            guarded = true;
          }
        },
        allowWrite: name => !(guarded && name === 'PLAYERHIT'),
        writeOutcome: (token, accepted) => { outcomes.push([token, accepted]); },
      }),
    };
    const h = await harness({ modules: [module] });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(factory.serialize(factory.createByName('PLAYERHIT')));
    game.send(frame(UNKNOWN, Buffer.from('aligned-upstream')));
    await until(() => upstream.frames.length === 3, 'ESCAPE and following frame');
    expect(upstream.frames[1].equals(frame(id('ESCAPE')))).toBe(true);
    expect(upstream.frames[2].subarray(5).toString()).toBe('aligned-upstream');
    expect(outcomes).toEqual([[prepared[1].token, true], [prepared[0].token, false]]);
    expect(prepared[0].token).not.toBe(prepared[1].token);
    upstream.send(frame(UNKNOWN, Buffer.from('aligned-game')));
    await until(() => game.frames.length === 1, 'opposite stream still aligned');
    expect(game.frames[0].subarray(5).toString()).toBe('aligned-game');
    expect(session['closed']).toBe(false);
  });

  it('prepares a pre-connect queued report once, only on flush, with its original observation id', async () => {
    let context!: WorkerSessionContext;
    const prepare = vi.fn();
    const outcome = vi.fn();
    const allow = vi.fn(() => true);
    const module: WorkerModule = { id: 'queue', priority: 0, prepare: ['PLAYERHIT'],
      createSession: ctx => { context = ctx; return { prepareWrite: prepare, writeOutcome: outcome, allowWrite: allow }; } };
    const h = await harness({ modules: [module] });
    const game = await connectGame(h.port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    game.send(factory.serialize(factory.createByName('PLAYERHIT')));
    await until(() => h.all[0]?.['beforeConnect'].length === 1, 'queued before target resolved');
    const observationId = h.all[0]['beforeConnect'][0].observation!.id;
    expect(prepare).not.toHaveBeenCalled();
    expect(allow).not.toHaveBeenCalled();
    expect(context.writePriority(frame(id('PLAYERHIT')), false)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    const server = await fakeServer();
    h.all[0].setTarget({ host: '127.0.0.1', port: server.port });
    await until(() => server.peers[0]?.frames.length === 2, 'queued report flushed');
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ observationId, kind: 'normal' }));
    expect(outcome).toHaveBeenCalledExactlyOnceWith(prepare.mock.calls[0][0].token, true, expect.any(Number));
    expect(allow).toHaveBeenCalledOnce();
  });

  it.each(['socket', 'close', 'veto-close', 'malformed'] as const)('finishes prepared writes on %s and never prepares malformed replacements', async failure => {
    const prepared = vi.fn();
    const outcome = vi.fn();
    const dropped = vi.fn();
    let session!: Session;
    const module: WorkerModule = { id: 'failure', priority: 0, observe: { client: ['PLAYERHIT'] }, prepare: ['PLAYERHIT'],
      createSession: () => ({
        prepareWrite: write => {
          prepared(write);
          if (failure === 'socket') session['server']!.destroy();
          if (failure === 'close') session.close();
        },
        allowWrite: () => { if (failure === 'veto-close') session.close(); return true; },
        writeOutcome: outcome, dropped,
      }) };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const connection = await connected(h, server);
    session = connection.session;
    connection.game.send(factory.serialize(factory.createByName('PLAYERHIT')));
    await until(() => packets(h).length === 1, 'held report');
    const p = packets(h)[0];
    session.forward(p.sequence, p.generation, failure === 'malformed' ? Buffer.from([0]) : Buffer.from(p.data));
    if (failure === 'malformed') {
      expect(prepared).not.toHaveBeenCalled();
      expect(outcome).not.toHaveBeenCalled();
    } else {
      expect(prepared).toHaveBeenCalledOnce();
      expect(outcome).toHaveBeenCalledExactlyOnceWith(prepared.mock.calls[0][0].token, false, expect.any(Number));
    }
    expect(dropped).toHaveBeenCalledOnce();
    expect(connection.upstream.frames).toHaveLength(1);
  });

  it('gives writtenServer the released RECONNECT identity and null for injected or renamed frames', async () => {
    const observed: number[] = [];
    const written = vi.fn();
    const dropped = vi.fn();
    const module: WorkerModule = { id: 'server-id', priority: 0, observe: { server: ['RECONNECT', 'TEXT'] }, writtenServer: ['RECONNECT'],
      createSession: () => ({ observe: (_p, _c, _n, oid) => { observed.push(oid); }, writtenServer: written, dropped }) };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { server: ['RECONNECT', 'TEXT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    const reconnect = reconnectBytes(factory, { host: 'localhost', port: server.port, key: Buffer.from('key') });
    upstream.send(reconnect);
    upstream.send(frame(id('TEXT')));
    await until(() => packets(h).length === 2, 'held server frames');
    packets(h).forEach(p => session.forward(p.sequence, p.generation, reconnect));
    expect(session.inject(reconnect, true)).toBe(true);
    await until(() => game.frames.length === 3, 'RECONNECT writes');
    expect(written.mock.calls.map(c => c[3])).toEqual([observed[0], null, null]);
    expect(written.mock.calls[0][0].rawBytes.equals(game.frames[0])).toBe(true);
    expect(dropped).toHaveBeenCalledExactlyOnceWith(observed[1], 'TEXT', false, expect.any(Number));
  });

  it('isolates throwing preparation and outcome hooks while preserving module priority and outcomes', async () => {
    const calls: string[] = [];
    const modules: WorkerModule[] = [2, 1].map(priority => ({
      id: `prepare-${priority}`, priority, prepare: ['PLAYERHIT'],
      createSession: () => ({
        prepareWrite: () => { calls.push(`prepare:${priority}`); if (priority === 1) throw new Error('prepare failure'); },
        writeOutcome: (_token, accepted) => { calls.push(`outcome:${priority}:${accepted}`); if (priority === 1) throw new Error('outcome failure'); },
      }),
    }));
    const h = await harness({ modules });
    const server = await fakeServer();
    const { upstream, session } = await connected(h, server);
    expect(session.inject(factory.serialize(factory.createByName('PLAYERHIT')), false)).toBe(true);
    await until(() => upstream.frames.length === 2, 'report despite hook errors');
    expect(calls).toEqual(['prepare:1', 'prepare:2', 'outcome:1:true', 'outcome:2:true']);
    for (const hook of ['prepareWrite', 'writeOutcome']) {
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining(`prepare-1.${hook} failed:`) }));
    }
  });

  it.each([null, undefined, 'hook failed', new Error('hook failed'), {}])('isolates tick, observe and allowWrite hooks throwing %s', thrown => {
    const events: WorkerEvent[] = [];
    const later = { tick: vi.fn(), observe: vi.fn(), allowWrite: vi.fn(() => true) };
    const broken: WorkerModule = { id: 'broken', priority: 0, observe: { server: ['PING'] },
      createSession: () => ({ tick() { throw thrown; }, observe() { throw thrown; }, allowWrite() { throw thrown; } }) };
    const healthy: WorkerModule = { id: 'healthy', priority: 1, observe: { server: ['PING'] }, createSession: () => later };
    const client = new net.Socket();
    const session = new Session('isolated', client, {
      factory, router: new Router(), interest: new Interest(), modules: [broken, healthy],
      post: e => events.push(e), now: () => 1000, fallbackDestination: null, targetTimeoutMs: 1000,
      helloTimeoutMs: DEFAULTS.helloTimeoutMs, maxPendingBytes: DEFAULTS.maxPendingBytes, onClosed() {},
    });
    cleanups.push(() => session.close());
    expect(() => session.tick(1000)).not.toThrow();
    // Feed an actual encrypted observation without opening sockets; refuse the client write harmlessly.
    const ping = factory.serialize(factory.createByName('PING'));
    new RC4Cipher(RC4_KEYS.serverToClient).cipher(ping);
    session['receive'](ping, false, session['serverFrames']);
    expect(session.inject(factory.serialize(factory.createByName('PONG')), false)).toBe(true);
    expect(later.allowWrite).toHaveBeenCalledOnce(); // Queuing does not reach the final writer.
    const queued = session['beforeConnect'][0];
    session['serverReady'] = true;
    // Exercise the queued write's hook isolation without opening an upstream socket.
    expect(session['write'](queued.data, false, queued.kind, undefined, queued.observation)).toBe(false);
    expect(later.tick).toHaveBeenCalledOnce();
    expect(later.observe).toHaveBeenCalledOnce();
    expect(later.allowWrite).toHaveBeenCalledTimes(2);
    for (const hook of ['tick', 'observe', 'allowWrite']) {
      expect(events.some(e => e.type === 'diagnostic' && e.message.includes(`broken.${hook} failed:`))).toBe(true);
    }
    expect(events.some(e => e.type === 'fault' || e.type === 'closed')).toBe(false);
    expect(session['closed']).toBe(false);
  });

  it('confirms only accepted server writes with the rewritten RECONNECT', async () => {
    const written: Packet[] = [];
    const module: WorkerModule = {
      id: 'transfer', priority: 0, writtenServer: ['RECONNECT'],
      createSession: () => ({ writtenServer: packet => { written.push(packet); } }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { server: ['RECONNECT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    const reconnect = reconnectBytes(factory, { host: 'localhost', port: server.port, key: Buffer.from('real-key') });
    upstream.send(reconnect);
    await until(() => packets(h).length === 1, 'held RECONNECT');
    expect(written).toEqual([]);
    const held = packets(h)[0];
    session.forward(held.sequence, held.generation, Buffer.from(held.data));
    await until(() => game.frames.length === 1, 'accepted RECONNECT');
    expect(written).toHaveLength(1);
    expect(written[0].data).toMatchObject({ host: '127.0.0.1', port: h.port });
    expect(written[0].rawBytes.equals(game.frames[0])).toBe(true);

    upstream.send(reconnect);
    await until(() => packets(h).length === 2, 'dropped RECONNECT');
    const dropped = packets(h)[1];
    session.forward(dropped.sequence, dropped.generation, null);
    // A complete frame with an invalid route must not confirm a transfer either.
    expect(session.inject(reconnectBytes(factory, { host: 'bad host', port: server.port, key: Buffer.alloc(0) }), true)).toBe(false);
    // A valid route still needs an accepting game-socket writer.
    const client = session['client'];
    const writable = vi.spyOn(client, 'writable', 'get').mockReturnValue(false);
    try { expect(session.inject(reconnect, true)).toBe(false); }
    finally { writable.mockRestore(); }
    expect(written).toHaveLength(1);
    expect(game.frames).toHaveLength(1);
  });

  it('reports the priority origin and null for a released client packet', async () => {
    let context!: WorkerSessionContext;
    const writes: unknown[][] = [];
    const module: WorkerModule = {
      id: 'm1', priority: 0, written: ['ESCAPE'],
      createSession: ctx => {
        context = ctx;
        return { written: (_packet, kind, _now, observationId, origin) => { writes.push([kind, observationId, origin]); } };
      },
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['ESCAPE'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    const done = vi.fn();
    expect(context.writePriority(frame(id('ESCAPE')), false, done, 'm1')).toBe(true);
    game.send(frame(id('ESCAPE')));
    await until(() => packets(h).length === 1, 'held ESCAPE');
    const held = packets(h)[0];
    session.forward(held.sequence, held.generation, Buffer.from(held.data));
    await until(() => upstream.frames.length === 3 && done.mock.calls.length === 1, 'both ESCAPEs');
    expect(writes).toEqual([['priority', null, 'm1'], ['normal', expect.any(Number), null]]);
    expect(context.writePriority(frame(id('ESCAPE')), false)).toBe(true);
    expect(session.inject(frame(id('ESCAPE')), false)).toBe(true);
    expect(writes.slice(2)).toEqual([['priority', null, null], ['injected', null, null]]);
  });

  it('decodes accepted server writes only for subscribers and shares the final decode', async () => {
    const written: Packet[] = [];
    const modules: WorkerModule[] = ['a', 'b'].map(moduleId => ({
      id: moduleId, priority: 0, writtenServer: ['PING'],
      createSession: () => ({ writtenServer: packet => { written.push(packet); } }),
    }));
    const h = await harness({ modules });
    const server = await fakeServer();
    const { session } = await connected(h, server);
    const ping = factory.serialize(factory.createByName('PING'));
    const decode = vi.spyOn(factory, 'createFromBytes');
    // Node write(false) still accepts the frame; callbacks must run immediately.
    const write = vi.spyOn(session['client'], 'write').mockReturnValue(false);
    try {
      expect(session.inject(frame(UNKNOWN), true)).toBe(true);
      expect(decode).not.toHaveBeenCalled();
      expect(session.inject(ping, true)).toBe(true);
      expect(written).toHaveLength(2);
      expect(written[0]).toBe(written[1]);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      write.mockRestore();
      decode.mockRestore();
    }
  });

  it('reports upstream backpressure separately from held verdicts', async () => {
    let context!: WorkerSessionContext;
    const module: WorkerModule = { id: 'pressure', priority: 0, createSession: ctx => { context = ctx; return {}; } };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['ESCAPE'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    expect(context.transport()).toMatchObject({ available: true, upstreamBackpressure: false });
    game.send(frame(id('ESCAPE')));
    await until(() => packets(h).length === 1, 'held verdict');
    expect(context.transport()).toMatchObject({ backlog: true, upstreamBackpressure: false });
    upstream['socket'].pause();
    const large = frame(UNKNOWN, Buffer.alloc(64 * 1024));
    for (let i = 0; i < 128 && !session['server']!.writableNeedDrain; i++) {
      expect(context.writePriority(large, false)).toBe(true);
    }
    expect(session['server']!.writableNeedDrain).toBe(true);
    expect(context.transport().upstreamBackpressure).toBe(true);
  });

  it('shares automation within a session and resets it before connectionChanged on every generation', async () => {
    const contexts: WorkerSessionContext[] = [];
    const changes: unknown[][] = [];
    const modules: WorkerModule[] = ['a', 'b'].map(moduleId => ({
      id: moduleId, priority: 0,
      createSession: context => {
        contexts.push(context);
        expect(context.transport().upstreamBackpressure).toBe(false);
        context.automation.latchEscape('before connect');
        return { connectionChanged: generation => {
          changes.push([context.sessionId, moduleId, generation, context.automation.generation, context.automation.escapeLatched()]);
        } };
      },
    }));
    const h = await harness({ modules, helloTimeoutMs: 100 });
    const server = await fakeServer();
    const { session } = await connected(h, server);
    expect(contexts[0].automation).toBe(contexts[1].automation);
    contexts[0].automation.latchEscape('manual escape');
    expect(contexts[1].automation.escapeLatched()).toBe(true);
    await until(() => changes.length >= 4, 'upstream retry');
    expect(changes.slice(0, 4)).toEqual([
      [session.id, 'a', 1, 1, false], [session.id, 'b', 1, 1, false],
      [session.id, 'a', 2, 2, false], [session.id, 'b', 2, 2, false],
    ]);
    const second = await connected(h, server);
    expect(contexts[2].automation).not.toBe(contexts[0].automation);
    expect(contexts[2].automation).toBe(contexts[3].automation);
    expect(second.session.id).not.toBe(session.id);
    contexts[0].automation.latchEscape('auto escape');
    expect(contexts[2].automation.escapeLatched()).toBe(false);
  });

  it('faults when the game stops reading and output exceeds 64 KiB', async () => {
    const h = await harness({ maxPendingBytes: 64 * 1024 });
    const server = await fakeServer();
    const game = net.connect(h.port, '127.0.0.1');
    cleanups.push(() => { game.destroy(); });
    game.on('error', () => {});
    await new Promise<void>(resolve => game.once('connect', resolve));
    const hello = helloBytes(factory, Buffer.alloc(0));
    new RC4Cipher(RC4_KEYS.clientToServer).cipher(hello);
    game.write(hello);
    game.pause();
    await until(() => h.all.length === 1, 'raw game accepted');
    h.all[0].setTarget({ host: '127.0.0.1', port: server.port });
    await until(() => server.peers[0]?.frames.length === 1, 'raw game HELLO upstream');
    for (let i = 0; i < 256; i++) server.peers[0].send(frame(UNKNOWN, Buffer.alloc(16 * 1024)));
    await until(() => h.events.some(e => e.type === 'fault' && e.message.includes('not reading')), 'output backlog fault', 3000);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'fault', message: 'Game is not reading; output backlog exceeded the limit',
    }));
  });

  it('drops the server TEXT observation when a different packet is written to the game', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    const module: WorkerModule = {
      id: 'server-ledger', priority: 0, observe: { server: ['TEXT'] }, written: ['PING'],
      createSession: () => ({
        observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
        dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
        written: () => { outcomes.push('unexpected written callback'); },
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { server: ['TEXT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    upstream.send(factory.serialize(factory.createByName('TEXT')));
    await until(() => packets(h).length === 1, 'held server TEXT');
    const [report] = packets(h);
    expect(ids).toHaveLength(1);
    const replacement = factory.serialize(factory.createByName('PING'));
    session.forward(report.sequence, report.generation, replacement);
    await until(() => game.frames.length === 1, 'replacement PING at game');
    expect(game.frames[0].equals(replacement)).toBe(true);
    expect(outcomes).toEqual([`dropped:${ids[0]}:TEXT`]);
  });

  it('connects to the resolved destination and relays both directions unchanged', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    expect(factory.createFromBytes(upstream.frames[0], 'client').name).toBe('HELLO');

    const fromServer = frame(UNKNOWN, Buffer.from('payload'));
    upstream.send(fromServer);
    await until(() => game.frames.length === 1, 'server frame at game');
    expect(game.frames[0].equals(fromServer)).toBe(true);

    const fromGame = frame(id('MOVE'), Buffer.from([1, 2, 3]));
    game.send(fromGame);
    await until(() => upstream.frames.length === 2, 'game frame upstream');
    expect(upstream.frames[1].equals(fromGame)).toBe(true);
    expect(h.events.map(e => e.type)).toEqual(expect.arrayContaining(['opened', 'routed', 'connected']));
    expect(packets(h)).toHaveLength(0);
  });

  it('holds verdict packets, keeps later packets behind them, and applies drop or replace', async () => {
    const h = await harness({ interest: new Interest({ verdict: { server: ['TEXT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    upstream.send(frame(id('TEXT'), Buffer.from('spam')));
    upstream.send(frame(UNKNOWN, Buffer.from('after-1')));
    upstream.send(frame(id('TEXT'), Buffer.from('hello')));
    upstream.send(frame(UNKNOWN, Buffer.from('after-2')));
    await until(() => packets(h).length === 2, 'two verdict events');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(game.frames).toHaveLength(0);

    const [spam, hello] = packets(h);
    expect(spam.observeOnly).toBe(false);
    const replacement = frame(id('TEXT'), Buffer.from('HELLO!'));
    session.forward(hello.sequence, hello.generation, replacement); // out of order: still held behind spam
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(game.frames).toHaveLength(0);
    session.forward(spam.sequence, spam.generation, null);
    await until(() => game.frames.length === 3, 'released in order');
    expect(game.frames.map(f => f.subarray(5).toString())).toEqual(['after-1', 'HELLO!', 'after-2']);
  });

  it('posts observe-only packets without holding traffic', async () => {
    const h = await harness({ interest: new Interest({ observe: { server: ['MAPINFO'] } }) });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('MAPINFO'), Buffer.from('map')));
    await until(() => game.frames.length === 1 && packets(h).length === 1, 'forwarded and observed');
    expect(packets(h)[0].observeOnly).toBe(true);
  });

  it('loops RECONNECT back through the proxy and restores the real key on the next HELLO', async () => {
    const h = await harness();
    const first = await fakeServer();
    const second = await fakeServer();
    const { game, upstream } = await connected(h, first);
    const realKey = Buffer.from([0, 0xff, 0x80, 0x42]);
    const tail = Buffer.from([0xde, 0xad, 0x00, 0xff]);
    upstream.send(reconnectBytes(factory, { host: '127.0.0.1', port: second.port, key: realKey, gameId: 7, keyTime: 99 }, tail));
    await until(() => game.frames.length === 1, 'rewritten RECONNECT');
    const rewritten = factory.createFromBytes(game.frames[0], 'server');
    expect(rewritten.data).toMatchObject({ host: '127.0.0.1', port: h.port, gameId: 7, keyTime: 99 });
    expect(rewritten.unreadData.equals(tail)).toBe(true);
    const token = rewritten.data.key as Buffer;
    expect(token.equals(realKey)).toBe(false);

    const game2 = await connectGame(h.port);
    cleanups.push(() => game2.destroy());
    game2.send(helloBytes(factory, token, { gameId: 7 }));
    await until(() => h.all.length === 2, 'second session');
    h.all[1].setTarget(null); // the helper records nothing for loopback connects
    await until(() => second.peers[0]?.frames.length === 1, 'HELLO at the second server');
    const upstreamHello = factory.createFromBytes(second.peers[0].frames[0], 'client');
    expect((upstreamHello.data.key as Buffer).equals(realKey)).toBe(true);
    expect(upstreamHello.data).toMatchObject({ gameId: 7, accessToken: 'token-abc' });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'routed', id: 's2', restored: true, port: second.port }));
  });

  it('drops a malformed RECONNECT and keeps relaying', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('RECONNECT'), Buffer.from([0, 5, 1])));
    upstream.send(frame(UNKNOWN, Buffer.from('after')));
    await until(() => game.frames.length === 1, 'next frame');
    expect(game.frames[0][4]).toBe(UNKNOWN);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('RECONNECT') }));
  });

  it('faults clearly when no destination is known', async () => {
    const h = await harness();
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    h.all[0].setTarget(null);
    await until(() => game.closed, 'game socket closed');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'fault', message: expect.stringContaining('No destination') }));
    expect(h.events.filter(e => e.type === 'closed')).toEqual([{ type: 'closed', id: 's1', by: 'fault' }]);
  });

  it('uses the fallback server when the main thread does not answer in time', async () => {
    const server = await fakeServer();
    const h = await harness({ targetTimeoutMs: 30, fallbackDestination: { host: '127.0.0.1', port: server.port } });
    const game = await connectGame(h.port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO via fallback');
  });

  it('survives the game disconnecting while its HELLO is held', async () => {
    const h = await harness({ targetTimeoutMs: 5000 });
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    game.destroy();
    await until(() => h.events.some(e => e.type === 'closed'), 'closed');
    h.all[0].setTarget({ host: '127.0.0.1', port: 1 }); // late answer: must be ignored
    expect(h.events.filter(e => e.type === 'closed')).toEqual([{ type: 'closed', id: 's1', by: 'game' }]);
    expect(h.sessions.size).toBe(0);
  });

  it('faults instead of buffering without bound when verdicts never come back', async () => {
    const h = await harness({ interest: new Interest({ verdict: { server: ['TEXT'] } }), maxPendingBytes: 64 * 1024 });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    for (let i = 0; i < 20; i++) upstream.send(frame(id('TEXT'), Buffer.alloc(8 * 1024)));
    await until(() => game.closed, 'session faulted');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'fault', message: expect.stringContaining('backlog') }));
  });

  it('retries an unanswered HELLO three times, then faults', async () => {
    const h = await harness({ helloTimeoutMs: 40 });
    const silent = await fakeServer();
    const game = await connectGame(h.port);
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => h.all.length === 1, 'session');
    h.all[0].setTarget({ host: '127.0.0.1', port: silent.port });
    await until(() => game.closed, 'gave up', 3000);
    expect(silent.peers.filter(peer => peer.frames.length === 1)).toHaveLength(4);
    expect(h.events.filter(e => e.type === 'diagnostic')).toHaveLength(3);
  });

  it('releases the retry HELLO after the first server frame', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    expect(session['helloForRetry']).not.toBeNull();
    upstream.send(frame(UNKNOWN));
    await until(() => game.frames.length === 1, 'first server frame');
    expect(session['helloForRetry']).toBeNull();
    expect(session['heldHello']).toBeNull();
    expect(session['beforeConnect']).toEqual([]);
    expect(session['helloTimer']).toBeNull();
    expect(h.sessions.has(session.id)).toBe(true);
  });

  it.each(['close', 'fault'])('releases the retry HELLO on %s before a server response', async ending => {
    const h = await harness();
    const server = await fakeServer();
    const { game, session } = await connected(h, server);
    expect(session['helloForRetry']).not.toBeNull();
    if (ending === 'close') session.close();
    else game.send(Buffer.alloc(5)); // Invalid frame length faults the session.
    await until(() => game.closed, 'session closed');
    expect(session['helloForRetry']).toBeNull();
    expect(h.events.filter(e => e.type === 'closed')).toEqual([
      { type: 'closed', id: session.id, by: ending === 'close' ? 'proxy' : 'fault' },
    ]);
  });

  it('releases HELLO when closed while waiting for a destination', async () => {
    const h = await harness({ targetTimeoutMs: 5000 });
    const game = await connectGame(h.port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => !!h.all[0]?.['heldHello'], 'HELLO held for routing');
    const session = h.all[0];
    session.close();
    expect(session['heldHello']).toBeNull();
    expect(session['helloForRetry']).toBeNull();
  });

  it('runs worker modules before the main thread: entry suppression, observe + priority write, writer veto', async () => {
    const observed: string[] = [];
    const module: WorkerModule = {
      id: 'test', priority: 0, observe: { server: ['DAMAGE'] },
      createSession: context => ({
        suppressEntry: (name, fromClient) => fromClient && name === 'PLAYERHIT',
        observe: packet => {
          observed.push(packet.name);
          context.writePriority(frame(id('ESCAPE')), false);
        },
        allowWrite: (name, toClient) => !(toClient === false && name === 'MOVE'),
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { server: ['DAMAGE'] } }) });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);

    upstream.send(frame(id('DAMAGE')));
    // ESCAPE reaches the server although DAMAGE is still waiting for a main-thread verdict.
    await until(() => upstream.frames.length === 2, 'priority ESCAPE');
    expect(upstream.frames[1][4]).toBe(id('ESCAPE'));
    expect(observed).toEqual(['DAMAGE']);
    expect(game.frames).toHaveLength(0);

    game.send(frame(id('PLAYERHIT')));
    game.send(frame(id('MOVE')));
    game.send(frame(UNKNOWN));
    await until(() => upstream.frames.length === 3, 'later client frame');
    expect(upstream.frames[2][4]).toBe(UNKNOWN); // PLAYERHIT swallowed at entry, MOVE vetoed at the writer
  });

  it('links each observed report to exactly one written or dropped outcome, and exposes held packets', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    let held: () => readonly { name: string }[] = () => [];
    const module: WorkerModule = {
      id: 'ledger', priority: 0, observe: { client: ['PLAYERHIT'] }, written: ['PLAYERHIT'],
      createSession: context => {
        held = () => context.held();
        return {
          observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
          written: (_packet, kind, _now, observationId) => { outcomes.push(`written:${observationId}:${kind}`); },
          dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
        };
      },
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(frame(id('PLAYERHIT'), Buffer.from([1])));
    game.send(frame(id('PLAYERHIT'), Buffer.from([2])));
    await until(() => packets(h).length === 2, 'two held reports');
    expect(held().map(p => p.name)).toEqual(['PLAYERHIT', 'PLAYERHIT']);
    const [first, second] = packets(h);
    session.forward(first.sequence, first.generation, Buffer.from(first.data));
    session.forward(second.sequence, second.generation, null);
    await until(() => outcomes.length === 2, 'both outcomes');
    expect(outcomes).toEqual([`written:${ids[0]}:normal`, `dropped:${ids[1]}:PLAYERHIT`]);
    expect(held()).toEqual([]);
    await until(() => upstream.frames.length === 2, 'passed report upstream');
    expect(upstream.frames).toHaveLength(2); // HELLO + the passed report
  });

  it('drops the original observation when a replacement MOVE is vetoed', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    const module: WorkerModule = {
      id: 'ledger', priority: 0, observe: { client: ['PLAYERHIT'] }, written: ['PLAYERHIT'],
      createSession: () => ({
        observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
        allowWrite: name => name !== 'MOVE',
        written: (_packet, _kind, _now, observationId) => { outcomes.push(`written:${observationId}`); },
        dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(frame(id('PLAYERHIT')));
    await until(() => packets(h).length === 1, 'held report');
    const [report] = packets(h);
    expect(ids).toHaveLength(1);
    session.forward(report.sequence, report.generation, frame(id('MOVE')));
    expect(outcomes).toEqual([`dropped:${ids[0]}:PLAYERHIT`]);
    game.send(frame(UNKNOWN));
    await until(() => upstream.frames.length === 2, 'frame after veto upstream');
    expect(upstream.frames[1][4]).toBe(UNKNOWN);
    expect(outcomes).toEqual([`dropped:${ids[0]}:PLAYERHIT`]);
  });

  it('drops the original observation when replacement bytes are malformed', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    const module: WorkerModule = {
      id: 'ledger', priority: 0, observe: { client: ['PLAYERHIT'] }, written: ['PLAYERHIT'],
      createSession: () => ({
        observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
        written: (_packet, _kind, _now, observationId) => { outcomes.push(`written:${observationId}`); },
        dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(frame(id('PLAYERHIT')));
    await until(() => packets(h).length === 1, 'held report');
    const [report] = packets(h);
    expect(ids).toHaveLength(1);
    session.forward(report.sequence, report.generation, Buffer.from([0]));
    expect(outcomes).toEqual([`dropped:${ids[0]}:PLAYERHIT`]);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('malformed') }));
    game.send(frame(UNKNOWN));
    await until(() => upstream.frames.length === 2, 'frame after malformed replacement upstream');
    expect(upstream.frames[1][4]).toBe(UNKNOWN);
    expect(outcomes).toEqual([`dropped:${ids[0]}:PLAYERHIT`]);
  });

  it('drops the original observation when a replacement MOVE is written upstream', async () => {
    const outcomes: string[] = [];
    const ids: number[] = [];
    const module: WorkerModule = {
      id: 'ledger', priority: 0, observe: { client: ['PLAYERHIT'] }, written: ['PLAYERHIT'],
      createSession: () => ({
        observe: (_packet, _fromClient, _now, observationId) => { ids.push(observationId); },
        written: (_packet, _kind, _now, observationId) => { outcomes.push(`written:${observationId}`); },
        dropped: (observationId, name) => { outcomes.push(`dropped:${observationId}:${name}`); },
      }),
    };
    const h = await harness({ modules: [module], interest: new Interest({ verdict: { client: ['PLAYERHIT'] } }) });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    game.send(frame(id('PLAYERHIT')));
    await until(() => packets(h).length === 1, 'held report');
    const [report] = packets(h);
    expect(ids).toHaveLength(1);
    const replacement = factory.serialize(factory.createByName('MOVE'));
    session.forward(report.sequence, report.generation, replacement);
    await until(() => upstream.frames.length === 2, 'replacement MOVE upstream');
    expect(upstream.frames[1].equals(replacement)).toBe(true);
    expect(upstream.frames[1][4]).toBe(id('MOVE'));
    expect(outcomes).toEqual([`dropped:${ids[0]}:PLAYERHIT`]);
  });

  it('reports a throwing module hook and lets traffic pass', async () => {
    const module: WorkerModule = {
      id: 'broken', priority: 0,
      createSession: () => ({ allowWrite: () => { throw new Error('oops'); } }),
    };
    const h = await harness({ modules: [module] });
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(UNKNOWN, Buffer.from('x')));
    await until(() => game.frames.length === 1, 'passed');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('broken.allowWrite failed: oops') }));
  });

  it('lets the main thread observe the HELLO it routed, read-only', async () => {
    const h = await harness({ interest: new Interest({ verdict: { client: ['HELLO'] } }) });
    const server = await fakeServer();
    const { upstream } = await connected(h, server);
    const hellos = packets(h).filter(e => e.fromClient && factory.getPacketName(e.data[4], 'client') === 'HELLO');
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toMatchObject({ sequence: 0, observeOnly: true });
    expect(Buffer.from(hellos[0].data).equals(upstream.frames[0])).toBe(true);
  });

  it('does not post HELLO when nobody is interested', async () => {
    const h = await harness();
    const server = await fakeServer();
    await connected(h, server);
    expect(packets(h)).toHaveLength(0);
  });
});

describe('Session tracing', () => {
  const notes = (h: Harness) => h.events.filter((e): e is Extract<WorkerEvent, { type: 'note' }> => e.type === 'note').map(e => e.message);
  const faults = (h: Harness) => h.events.filter((e): e is Extract<WorkerEvent, { type: 'fault' }> => e.type === 'fault').map(e => e.message);

  it('logs a delivery summary when the session closes', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('MAPINFO')));
    upstream.send(frame(id('NEWTICK')));
    await until(() => game.frames.length === 2, 'server frames delivered');
    game.destroy();
    await until(() => h.events.some(e => e.type === 'closed'), 'closed');
    const summary = notes(h).find(m => m.startsWith('Session summary'));
    expect(summary).toMatch(/game→proxy 1 frames .*proxy→server 1 frames .*server→proxy 2 frames .*, first \d+ ms after HELLO/);
    expect(summary).toContain('proxy→game 2 frames');
    expect(summary).toContain('first server packets: MAPINFO, NEWTICK');
    const order = h.events.map(e => e.type);
    expect(order.lastIndexOf('note')).toBeLessThan(order.indexOf('closed'));
  });

  it('notes when the game itself asks for the Nexus', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    game.send(frame(id('ESCAPE')));
    await until(() => upstream.frames.length === 2, 'ESCAPE forwarded');
    expect(notes(h)).toContain('Game sent ESCAPE (Nexus request)');
  });

  it('names the game socket when the game resets the connection', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game } = await connected(h, server);
    game.reset();
    await until(() => h.events.some(e => e.type === 'closed'), 'closed');
    expect(faults(h)[0]).toMatch(/^Game connection error \(/);
    expect(notes(h).some(m => m.startsWith('Session summary'))).toBe(true);
  });

  it('names the server socket when the server resets after answering', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.send(frame(id('MAPINFO')));
    await until(() => game.frames.length === 1, 'server answered');
    upstream.reset();
    await until(() => h.events.some(e => e.type === 'closed'), 'closed');
    expect(faults(h)[0]).toMatch(/^Server connection error \(/);
    await until(() => game.closed, 'game closed');
    expect(game.errors.map(e => (e as NodeJS.ErrnoException).code)).toContain('ECONNRESET');
  });

  it('passes a reset straight after HELLO on to the game instead of closing it cleanly', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    upstream.reset();
    await until(() => game.closed, 'game closed');
    expect(faults(h)[0]).toMatch(/reset the connection \d+ ms after HELLO .*not retrying$/);
    expect(game.errors.map(e => (e as NodeJS.ErrnoException).code)).toContain('ECONNRESET');
  });
});
