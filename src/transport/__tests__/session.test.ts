import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { Session, type SessionEnv } from '../session.ts';
import { Interest } from '../interest.ts';
import { DEFAULTS, type WorkerEvent } from '../messages.ts';
import type { WorkerModule } from '../modules.ts';
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
