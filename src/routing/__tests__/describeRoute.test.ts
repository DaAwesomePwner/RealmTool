import { describe, expect, it } from 'vitest';
import { describeHello, describeReconnect } from '../describeRoute.ts';
import { createPacket } from '../../protocol/Packet.ts';
import type { HelloRoute } from '../router.ts';

function packet(name: string, data: Record<string, unknown>, unread = Buffer.alloc(0)) {
  const p = createPacket(0, name, name === 'HELLO' ? 'client' : 'server');
  p.data = data; p.isDefined = true; p.unreadData = unread;
  return p;
}

const hello = packet('HELLO', { gameId: -2, buildVersion: '6.1.0', accessToken: 'secret-access', keyTime: 99,
  key: Buffer.from('token'), gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: 'pt', userToken: 'secret-user',
  clientIdentification: 'cid' });

describe('route descriptions', () => {
  it('summarizes a RECONNECT without its key', () => {
    const text = describeReconnect(packet('RECONNECT',
      { name: 'Realm', host: '10.0.0.9', port: 2050, gameId: -2, keyTime: 99, key: Buffer.from('real-key') }, Buffer.alloc(3)));
    expect(text).toBe('RECONNECT "Realm" to 10.0.0.9:2050, gameId -2, keyTime 99, key 8 bytes, 3 unparsed bytes');
    expect(text).not.toContain('real-key');
  });

  it('summarizes a HELLO with secrets reduced to lengths', () => {
    const route: HelloRoute = { destination: { host: '10.0.0.9', port: 2050 }, hello: Buffer.alloc(120), restored: true,
      transfer: { gameId: -2, keyTime: 99, keyLength: 8, ageMs: 450 } };
    const text = describeHello(hello, route);
    expect(text).toBe('HELLO gameId -2, keyTime 99, build "6.1.0", 120 bytes (accessToken 13, platformToken 2, userToken 11, '
      + 'clientIdentification 3 chars; gameNet "rotmg", playPlatform "rotmg"; 0 unparsed bytes); '
      + 'restored a 8-byte key from a RECONNECT 450 ms old');
    expect(text).not.toMatch(/secret|token"/);
  });

  it('flags a HELLO that does not match its RECONNECT', () => {
    const route: HelloRoute = { destination: { host: '10.0.0.9', port: 2050 }, hello: Buffer.alloc(1), restored: true,
      transfer: { gameId: 7, keyTime: 99, keyLength: 8, ageMs: 0 } };
    expect(describeHello(hello, route)).toMatch(/with gameId 7, keyTime 99 \(MISMATCH\)$/);
  });
});
