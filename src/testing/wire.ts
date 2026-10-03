import type { PacketFactory } from '../protocol/PacketFactory.ts';

/** A plaintext frame: [int32 length][id][body]. */
export function frame(id: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.writeInt32BE(out.length, 0);
  out[4] = id;
  body.copy(out, 5);
  return out;
}

/** An id with no packet definition in either direction. */
export function unknownId(factory: PacketFactory): number {
  for (let id = 255; id > 0; id--) {
    if (factory.getPacketName(id, 'client').startsWith('UNKNOWN_')
      && factory.getPacketName(id, 'server').startsWith('UNKNOWN_')) return id;
  }
  throw new Error('every packet id is defined');
}

export function helloBytes(factory: PacketFactory, key: Buffer, overrides: Record<string, unknown> = {}): Buffer {
  const packet = factory.createByName('HELLO');
  packet.data = {
    gameId: -2, buildVersion: '6.9.0.1.0', accessToken: 'token-abc', keyTime: -1, key,
    gameNet: 'rotmg', playPlatform: 'rotmg', platformToken: '', userToken: 'user-1',
    clientIdentification: 'client-1', ...overrides,
  };
  return factory.serialize(packet);
}

export interface ReconnectFields {
  name?: string;
  host: string;
  port: number;
  gameId?: number;
  keyTime?: number;
  key: Buffer;
}

/** A RECONNECT frame, optionally followed by unknown trailing bytes the proxy must preserve. */
export function reconnectBytes(factory: PacketFactory, fields: ReconnectFields, tail: Buffer = Buffer.alloc(0)): Buffer {
  const packet = factory.createByName('RECONNECT');
  packet.data = { name: 'Realm', gameId: 0, keyTime: 0, ...fields };
  const body = factory.serialize(packet);
  if (tail.length === 0) return body;
  const out = Buffer.concat([body, tail]);
  out.writeInt32BE(out.length, 0);
  return out;
}
