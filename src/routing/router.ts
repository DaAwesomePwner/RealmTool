import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GAME_PORT } from '../protocol/constants.ts';
import type { Packet } from '../protocol/Packet.ts';
import { findHelloKeyOffset, patchHelloKey } from './helloKey.ts';
import { readReconnectRoute } from './reconnectRoute.ts';

export interface Destination {
  host: string;
  port: number;
}

export interface HelloRoute {
  destination: Destination;
  /** The HELLO to send upstream: the original bytes, or a copy with the real key restored. */
  hello: Buffer;
  /** True when this HELLO followed a RECONNECT we rewrote. */
  restored: boolean;
  /** For a restored HELLO: what the RECONNECT carried, and how long ago it arrived. */
  transfer?: { gameId: number; keyTime: number; keyLength: number; ageMs: number };
}

export interface RouterOptions {
  tokenTtlMs?: number;
  maxTokens?: number;
  now?: () => number;
  newToken?: () => string;
  loopbackHost?: string;
  loopbackPort?: number;
}

interface PendingRoute {
  destination: Destination;
  key: Buffer;
  gameId: number;
  keyTime: number;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * The transfer handoff. A server RECONNECT names the next server and a key. We
 * rewrite it to point the game back at the proxy, carrying a random token in
 * place of the key. When the game's next HELLO presents that token, we connect
 * to the real server and send it the real key. Tokens are bounded and expire
 * once unused for the TTL. Each use renews a token: a game queueing for a full
 * server retries the same token every few seconds for as long as the queue lasts.
 */
export class Router {
  private readonly routes = new Map<string, PendingRoute>();
  private readonly ttlMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly loopbackHost: string;
  private readonly loopbackPort: number;

  constructor(options: RouterOptions = {}) {
    this.ttlMs = options.tokenTtlMs ?? 120_000;
    this.maxTokens = options.maxTokens ?? 64;
    this.now = options.now ?? (() => performance.now());
    this.newToken = options.newToken ?? (() => randomUUID().replace(/-/g, ''));
    this.loopbackHost = options.loopbackHost ?? '127.0.0.1';
    this.loopbackPort = options.loopbackPort ?? GAME_PORT;
  }

  get size(): number {
    this.prune();
    return this.routes.size;
  }

  routeHello(hello: Packet, initial: Destination | null): HelloRoute | null {
    if (hello.name !== 'HELLO' || !hello.isDefined) return null;
    const key = hello.data.key;
    const token = Buffer.isBuffer(key) && key.length > 0 ? key.toString('utf8') : '';
    const pending = token ? this.lookup(token) : null;
    if (pending) {
      const offset = findHelloKeyOffset(hello.rawBytes);
      if (offset < 0) return null;
      return { destination: { ...pending.destination }, hello: patchHelloKey(hello.rawBytes, offset, pending.key), restored: true,
        transfer: { gameId: pending.gameId, keyTime: pending.keyTime, keyLength: pending.key.length,
          ageMs: Math.round(this.now() - pending.createdAt) } };
    }
    if (!initial) return null;
    return { destination: { ...initial }, hello: Buffer.from(hello.rawBytes), restored: false };
  }

  /** Returns the rewritten frame, or null if the RECONNECT is malformed (drop it; keep the current route). */
  rewriteReconnect(packet: Packet, current: Destination): Buffer | null {
    let route: ReturnType<typeof readReconnectRoute>;
    try {
      route = readReconnectRoute(packet);
    } catch {
      return null;
    }
    const raw = packet.rawBytes;
    const token = this.newToken();
    const tokenBytes = Buffer.from(token, 'utf8');
    const hostBytes = Buffer.from(this.loopbackHost, 'utf8');
    const beforeHost = raw.subarray(0, route.hostOff);
    const portToKey = raw.subarray(route.portOff + 2, route.keyOff); // gameId + keyTime, untouched
    const out = Buffer.alloc(beforeHost.length + 2 + hostBytes.length + 2 + portToKey.length + 2 + tokenBytes.length + route.tail.length);
    let position = beforeHost.copy(out, 0);
    position = out.writeInt16BE(hostBytes.length, position);
    position += hostBytes.copy(out, position);
    position = out.writeUInt16BE(this.loopbackPort, position);
    position += portToKey.copy(out, position);
    position = out.writeInt16BE(tokenBytes.length, position);
    position += tokenBytes.copy(out, position);
    route.tail.copy(out, position);
    out.writeInt32BE(out.length, 0);
    this.store(token, {
      destination: { host: route.host || current.host, port: route.port || current.port },
      key: Buffer.from(route.key),
      gameId: route.gameId,
      keyTime: route.keyTime,
      createdAt: this.now(),
      lastUsedAt: this.now(),
    });
    return out;
  }

  private lookup(token: string): PendingRoute | null {
    this.prune();
    const route = this.routes.get(token);
    if (!route) return null;
    route.lastUsedAt = this.now();
    this.routes.delete(token);
    this.routes.set(token, route);
    return route;
  }

  private store(token: string, route: PendingRoute): void {
    this.prune();
    while (this.routes.size >= this.maxTokens) {
      const oldest = this.routes.keys().next().value;
      if (oldest === undefined) break;
      this.routes.delete(oldest);
    }
    this.routes.set(token, route);
  }

  /** Insertion order is last-use order, so expired routes are always at the front. */
  private prune(): void {
    const now = this.now();
    for (const [token, route] of this.routes) {
      if (now - route.lastUsedAt <= this.ttlMs) break;
      this.routes.delete(token);
    }
  }
}
