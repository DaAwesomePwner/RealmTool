import { spawn } from 'node:child_process';

export interface RefreshResult { gameBuild: string; items: number; projectiles: number; tiles: number; ms: number }
export interface DataState {
  state: 'idle' | 'refreshing' | 'failed';
  gameBuild: string | null;
  catalogBuild: string | null;
  lastResult: RefreshResult | null;
  error: string | null;
}

/** Extraction has its own process/heap; neither the API nor the network worker reads assets. */
export function refreshCatalogs(gameDir: string, outDir: string, signal?: AbortSignal): Promise<RefreshResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Game data refresh cancelled')); return; }
    const env = { ...process.env };
    // Also scrub here for CLI callers; serve already consumes and deletes this variable.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'REALMTOOL_API_TOKEN') delete env[key];
    const child = spawn(process.execPath, [process.argv[1], 'refresh-data', '--parent-pipe', '--game-dir', gameDir, '--out-dir', outDir], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    let stdout = '', stderr = '', timedOut = false;
    // Always drain both pipes. Keep only bounded diagnostic output.
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16_384); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    const cancel = () => {
      child.stdin.destroy(); child.kill('SIGKILL');
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel);
      // Do not hold shutdown open waiting for extraction. The close listener stays
      // attached and Node reaps the killed child independently of this promise.
      reject(new Error('Game data refresh cancelled'));
    };
    const timeout = setTimeout(() => { timedOut = true; child.stdin.destroy(); child.kill('SIGKILL'); }, 120_000);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', () => { /* Child may exit before its parent; close/error below owns the result. */ });
    child.once('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout); signal?.removeEventListener('abort', cancel); child.stdin.destroy();
      if (timedOut) return reject(new Error('Game data refresh timed out after 120 seconds'));
      if (code !== 0) return reject(new Error(stderr.trim() || `Game data refresh exited with code ${code}`));
      try {
        const result = JSON.parse(stdout.trim()) as RefreshResult;
        if (!result || typeof result.gameBuild !== 'string' || !result.gameBuild.trim()
          || ![result.items, result.projectiles, result.tiles, result.ms].every(n => Number.isSafeInteger(n) && n >= 0)) {
          throw new Error('Invalid game data refresh result');
        }
        resolve(result);
      } catch (error) { reject(error); }
    });
    if (signal?.aborted) cancel();
  });
}

/** Cancel a controller wait even when an injected dependency ignores its signal. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('Game data refresh cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    work.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => {
      signal.removeEventListener('abort', cancel); reject(error);
    });
    if (signal.aborted) { signal.removeEventListener('abort', cancel); cancel(); }
  });
}
