// Ported from realm-engine-client client/src/packets/Packet.ts @ 9ab4f8f (MIT, see NOTICE).
/**
 * Generic packet class for RotMG protocol.
 * Instead of one class per packet type (200+ files), we use a single
 * generic Packet with a `data` dictionary populated from JSON definitions.
 */
export interface Packet {
  /** Numeric packet ID (single byte). */
  id: number;

  /** Human-readable name (e.g., "RECONNECT", "NEWTICK"). */
  name: string;

  /** Direction: "client" (C→S), "server" (S→C), or "unknown". */
  direction: 'client' | 'server' | 'unknown';

  /** If false, packet is dropped and not forwarded. Plugins set this to block packets. */
  send: boolean;

  /** If true, a hook modified packet.data and it needs re-serialization.
   *  If false, forward rawBytes directly (avoids corruption from imperfect definitions). */
  modified: boolean;

  /** Parsed fields from JSON definitions. E.g. { host: "<server-ip>", port: 2050 }. */
  data: Record<string, any>;

  /** The full raw bytes of the packet (length header + id + body). */
  rawBytes: Buffer;

  /** Any trailing bytes after the defined fields were read. */
  unreadData: Buffer;

  /** Whether we had a JSON definition for this packet type. */
  isDefined: boolean;

  /** Byte length of the body (excluding 5-byte header). */
  bodyLength: number;
}

export function createPacket(
  id: number,
  name: string,
  direction: 'client' | 'server' | 'unknown' = 'unknown',
): Packet {
  return {
    id,
    name,
    direction,
    send: true,
    modified: false,
    data: {},
    rawBytes: Buffer.alloc(0),
    unreadData: Buffer.alloc(0),
    isDefined: false,
    bodyLength: 0,
  };
}
