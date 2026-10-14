/** Read-only checks: never click Launch or invoke an API that mutates the game. */
export function pageAssertion(gameDir: string): string {
  return `(async () => {
    const root = document.querySelector('#app');
    if (!root || !root.childElementCount || !root.getBoundingClientRect().height) return '#app has no rendered children';
    if (document.querySelector('#realmtool-shell-error[open]')) return 'Shell recovery dialog is open';
    if (root.querySelector('.connection')?.textContent !== 'Backend connected') return 'Backend is not connected';
    if (!root.querySelector('.content')?.childElementCount) return 'Dashboard content is missing';
    const info = await window.__TAURI_INTERNALS__.invoke('backend_info');
    const response = await fetch('http://127.0.0.1:' + info.port + '/api/state', {
      headers: { Authorization: 'Bearer ' + info.token }, signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return 'Backend state HTTP ' + response.status;
    const state = await response.json();
    if (state.game.dir !== ${JSON.stringify(gameDir)}) return 'SAFETY: backend is not using the fake game';
    if (state.operation !== null) return 'Backend startup operation is still pending';
    if (state.proxy.state === 'running' && state.proxy.port === 2050) return { ready: true, proxy: 'bound 2050' };
    // The separate nuc-build runner can concurrently own 2050 on this host.
    // Only that expected backend failure is tolerated; browser errors still fail.
    if (state.proxy.state === 'failed' && /EADDRINUSE|address already in use|port.*in use/i.test(state.proxy.error ?? '')) {
      return { ready: true, proxy: 'address-in-use fallback (2050 owned by another process)' };
    }
    return 'Unexpected proxy state: ' + state.proxy.state + ': ' + (state.proxy.error ?? '');
  })()`;
}
