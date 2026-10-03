import { describe, expect, it } from 'vitest';
import { createFactory } from '../schema.ts';
import { helloBytes, reconnectBytes } from '../../testing/wire.ts';

describe('protocol schema', () => {
  const factory = createFactory();

  it('knows the packets Phase 1 routes on', () => {
    expect(factory.getPacketId('HELLO')).toBe(74);
    expect(factory.getPacketId('RECONNECT')).toBe(45);
    expect(factory.getPacketName(45, 'server')).toBe('RECONNECT');
    expect(factory.getPacketName(74, 'client')).toBe('HELLO');
  });

  it('round-trips HELLO and RECONNECT byte-for-byte', () => {
    const hello = helloBytes(factory, Buffer.from('abc'));
    const decodedHello = factory.createFromBytes(hello, 'client');
    expect(decodedHello.isDefined).toBe(true);
    expect(factory.serialize(decodedHello).equals(hello)).toBe(true);

    const tail = Buffer.from([1, 2, 3]);
    const reconnect = reconnectBytes(factory, { host: '1.2.3.4', port: 2050, key: Buffer.from([9]) }, tail);
    const decoded = factory.createFromBytes(reconnect, 'server');
    expect(decoded.data).toMatchObject({ host: '1.2.3.4', port: 2050 });
    expect(decoded.unreadData.equals(tail)).toBe(true);
  });
});
