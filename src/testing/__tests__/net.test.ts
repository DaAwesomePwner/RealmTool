import net from 'node:net';
import { expect, it } from 'vitest';
import { connectGame, until } from '../net.ts';
import type { Peer } from '../net.ts';

it('records an invalid frame error and closes the peer', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    const bad = Buffer.alloc(8);
    bad.writeInt32BE(4, 0);
    socket.write(bad);
  });
  let game: Peer | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    game = await connectGame((server.address() as net.AddressInfo).port);
    const peer = game;
    await until(() => peer.closed, 'game closes after invalid frame');
    expect(game.errors).toHaveLength(1);
    expect(game.errors[0]).toBeInstanceOf(Error);
    expect(game.errors[0].message).toContain('Invalid frame length 4');
  } finally {
    game?.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
