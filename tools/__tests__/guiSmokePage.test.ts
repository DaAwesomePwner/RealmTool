import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { pageAssertion } from '../gui-smoke/page.ts';

async function evaluate(options: { gameDir?: string; state?: string; error?: string; connected?: boolean; root?: boolean } = {}) {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ game: { dir: options.gameDir ?? 'fake' },
    operation: null, proxy: { state: options.state ?? 'running', port: 2050, error: options.error ?? null } }) }));
  const root = { childElementCount: 2, getBoundingClientRect: () => ({ height: 500 }),
    querySelector: (selector: string) => selector === '.connection'
      ? { textContent: options.connected === false ? 'Backend unavailable' : 'Backend connected' }
      : { childElementCount: 1 } };
  return await runInNewContext(pageAssertion('fake'), {
    document: { querySelector: (selector: string) => selector === '#app' && options.root !== false ? root : null },
    window: { __TAURI_INTERNALS__: { invoke: async () => ({ port: 12345, token: 'secret' }) } }, fetch, AbortSignal,
  });
}

it('accepts a rendered dashboard backed by the fake profile and reports bound 2050', async () => {
  expect(await evaluate()).toEqual({ ready: true, proxy: 'bound 2050' });
});
it('accepts only the expected port-2050 conflict', async () => {
  expect(await evaluate({ state: 'failed', error: 'listen EADDRINUSE: address already in use 127.0.0.1:2050' }))
    .toEqual({ ready: true, proxy: 'address-in-use fallback (2050 owned by another process)' });
  expect(await evaluate({ state: 'failed', error: 'native module missing' })).toContain('native module missing');
});
it('rejects a real game path even when the backend is healthy', async () => {
  expect(await evaluate({ gameDir: 'real-game' })).toContain('SAFETY');
});
it('requires both rendered children and a connected backend', async () => {
  expect(await evaluate({ root: false })).toContain('#app');
  expect(await evaluate({ connected: false })).toContain('not connected');
});
