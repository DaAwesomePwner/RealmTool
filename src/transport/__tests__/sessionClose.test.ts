import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, type SessionEnv } from '../session.ts';
import { Interest } from '../interest.ts';
import { DEFAULTS, type WorkerEvent } from '../messages.ts';
import { Router } from '../../routing/router.ts';
import { createFactory } from '../../protocol/schema.ts';
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

describe('Session server close safety', () => {
  it('drops an undecodable RECONNECT with a diagnostic and keeps relaying on the current route', async () => {
    const h = await harness();
    const server = await fakeServer();
    const { game, upstream } = await connected(h, server);
    const after = frame(UNKNOWN, Buffer.from('after'));
    upstream.send(frame(id('RECONNECT'), Buffer.from([0, 5, 1])));
    upstream.send(after);
    await until(() => game.frames.length === 1, 'following frame');
    expect(game.frames).toEqual([after]);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'diagnostic', message: 'Dropped a malformed RECONNECT; the current route is unchanged',
    }));
    game.send(after);
    await until(() => upstream.frames.length === 2, 'same server receives client traffic');
    expect(upstream.frames[1]).toEqual(after);
  });

  it('preserves a decided drop queued behind an undecided verdict at FIN', async () => {
    const dropped = vi.fn();
    const h = await harness({
      interest: new Interest({ verdict: { server: ['TEXT'] } }),
      modules: [{ id: 'drops', priority: 0, observe: { server: ['TEXT'] },
        createSession: () => ({ dropped }) }],
    });
    const server = await fakeServer();
    const { game, upstream, session } = await connected(h, server);
    const held = frame(id('TEXT'), Buffer.from('held'));
    const drop = frame(id('TEXT'), Buffer.from('drop'));
    const after = frame(UNKNOWN, Buffer.from('after'));
    upstream.send(held);
    upstream.send(drop);
    upstream.send(after);
    await until(() => packets(h).length === 2, 'both verdicts held');
    const verdict = packets(h)[1];
    session.forward(verdict.sequence, verdict.generation, null);
    expect(game.frames).toEqual([]);
    upstream['socket'].end();
    await until(() => game.closed, 'FIN reaches game');
    expect(game.errors).toEqual([]);
    expect(game.frames).toEqual([held, after]);
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledWith(expect.any(Number), 'TEXT', false, expect.any(Number));
  });

  for (const ending of ['timeout', 'peer-close', 'fault', 'game'] as const) {
    it(`closes once and handles game socket teardown: ${ending}`, async () => {
      const close = vi.fn();
      const onClosed = vi.fn();
      const h = await harness({ onClosed, modules: [
        { id: 'close', priority: 0, createSession: () => ({ close }) },
      ] });
      vi.useFakeTimers();
      const socket = new net.Socket();
      const end = vi.spyOn(socket, 'end').mockReturnValue(socket);
      const destroy = vi.spyOn(socket, 'destroy').mockReturnValue(socket);
      const reset = vi.spyOn(socket, 'resetAndDestroy').mockReturnValue(socket);
      try {
        const session = new Session('teardown', socket, h.env);
        const by = ending === 'fault' || ending === 'game' ? ending : 'server';
        session.close(by);
        if (by === 'server') {
          expect(end).toHaveBeenCalledTimes(1);
          expect(destroy).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(1);
          vi.advanceTimersByTime(1999);
          expect(destroy).not.toHaveBeenCalled();
          if (ending === 'peer-close') socket.emit('close');
          vi.advanceTimersByTime(1);
          expect(destroy).toHaveBeenCalledTimes(ending === 'timeout' ? 1 : 0);
        } else {
          expect(end).not.toHaveBeenCalled();
          expect(reset).toHaveBeenCalledTimes(by === 'fault' ? 1 : 0);
          expect(destroy).toHaveBeenCalledTimes(by === 'game' ? 1 : 0);
        }
        socket.emit('close');
        session.close();
        expect(close).toHaveBeenCalledExactlyOnceWith(by);
        expect(onClosed).toHaveBeenCalledExactlyOnceWith('teardown');
        expect(h.events.filter(e => e.type === 'closed')).toEqual([{ type: 'closed', id: 'teardown', by }]);
        expect(h.events.filter(e => e.type === 'note')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
        socket.destroy();
      }
    });
  }

  for (const reconnect of [false, true]) {
    it(`delivers queued frames before graceful FIN (RECONNECT: ${reconnect})`, async () => {
      const router = new Router({ loopbackPort: 2050 });
      const h = await harness({ router, interest: new Interest({ verdict: { server: ['TEXT'] } }) });
      const server = await fakeServer();
      const { game, upstream } = await connected(h, server);
      const held = frame(id('TEXT'), Buffer.from('held'));
      const after = frame(UNKNOWN, Buffer.from('after'));
      upstream.send(held);
      await until(() => packets(h).length === 1, 'verdict held');
      expect(game.frames).toHaveLength(0);
      upstream.send(after);
      if (reconnect) upstream.send(reconnectBytes(factory, { host: 'destination.example', port: 2051, key: Buffer.from('real-key') }));
      // Peer has no FIN helper; end its socket without destroying buffered writes.
      let framesAtClose: Buffer[] = [];
      game['socket'].once('close', () => { framesAtClose = [...game.frames]; });
      upstream['socket'].end();
      await until(() => game.closed, 'graceful close reaches game');
      expect(framesAtClose).toEqual(game.frames);
      expect(game.errors).toEqual([]);
      expect(game.frames.slice(0, 2)).toEqual([held, after]);
      expect(game.frames).toHaveLength(reconnect ? 3 : 2);
      if (reconnect) {
        const rewritten = factory.createFromBytes(game.frames[2], 'server');
        expect(rewritten.data).toMatchObject({ host: '127.0.0.1', port: 2050 });
        const route = router.routeHello(factory.createFromBytes(helloBytes(factory, rewritten.data.key as Buffer), 'client'), null);
        expect(route?.destination).toEqual({ host: 'destination.example', port: 2051 });
      }
    });
  }
});
