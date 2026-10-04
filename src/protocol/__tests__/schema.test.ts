import { describe, expect, it } from 'vitest';
import { createFactory } from '../schema.ts';
import { PacketSerializeError } from '../PacketFactory.ts';
import { PacketWriter } from '../PacketWriter.ts';
import { helloBytes, reconnectBytes } from '../../testing/wire.ts';

describe('protocol schema', () => {
  const factory = createFactory();

  it('knows the packets Phase 1 routes on', () => {
    expect(factory.getPacketDirection('TEXT')).toBe('server');
    expect(factory.getPacketDirection('PLAYERTEXT')).toBe('client');
    expect(factory.getPacketDirection('NOPE')).toBeUndefined();
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
    expect(factory.serialize(decoded).equals(reconnect)).toBe(true);
  });

  it('throws PacketSerializeError for an invalid created HELLO', () => {
    const packet = factory.createByName('HELLO');
    packet.data.buildVersion = {};

    expect(() => new PacketWriter().writeString(packet.data.buildVersion)).toThrow(TypeError);
    expect(() => factory.serialize(packet)).toThrow(PacketSerializeError);
    expect(() => factory.serialize(packet)).toThrow(/Failed to serialize HELLO: .*Received an instance of Object/);
  });

  it('throws PacketSerializeError instead of returning stale bytes for an invalid decoded packet', () => {
    const raw = reconnectBytes(factory, { host: '1.2.3.4', port: 2050, key: Buffer.from([9]) });
    const packet = factory.createFromBytes(raw, 'server');
    expect(packet.isDefined).toBe(true);
    expect(packet.rawBytes.equals(raw)).toBe(true);
    packet.data.port = 2147483648;

    expect(() => new PacketWriter().writeInt32(packet.data.port)).toThrow(RangeError);
    expect(() => factory.serialize(packet)).toThrow(PacketSerializeError);
    expect(() => factory.serialize(packet)).toThrow(/Failed to serialize RECONNECT: .*out of range/);
  });
});
