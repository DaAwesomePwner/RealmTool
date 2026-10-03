import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyHost } from '../host.ts';
import { createFactory, loadSchema } from '../../protocol/schema.ts';
import { frame, helloBytes, unknownId } from '../../testing/wire.ts';
import { connectGame, FakeServer, until } from '../../testing/net.ts';

const factory = createFactory();
const UNKNOWN = unknownId(factory);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe('ProxyHost', () => {
  it('runs sessions in the worker thread and supplies helper targets from the main thread', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const host = new ProxyHost({
      schema: loadSchema(), listenPort: 0,
      resolveTarget: () => ({ host: '127.0.0.1', port: server.port }),
      interest: { verdict: { server: ['TEXT'] } },
    });
    cleanups.push(() => host.stop());
    const sessions: string[] = [];
    host.on('session', info => sessions.push(info.id));
    host.on('packet', event => host.forward(event.id, event.sequence, event.generation, null)); // drop every TEXT
    const port = await host.start();

    const game = await connectGame(port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO via the worker');
    expect(sessions).toHaveLength(1);

    server.peers[0].send(frame(factory.getPacketId('TEXT')!, Buffer.from('spam')));
    server.peers[0].send(frame(UNKNOWN, Buffer.from('ok')));
    await until(() => game.frames.length === 1, 'filtered relay');
    expect(game.frames[0][4]).toBe(UNKNOWN);
  });

  it('auto-passes verdict packets when nobody listens for them', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0,
      resolveTarget: () => ({ host: '127.0.0.1', port: server.port }), interest: { verdict: { server: ['TEXT'] } } });
    cleanups.push(() => host.stop());
    const port = await host.start();
    const game = await connectGame(port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO');
    const sentFrame = frame(factory.getPacketId('TEXT')!, Buffer.from('hi'));
    server.peers[0].send(sentFrame);
    await until(() => game.frames.length === 1, 'passed through');
    expect(game.frames[0].equals(sentFrame)).toBe(true);
  });

  it('rejects start() without throwing synchronously when Worker construction fails', async () => {
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0,
      workerUrl: new URL('http://example.invalid/w.js') });
    cleanups.push(() => host.stop());
    let started: Promise<number> | undefined;
    expect(() => { started = host.start(); }).not.toThrow();
    expect(started).toBeInstanceOf(Promise);
    await expect(started).rejects.toThrow();
  });

  it('rejects start() with the address when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    const port = (blocker.address() as net.AddressInfo).port;
    const host = new ProxyHost({ schema: loadSchema(), listenPort: port });
    cleanups.push(() => host.stop());
    await expect(host.start()).rejects.toThrow(`127.0.0.1:${port}`);
  });

  it('stops cleanly', async () => {
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0 });
    const exits: { code: number; expected: boolean }[] = [];
    host.on('exit', info => exits.push(info));
    const port = await host.start();
    await host.stop();
    expect(exits).toEqual([{ code: 0, expected: true }]);
    await expect(connectGame(port)).rejects.toThrow();
  });
});
