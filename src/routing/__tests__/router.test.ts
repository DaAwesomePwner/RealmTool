import { describe, expect, it } from 'vitest';
import { Router } from '../router.ts';
import { createFactory } from '../../protocol/schema.ts';
import { helloBytes, reconnectBytes } from '../../testing/wire.ts';

const factory = createFactory();
const fromServer = (raw: Buffer) => factory.createFromBytes(raw, 'server');
const fromClient = (raw: Buffer) => factory.createFromBytes(raw, 'client');

function clockedRouter(start = 0) {
  let now = start;
  let tokens = 0;
  const router = new Router({ now: () => now, newToken: () => `token-${++tokens}`, loopbackPort: 2050 });
  return { router, advance: (ms: number) => { now += ms; } };
}

describe('Router', () => {
  it('routes a fresh HELLO to the helper target unchanged', () => {
    const { router } = clockedRouter();
    const raw = helloBytes(factory, Buffer.alloc(0));
    const route = router.routeHello(fromClient(raw), { host: '10.0.0.5', port: 2050 });
    expect(route).toEqual({ destination: { host: '10.0.0.5', port: 2050 }, hello: raw, restored: false });
  });

  it('returns null when there is neither a token nor a target', () => {
    const { router } = clockedRouter();
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.alloc(0))), null)).toBeNull();
  });

  it('rewrites RECONNECT to loop back and restores the real key on the next HELLO', () => {
    const { router } = clockedRouter();
    const realKey = Buffer.from([0, 0xff, 0x80]);
    const tail = Buffer.from([0xde, 0xad]);
    const patched = router.rewriteReconnect(
      fromServer(reconnectBytes(factory, { host: '10.0.0.9', port: 2051, key: realKey, gameId: 7, keyTime: 99 }, tail)),
      { host: '10.0.0.5', port: 2050 });
    expect(patched).not.toBeNull();
    const rewritten = fromServer(patched!);
    expect(rewritten.data).toMatchObject({ host: '127.0.0.1', port: 2050, gameId: 7, keyTime: 99, name: 'Realm' });
    expect((rewritten.data.key as Buffer).toString('utf8')).toBe('token-1');
    expect(rewritten.unreadData.equals(tail)).toBe(true);

    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), { host: '10.0.0.77', port: 2050 });
    expect(route?.restored).toBe(true);
    expect(route?.destination).toEqual({ host: '10.0.0.9', port: 2051 });
    expect((fromClient(route!.hello).data.key as Buffer).equals(realKey)).toBe(true);
  });

  it('keeps the current server when RECONNECT carries an empty host and zero port', () => {
    const { router } = clockedRouter();
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '', port: 0, key: Buffer.from('k') })),
      { host: '10.0.0.5', port: 2050 });
    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), null);
    expect(route?.destination).toEqual({ host: '10.0.0.5', port: 2050 });
  });

  it('rejects a malformed RECONNECT without storing a route', () => {
    const { router } = clockedRouter();
    const garbage = Buffer.from([0, 0, 0, 8, 45, 0, 9, 1]);
    expect(router.rewriteReconnect(fromServer(garbage), { host: '10.0.0.5', port: 2050 })).toBeNull();
    expect(router.size).toBe(0);
  });

  it('expires tokens after the TTL', () => {
    const { router, advance } = clockedRouter();
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '10.0.0.9', port: 2050, key: Buffer.from('k') })),
      { host: '10.0.0.5', port: 2050 });
    advance(120_001);
    const route = router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), { host: '10.0.0.5', port: 2050 });
    expect(route?.restored).toBe(false);
    expect(route?.destination.host).toBe('10.0.0.5');
    expect(router.size).toBe(0);
  });

  it('keeps a token alive while the game keeps retrying it (full-server queue)', () => {
    const { router, advance } = clockedRouter();
    const current = { host: '10.0.0.5', port: 2050 };
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '10.0.0.9', port: 2050, key: Buffer.from('k') })), current);
    router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: '10.0.0.8', port: 2050, key: Buffer.from('k') })), current);
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 5_000) {
      advance(5_000);
      expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-2'))), null)?.destination.host).toBe('10.0.0.8');
    }
    // The token nobody retried still expires, even though a newer one was renewed past it.
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('token-1'))), null)).toBeNull();
    expect(router.size).toBe(1);
  });

  it('evicts the oldest token beyond maxTokens', () => {
    let tokens = 0;
    const router = new Router({ now: () => 0, newToken: () => `t${++tokens}`, maxTokens: 2 });
    for (let i = 0; i < 3; i++) {
      router.rewriteReconnect(fromServer(reconnectBytes(factory, { host: `10.0.0.${i}`, port: 2050, key: Buffer.from('k') })),
        { host: '10.0.0.5', port: 2050 });
    }
    expect(router.size).toBe(2);
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('t1'))), null)).toBeNull();
    expect(router.routeHello(fromClient(helloBytes(factory, Buffer.from('t3'))), null)?.destination.host).toBe('10.0.0.2');
  });
});
