export interface SmokePortOptions {
  waitMs: number;
  allowBusyPort: boolean;
}

interface WaitOptions extends SmokePortOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export function parseSmokePortOptions(env: NodeJS.ProcessEnv): SmokePortOptions {
  const raw = env.REALMTOOL_SMOKE_PORT_WAIT_MS;
  const waitMs = raw === undefined ? 180000 : Number(raw);
  if (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(waitMs))) {
    throw new Error('REALMTOOL_SMOKE_PORT_WAIT_MS must be a non-negative safe integer (milliseconds)');
  }
  return { waitMs, allowBusyPort: env.REALMTOOL_SMOKE_ALLOW_BUSY_PORT === '1' };
}

/** Returns false only for an explicitly opted-in API-only check after the deadline. */
export async function waitForSmokePort(probe: () => Promise<boolean>, options: WaitOptions): Promise<boolean> {
  const { waitMs, allowBusyPort, now = () => performance.now(),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    log = console.log } = options;
  const started = now();
  const deadline = started + waitMs;
  if (await probe()) return true;
  log(`Waiting for 127.0.0.1:2050 to become free (up to ${waitMs} ms)`);
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(2000, remaining));
    if (now() > deadline) break;
    if (await probe()) {
      log(`127.0.0.1:2050 is free after ${Math.round(now() - started)} ms; running the full package smoke`);
      return true;
    }
  }
  const message = `Port 127.0.0.1:2050 is still busy after waiting ${waitMs} ms`;
  if (!allowBusyPort) throw new Error(`${message}; cannot run the full package smoke`);
  log(`WARNING: ${message}; API-only fallback enabled by REALMTOOL_SMOKE_ALLOW_BUSY_PORT=1; full proxy coverage skipped`);
  return false;
}

export function smokeProxyStartupError(error: string | null): Error {
  if (/EADDRINUSE|address already in use|port.*in use/i.test(error ?? '')) {
    return new Error(`Port 127.0.0.1:2050 was taken in the race after the free probe; full package smoke failed: ${error}`);
  }
  return new Error(error ?? 'Proxy failed');
}
