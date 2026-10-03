// Ported from realm-engine-client client/src/proxy/reconnectRoute.ts @ 9ab4f8f (MIT, see NOTICE).
import { isIP } from 'node:net';
import type { Packet } from '../protocol/Packet.ts';
import { PacketReader } from '../protocol/PacketReader.ts';

/** Pure wire/payload validation shared by main-thread routing and the final worker writer. */
export function readReconnectRoute(packet: Packet) {
  const raw = packet.rawBytes;
  if (packet.name !== 'RECONNECT' || packet.direction !== 'server' || !packet.isDefined
      || raw.length < 5 || raw.readInt32BE(0) !== raw.length || raw[4] !== packet.id) {
    throw new Error('Invalid reconnect frame');
  }
  const reader = new PacketReader(raw, 5);
  const name = reader.readString();
  const hostOff = reader.position;
  const host = reader.readString();
  const portOff = reader.position;
  const port = reader.readUInt16();
  const gameId = reader.readInt32();
  const keyTime = reader.readInt32();
  const keyOff = reader.position;
  const key = reader.readBytes(reader.readInt16());
  const tail = reader.readRemainingBytes();

  // Empty host and zero port mean the current route. Nonempty hosts must be an
  // IP or DNS hostname, not a URL/socket path. Signed lengths are bounds-checked.
  const hostname = host.endsWith('.') ? host.slice(0, -1) : host;
  const validHost = host === '' || isIP(host) !== 0 || (hostname.length <= 253 && hostname.split('.').every(
    label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)));
  if (!validHost || name !== packet.data.name || host !== packet.data.host || port !== packet.data.port
      || gameId !== packet.data.gameId || keyTime !== packet.data.keyTime
      || !Buffer.isBuffer(packet.data.key) || !key.equals(packet.data.key)) {
    throw new Error('Invalid reconnect fields');
  }
  return { name, host, port, gameId, keyTime, key, hostOff, portOff, keyOff, tail };
}
