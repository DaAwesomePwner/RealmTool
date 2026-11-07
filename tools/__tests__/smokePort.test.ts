import { describe, expect, it } from 'vitest';
import { assertSmokePortFree, smokeProxyStartupError } from '../smoke-port.ts';

describe('smoke port check', () => {
  it('passes when the port is free and probes once', async () => {
    let tries = 0;
    await expect(assertSmokePortFree(async () => { tries++; return true; })).resolves.toBeUndefined();
    expect(tries).toBe(1);
  });

  it('fails immediately when the port is busy', async () => {
    let tries = 0;
    await expect(assertSmokePortFree(async () => { tries++; return false; }))
      .rejects.toThrow(/127\.0\.0\.1:2050 is busy.*full package smoke/);
    expect(tries).toBe(1);
  });

  it('propagates probe errors instead of treating them as port conflicts', async () => {
    await expect(assertSmokePortFree(async () => { throw new Error('EACCES'); })).rejects.toThrow('EACCES');
  });
});

describe('proxy startup failures after a free probe', () => {
  it.each(['listen EADDRINUSE: address already in use', 'address already in use', 'port 2050 is in use'])
    ('explains the port race for %s', message => {
      const error = smokeProxyStartupError(message);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/127\.0\.0\.1:2050.*taken.*race.*free probe/i);
      expect(error.message).toContain(message);
    });

  it('preserves unrelated proxy failures', () => {
    expect(smokeProxyStartupError('helper failed').message).toBe('helper failed');
    expect(smokeProxyStartupError(null).message).toBe('Proxy failed');
  });
});
