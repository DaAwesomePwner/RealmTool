import { describe, expect, it } from 'vitest';
import { parseSmokePortOptions, smokeProxyStartupError, waitForSmokePort } from '../smoke-port.ts';

function fixture(results: boolean[], waitMs = 5000, allowBusyPort = false) {
  let time = 1000;
  let tries = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  const probe = async () => results[Math.min(tries++, results.length - 1)];
  const options = { waitMs, allowBusyPort, now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; },
    log: (message: string) => { logs.push(message); } };
  return { probe, options, sleeps, logs, tries: () => tries, elapsed: () => time - 1000 };
}

describe('smoke port wait', () => {
  it('returns immediately when the port is free', async () => {
    const f = fixture([true]);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(true);
    expect(f.tries()).toBe(1);
    expect(f.sleeps).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it('re-probes every two seconds until free and logs each transition once', async () => {
    const f = fixture([false, false, true]);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(true);
    expect(f.tries()).toBe(3);
    expect(f.sleeps).toEqual([2000, 2000]);
    expect(f.logs).toHaveLength(2);
    expect(f.logs[0]).toMatch(/waiting.*127\.0\.0\.1:2050.*5000 ms/i);
    expect(f.logs[1]).toMatch(/127\.0\.0\.1:2050.*free.*4000 ms/i);
  });

  it('fails at the deadline with the port and wait time, without oversleeping', async () => {
    const f = fixture([false]);
    await expect(waitForSmokePort(f.probe, f.options)).rejects.toThrow(/127\.0\.0\.1:2050.*5000 ms/);
    expect(f.elapsed()).toBe(5000);
    expect(f.sleeps).toEqual([2000, 2000, 1000]);
    expect(f.tries()).toBe(4);
    expect(f.logs).toHaveLength(1);
  });

  it('accepts a port that becomes free on the deadline probe', async () => {
    const f = fixture([false, true], 1000);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(true);
    expect(f.elapsed()).toBe(1000);
  });

  it('uses API-only fallback only after waiting when explicitly opted in', async () => {
    const f = fixture([false], 3000, true);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(false);
    expect(f.elapsed()).toBe(3000);
    expect(f.logs).toHaveLength(2);
    expect(f.logs[1]).toMatch(/WARNING.*API-only.*REALMTOOL_SMOKE_ALLOW_BUSY_PORT=1/);
  });

  it('still runs the full check when the port frees with fallback enabled', async () => {
    const f = fixture([false, true], 3000, true);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(true);
    expect(f.logs.join('\n')).not.toContain('API-only');
  });

  it('allows a zero wait but fails immediately when busy', async () => {
    const f = fixture([false], 0);
    await expect(waitForSmokePort(f.probe, f.options)).rejects.toThrow(/2050.*0 ms/);
    expect(f.tries()).toBe(1);
    expect(f.sleeps).toEqual([]);
  });

  it('allows an immediate explicit fallback with zero wait', async () => {
    const f = fixture([false], 0, true);
    await expect(waitForSmokePort(f.probe, f.options)).resolves.toBe(false);
    expect(f.sleeps).toEqual([]);
    expect(f.logs.join('\n')).toMatch(/WARNING.*API-only/);
  });

  it('propagates probe errors instead of treating them as port conflicts', async () => {
    const f = fixture([false], 5000, true);
    await expect(waitForSmokePort(async () => { throw new Error('EACCES'); }, f.options))
      .rejects.toThrow('EACCES');
    expect(f.sleeps).toEqual([]);
  });
});

describe('smoke port environment', () => {
  it('defaults to a three-minute wait and no fallback', () => {
    expect(parseSmokePortOptions({})).toEqual({ waitMs: 180000, allowBusyPort: false });
  });

  it.each(['0', '42', '180000'])('accepts integer wait override %s', value => {
    expect(parseSmokePortOptions({ REALMTOOL_SMOKE_PORT_WAIT_MS: value }).waitMs).toBe(Number(value));
  });

  it.each(['', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 2 ', 'abc', '9007199254740992'])
    ('rejects invalid wait override %j', value => {
      expect(() => parseSmokePortOptions({ REALMTOOL_SMOKE_PORT_WAIT_MS: value }))
        .toThrow(/REALMTOOL_SMOKE_PORT_WAIT_MS.*non-negative.*integer/);
    });

  it.each([undefined, '', '0', 'true', 'yes', ' 1 '])('does not opt in with %j', value => {
    expect(parseSmokePortOptions({ REALMTOOL_SMOKE_ALLOW_BUSY_PORT: value }).allowBusyPort).toBe(false);
  });

  it('opts in only with the literal value 1', () => {
    expect(parseSmokePortOptions({ REALMTOOL_SMOKE_ALLOW_BUSY_PORT: '1' }).allowBusyPort).toBe(true);
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
