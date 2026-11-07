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
  it('expires verdicts on the production worker tick with no modules registered', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0,
      interest: { verdict: { server: ['TEXT'] } },
      resolveTarget: () => ({ host: '127.0.0.1', port: server.port }),
      workerUrl: new URL('./fixtures/no-modules-worker.ts', import.meta.url) });
    cleanups.push(() => host.stop());
    const diagnostics: string[] = [];
    host.on('diagnostic', event => diagnostics.push(event.message));
    host.on('packet', () => {}); // An interested main thread that never sends a verdict.
    const game = await connectGame(await host.start());
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'HELLO');
    const original = frame(factory.getPacketId('TEXT')!, Buffer.from('held original'));
    server.peers[0].send(original);
    // No forward() call and no module tick can rescue this packet.
    await until(() => game.frames.length === 1 && diagnostics.length === 1, 'transport deadline');
    expect(game.frames[0]).toEqual(original);
    expect(diagnostics).toEqual(['Plugin verdict deadlines expired: 1; released original packets']);
  });

  function moduleHost(moduleConfig: Record<string, unknown> = {}) {
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0, moduleConfig,
      workerUrl: new URL('./fixtures/modules-worker.ts', import.meta.url) });
    cleanups.push(() => host.stop());
    const messages: unknown[] = [];
    const diagnostics: string[] = [];
    host.on('module', event => messages.push(event.message));
    host.on('diagnostic', event => diagnostics.push(event.message));
    return { host, messages, diagnostics };
  }

  it('caches single and batch module configurations in worker init and across restart', async () => {
    const { host, messages } = moduleHost({ a: 1, untouched: 9 });
    host.configureModule('a', 2);
    host.configureModules({ b: 3 });
    await host.start();
    expect(messages).toContainEqual({ init: { a: 2, b: 3, untouched: 9 } });
    host.configureModule('a', 4);
    host.configureModules({ b: 5 });
    await host.stop();
    messages.length = 0;
    await host.start();
    expect(messages).toContainEqual({ init: { a: 4, b: 5, untouched: 9 } });
  });

  it('applies a live batch in registry order in one command before observing the next frame', async () => {
    const server = new FakeServer();
    await server.listen();
    cleanups.push(() => server.close());
    const { host, messages } = moduleHost({ a: 1, b: 2 });
    host['options'].resolveTarget = () => ({ host: '127.0.0.1', port: server.port });
    const port = await host.start();
    const game = await connectGame(port);
    cleanups.push(() => game.destroy());
    game.send(helloBytes(factory, Buffer.alloc(0)));
    await until(() => server.peers[0]?.frames.length === 1, 'fixture HELLO');
    messages.length = 0;
    host.configureModules({ b: 20, a: 10 });
    // Wait for the worker acknowledgment: socket and MessagePort arrivals are independent.
    await until(() => messages.some(message => !!message && typeof message === 'object' && 'configured' in message), 'batch applied');
    game.send(frame(factory.getPacketId('ESCAPE')!));
    await until(() => messages.some(message => !!message && typeof message === 'object' && 'observed' in message), 'module observation');
    // The real built-in modules also run in this worker and post status on their own schedule.
    const fixtureMessages = messages.filter(message => !!message && typeof message === 'object'
      && ['command', 'configured', 'observed'].some(key => key in message));
    expect(fixtureMessages).toEqual([
      { command: { type: 'modules', configs: { b: 20, a: 10 } } },
      { configured: { a: 10, b: 20 }, order: ['a', 'b', 'a', 'b'] },
      { observed: { a: 10, b: 20 } },
    ]);
  });

  it.each(['init', 'single', 'batch'] as const)('isolates a rejected %s configuration and keeps the worker and previous config', async mode => {
    const { host, messages, diagnostics } = moduleHost({ a: mode === 'init' ? 'invalid' : 1, b: 2 });
    await host.start();
    if (mode === 'single') host.configureModule('a', 'invalid');
    if (mode === 'batch') host.configureModules({ a: 'invalid', b: 3 });
    await until(() => diagnostics.length === 1, 'configuration rejection');
    expect(diagnostics).toEqual(['module a rejected its configuration: expected a number']);
    messages.length = 0;
    host.configureModule('b', 4);
    await until(() => messages.some(message => !!message && typeof message === 'object' && 'configured' in message), 'worker still handles configs');
    expect(messages).toContainEqual(expect.objectContaining({ configured: { a: mode === 'init' ? 0 : 1, b: 4 } }));
  });

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
