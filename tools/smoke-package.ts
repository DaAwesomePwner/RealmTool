import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import type { AppState } from '../src/app/controller.ts';
import type { PluginSnapshot } from '../src/plugins/snapshot.ts';
import { assertSmokePortFree, smokeProxyStartupError } from './smoke-port.ts';

/** Controller-run after build:app; never uses or launches the real game. */
async function smoke(): Promise<void> {
  await assertSmokePortFree(() => new Promise<boolean>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(2050, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve(true)));
  }));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const resources = resolve(repo, 'dist/app');
  const build = JSON.parse(readFileSync(join(resources, 'data/catalogs/safety.json'), 'utf8')).gameBuild;
  assert.equal(typeof build, 'string');
  assert.ok(build.length > 0);
  const root = mkdtempSync(join(tmpdir(), 'realmtool-package-smoke-'));
  const gameDir = join(root, 'game');
  const appData = join(root, 'roaming');
  const localData = join(root, 'local');
  mkdirSync(join(gameDir, 'RotMG Exalt_Data'), { recursive: true });
  mkdirSync(join(appData, 'RealmTool'), { recursive: true });
  mkdirSync(localData);
  writeFileSync(join(gameDir, 'RotMG Exalt.exe'), 'fixture, never execute');
  writeFileSync(join(gameDir, 'RotMG Exalt_Data/boot.config'), `build-guid=${build}\n`);
  writeFileSync(join(appData, 'RealmTool/config.json'), JSON.stringify({ schemaVersion: 1,
    gameDir, launcher: null, activeProfile: 'default' }));
  const token = randomBytes(32).toString('base64url');
  const child = spawn(join(repo, 'dist/runtime/node.exe'), [join(resources, 'backend/main.mjs'), 'serve'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localData, ROTMG_PATH: gameDir,
      TMP: root, TEMP: root, TMPDIR: root, REALMTOOL_RESOURCES: resources,
      REALMTOOL_API_TOKEN: token, REALMTOOL_UI_ORIGINS: 'http://tauri.localhost' },
  });
  // Mirror the shell: Koffi-loaded Node can crash on exit with a null stderr handle.
  child.stderr.resume();
  let spawnError: Error | undefined;
  let exited = false;
  const exit = new Promise<number | null>(resolve => {
    child.once('error', error => { spawnError = error; exited = true; resolve(null); });
    child.once('close', code => { exited = true; resolve(code); });
  });
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (spawnError) throw spawnError;
      assert.ok(!exited, `Sidecar exited before ${label}`);
      assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  try {
    await waitFor(() => output.includes('\n'), 'READY');
    assert.ok(output.length <= 4096, 'Oversized READY output');
    const line = output.split(/\r?\n/)[0];
    assert.ok(line.startsWith('REALMTOOL_READY '), 'Missing READY handshake');
    const { port } = JSON.parse(line.slice('REALMTOOL_READY '.length)) as { port: number };
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid READY port');
    async function request<T>(path: string, post = false): Promise<T> {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: post ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: post ? '{}' : undefined, signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200, `${path} failed`);
      return await response.json() as T;
    }
    let state = await request<AppState>('/api/state');
    // Check before polling startup or performing any further API operation.
    assert.equal(state.game.dir, gameDir, 'SAFETY: sidecar did not select the fake game directory');
    const startupDeadline = Date.now() + 10_000;
    while (state.proxy.state !== 'running' || state.operation !== null) {
      if (state.proxy.state === 'failed') throw smokeProxyStartupError(state.proxy.error);
      assert.ok(!exited, 'Sidecar exited during proxy startup');
      assert.ok(Date.now() < startupDeadline, 'Timed out waiting for proxy startup');
      await new Promise(resolve => setTimeout(resolve, 25));
      state = await request<AppState>('/api/state');
      assert.equal(state.game.dir, gameDir, 'SAFETY: game directory changed');
    }
    const plugins = await request<PluginSnapshot[]>('/api/plugins');
    assert.equal(state.game.helper.state, 'installed');
    assert.equal(plugins.length, 7);
    assert.ok(plugins.every(plugin => plugin.failed === null), 'A built-in failed to load');
    assert.deepEqual(await request('/api/shutdown', true), { ok: true });
    await waitFor(() => exited, 'sidecar exit');
    assert.equal(await exit, 0);
    assert.equal(output.trim().split(/\r?\n/).length, 1, 'Unexpected stdout beyond READY');
    console.log('package smoke ok: fake game, running proxy, seven built-ins, clean shutdown');
  } finally {
    if (!exited) {
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 3000);
      await exit;
      clearTimeout(kill);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

smoke().catch(error => { console.error(error instanceof Error ? error.message : 'Package smoke failed'); process.exitCode = 1; });
