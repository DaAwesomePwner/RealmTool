import { describe, expect, it, vi } from 'vitest';
import { ApiAuth } from '../auth.ts';

const token = 'a'.repeat(43), origin = 'http://tauri.localhost';
describe('API authentication', () => {
  it('checks exact authority, origin and bearer, including different-length tokens', () => {
    const auth = new ApiAuth(token, [origin]);
    const headers = { host: '127.0.0.1:1234', authorization: `Bearer ${token}`, origin };
    expect(auth.check(headers, 1234)).toBeNull();
    expect(auth.check({ ...headers, origin: undefined }, 1234)).toBeNull();
    for (const authorization of [undefined, 'Bearer short', `Bearer ${'b'.repeat(43)}`, token]) {
      expect(auth.check({ ...headers, authorization }, 1234)).toBe(401);
    }
    for (const host of ['localhost:1234', '127.0.0.1:1', undefined]) expect(auth.check({ ...headers, host }, 1234)).toBe(403);
    for (const origin of ['null', 'https://evil.example']) expect(auth.check({ ...headers, origin }, 1234)).toBe(403);
  });

  it('issues random one-use tickets expiring at 30 seconds', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const auth = new ApiAuth(token, [origin]);
      const ticket = auth.issueTicket();
      expect(ticket).not.toBe(token);
      expect(auth.consumeTicket(ticket)).toBe(true);
      expect(auth.consumeTicket(ticket)).toBe(false);
      const expired = auth.issueTicket();
      now.mockReturnValue(31000);
      expect(auth.consumeTicket(expired)).toBe(false);
      expect(auth.consumeTicket('unknown')).toBe(false);
    } finally { now.mockRestore(); }
  });
});
