import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** Per-launch credentials and short-lived, bounded upgrade capabilities. */
export class ApiAuth {
  private readonly digest: Buffer;
  private readonly origins: Set<string>;
  private readonly tickets = new Map<string, number>();

  constructor(token: string, origins: string[]) {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error('Invalid API token');
    this.digest = createHash('sha256').update(`Bearer ${token}`).digest();
    this.origins = new Set(origins.filter(origin => origin !== 'null' && origin !== '*'));
  }

  allowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.origins.has(origin);
  }

  checkLocation(headers: IncomingHttpHeaders, port: number, requireOrigin = false): 403 | null {
    if (headers.host !== `127.0.0.1:${port}`) return 403;
    if ((requireOrigin || headers.origin !== undefined) && !this.allowedOrigin(headers.origin)) return 403;
    return null;
  }

  check(headers: IncomingHttpHeaders, port: number): 401 | 403 | null {
    const location = this.checkLocation(headers, port);
    if (location) return location;
    // Fixed-size digests allow constant-time comparison even for unequal token lengths.
    const candidate = createHash('sha256').update(headers.authorization ?? '').digest();
    return timingSafeEqual(this.digest, candidate) ? null : 401;
  }

  issueTicket(): string {
    const now = Date.now();
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket);
    if (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, now + 30_000);
    return ticket;
  }

  consumeTicket(ticket: string): boolean {
    const expires = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return expires !== undefined && expires > Date.now();
  }

  clear(): void { this.tickets.clear(); }
}
