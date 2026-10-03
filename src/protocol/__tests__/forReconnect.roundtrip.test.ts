import { describe, expect, it } from 'vitest';
import { PacketFactory } from '../PacketFactory.ts';
import { loadSchema } from '../schema.ts';

describe('FORRECONNECT wire format', () => {
  const factory = new PacketFactory(loadSchema().definitions, loadSchema().stats);

  it('decodes and preserves the leading-colon server list representation', () => {
    const capturedShape = Buffer.from('00000016da000f3a5573536f7574683a457557657374', 'hex');
    const packet = factory.createFromBytes(capturedShape, 'server');

    expect(packet.name).toBe('FORRECONNECT');
    expect(packet.isDefined).toBe(true);
    expect(packet.data.serverNames).toBe(':UsSouth:EuWest');
    expect(packet.unreadData.length).toBe(0);
    expect(factory.serialize(packet).equals(capturedShape)).toBe(true);
  });
});
