import net from 'node:net';
import { RC4_KEYS } from '../protocol/constants.ts';
import { FrameDecoder } from '../protocol/frames.ts';
import { RC4Cipher } from '../protocol/RC4Cipher.ts';

export async function until(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** One end of an encrypted RotMG stream. Records every decrypted frame it receives. */
export class Peer {
  readonly frames: Buffer[] = [];
  readonly errors: Error[] = [];
  closed = false;
  private readonly socket: net.Socket;
  private readonly sendCipher: RC4Cipher;
  private readonly decoder: FrameDecoder;

  constructor(socket: net.Socket, sendKey: string, receiveKey: string) {
    this.socket = socket;
    this.sendCipher = new RC4Cipher(sendKey);
    this.decoder = new FrameDecoder(new RC4Cipher(receiveKey));
    socket.on('data', data => {
      try {
        this.decoder.feed(data, frame => this.frames.push(frame));
      } catch (error) {
        this.errors.push(error as Error);
        this.socket.destroy();
      }
    });
    socket.on('close', () => { this.closed = true; });
    socket.on('error', error => { this.errors.push(error); });
  }

  send(plain: Buffer): void {
    const copy = Buffer.from(plain);
    this.sendCipher.cipher(copy);
    this.socket.write(copy);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** A fake game client connected to the proxy. */
export function connectGame(port: number): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () =>
      resolve(new Peer(socket, RC4_KEYS.clientToServer, RC4_KEYS.serverToClient)));
    socket.once('error', reject);
  });
}

/** A fake game server. Every connection the proxy makes becomes a Peer. */
export class FakeServer {
  readonly peers: Peer[] = [];
  port = 0;
  private readonly server = net.createServer(socket =>
    this.peers.push(new Peer(socket, RC4_KEYS.serverToClient, RC4_KEYS.clientToServer)));

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const peer of this.peers) peer.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
