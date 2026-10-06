import type { Packet } from '../protocol/Packet.ts';
import type { HelloRoute } from './router.ts';

// Log summaries for diagnosing transfers. Keys, tokens and credentials appear only as lengths.

function size(value: unknown): number {
  return typeof value === 'string' || Buffer.isBuffer(value) ? value.length : 0;
}

function label(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value.slice(0, 32) : '');
}

export function describeReconnect(packet: Packet): string {
  const d = packet.data;
  const target = d.host ? `${d.host}:${d.port}` : '(current server)';
  return `RECONNECT ${label(d.name)} to ${target}, gameId ${d.gameId}, keyTime ${d.keyTime}, key ${size(d.key)} bytes, `
    + `${packet.unreadData.length} unparsed bytes`;
}

export function describeHello(hello: Packet, route: HelloRoute): string {
  const d = hello.data;
  let text = `HELLO gameId ${d.gameId}, keyTime ${d.keyTime}, build ${label(d.buildVersion)}, ${route.hello.length} bytes `
    + `(accessToken ${size(d.accessToken)}, platformToken ${size(d.platformToken)}, userToken ${size(d.userToken)}, `
    + `clientIdentification ${size(d.clientIdentification)} chars; gameNet ${label(d.gameNet)}, `
    + `playPlatform ${label(d.playPlatform)}; ${hello.unreadData.length} unparsed bytes)`;
  const transfer = route.transfer;
  if (transfer) {
    const matches = transfer.gameId === d.gameId && transfer.keyTime === d.keyTime;
    text += `; restored a ${transfer.keyLength}-byte key from a RECONNECT ${transfer.ageMs} ms old`
      + (matches ? '' : ` with gameId ${transfer.gameId}, keyTime ${transfer.keyTime} (MISMATCH)`);
  }
  return text;
}
