/** Each CI job runs on its own VM, so 127.0.0.1:2050 must be free for the full package smoke. */
export async function assertSmokePortFree(probe: () => Promise<boolean>): Promise<void> {
  if (!await probe()) throw new Error('Port 127.0.0.1:2050 is busy; cannot run the full package smoke');
}

export function smokeProxyStartupError(error: string | null): Error {
  if (/EADDRINUSE|address already in use|port.*in use/i.test(error ?? '')) {
    return new Error(`Port 127.0.0.1:2050 was taken in the race after the free probe; full package smoke failed: ${error}`);
  }
  return new Error(error ?? 'Proxy failed');
}
