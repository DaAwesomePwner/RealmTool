import net from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { Peer } from '../../testing/net.ts';
import { RC4_KEYS } from '../../protocol/constants.ts';
import { createFactory } from '../../protocol/schema.ts';

// The server must keep receiving while a PluginHost hook blocks the test thread.
const port = parentPort!;
const escapes = new BigInt64Array(workerData.escapeTimes);
const factory = createFactory();
let peer: Peer | undefined;
let escapeCount = 0;
const server = net.createServer(socket => {
  peer = new Peer(socket, RC4_KEYS.serverToClient, RC4_KEYS.clientToServer);
  let received = 0;
  socket.on('data', () => {
    for (const bytes of peer!.frames.slice(received)) {
      const at = process.hrtime.bigint();
      if (bytes[4] === factory.getPacketId('ESCAPE')) {
        if (escapeCount < escapes.length) Atomics.store(escapes, escapeCount, at);
        escapeCount++;
      }
      port.postMessage({ type: 'frame', bytes, at });
    }
    received = peer!.frames.length;
    for (const error of peer!.errors) port.postMessage({ type: 'fault', message: error.message });
  });
  socket.on('error', error => port.postMessage({ type: 'fault', message: error.message }));
});
server.on('error', error => port.postMessage({ type: 'fault', message: error.message }));
server.listen(0, '127.0.0.1', () => port.postMessage({ type: 'listening', port: (server.address() as net.AddressInfo).port }));
port.on('message', (message: { type: 'send'; frames: Uint8Array[] } | { type: 'stop' }) => {
  if (message.type === 'send') {
    if (!peer) throw new Error('Fake server has no peer');
    for (const bytes of message.frames) peer.send(Buffer.from(bytes));
  } else {
    peer?.destroy();
    server.close(() => port.close());
  }
});
