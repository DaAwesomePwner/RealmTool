import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { startApiServer } from '../api/server.ts';
import { AppController, type AppState } from '../app/controller.ts';
import { resourcePaths } from '../app/resources.ts';
import { AppConfigStore } from '../config/appConfig.ts';
import { ProfileStore } from '../config/store.ts';
import type { PluginSnapshot } from '../plugins/snapshot.ts';
import { createFactory } from '../protocol/schema.ts';
import { connectGame, FakeServer, until, type Peer } from '../testing/net.ts';
import { helloBytes } from '../testing/wire.ts';
import { ProxyHost } from '../transport/host.ts';
import { log } from '../util/log.ts';
import { LogRing } from '../util/logStore.ts';

it('drives real API, built-ins and worker through connection, settings, profile restart and shutdown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-api-integration-'));
  const gameDir = join(root, 'game');
  const resources = resourcePaths();
  const build = JSON.parse(readFileSync(join(resources.dataDir, 'catalogs/safety.json'), 'utf8')).gameBuild;
  mkdirSync(join(gameDir, 'RotMG Exalt_Data'), { recursive: true });
  writeFileSync(join(gameDir, 'RotMG Exalt.exe'), 'fixture, never execute');
  writeFileSync(join(gameDir, 'RotMG Exalt_Data/boot.config'), `build-guid=${build}\n`);
  const helperDll = join(root, 'helper.dll');
  writeFileSync(helperDll, 'RealmTool-Helper/integration-fixture');
  for (const [key, value] of Object.entries({ APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'),
    ROTMG_PATH: gameDir, TEMP: root, TMP: root, TMPDIR: root })) vi.stubEnv(key, value);
  log.setConsole(false);
  const detach = log.addSink(() => {});
  const upstream = new FakeServer();
  let controller: AppController | undefined;
  let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let ws: WebSocket | undefined;
  const games: Peer[] = [];
  const workers: { exited: boolean }[] = [];
  try {
    await upstream.listen();
    const config = new AppConfigStore(); config.update({ gameDir });
    const logs = new LogRing();
    controller = new AppController({ config, resources: { ...resources, helperDll }, logs }, {
      findGameDirs: () => [gameDir], nativeModuleError: () => null,
      findLauncher: () => { throw new Error('Launcher discovery is forbidden in integration tests'); },
      openLauncher: () => { throw new Error('Launching is forbidden in integration tests'); },
      createHost: options => {
        const worker = { exited: false }; workers.push(worker);
        const host = new ProxyHost({ ...options, listenPort: 0, resolveTarget: () => ({ host: '127.0.0.1', port: upstream.port }) });
        host.on('exit', () => { worker.exited = true; });
        return host;
      },
    });
    expect(controller.state().game.dir).toBe(gameDir);
    const token = randomBytes(32).toString('base64url');
    const origin = 'http://tauri.localhost';
    api = await startApiServer(controller, logs, { token, origins: [origin] });
    const base = `http://127.0.0.1:${api.port}`;
    async function request<T>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result as T;
    }
    const before = controller.state();
    expect((await fetch(base + '/api/proxy/start', { method: 'POST' })).status).toBe(401);
    expect((await fetch(base + '/api/proxy/start', { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, Origin: 'https://evil.example',
    } })).status).toBe(403);
    expect(controller.state()).toEqual(before);
    const { ticket } = await request<{ ticket: string }>('/api/ws-ticket', {});
    ws = new WebSocket(`ws://127.0.0.1:${api.port}/api/events?ticket=${ticket}`, { origin });
    type Event = { type: string; state?: AppState; pluginId?: string; dataType?: string; data?: { collisionHp?: string } };
    const events: Event[] = [];
    ws.on('message', bytes => events.push(JSON.parse(bytes.toString()) as Event));
    await once(ws, 'open');
    expect((await request<AppState>('/api/proxy/start', {})).proxy.state).toBe('running');
    const plugins = await request<PluginSnapshot[]>('/api/plugins');
    expect(plugins).toHaveLength(4); expect(plugins.every(p => p.failed === null)).toBe(true);
    const factory = createFactory();
    async function connect(): Promise<Peer> {
      const state = await request<AppState>('/api/state');
      expect(state.proxy.port).toBeGreaterThan(0);
      const peer = await connectGame(state.proxy.port!); games.push(peer);
      // Empty access token prevents Server Switch from attempting an external refresh.
      peer.send(helloBytes(factory, Buffer.alloc(0), { accessToken: '' }));
      return peer;
    }
    const first = await connect();
    await until(() => events.some(e => e.type === 'state' && e.state?.sessions.connected === 1), 'connected state over WS');
    await until(() => events.some(e => e.type === 'data' && e.pluginId === 'auto-nexus' && e.data?.collisionHp === 'on'), 'initial worker Collision HP on');
    events.length = 0;
    await request('/api/plugins/auto-nexus/settings/PreHitPrediction', { value: false });
    await until(() => events.some(e => e.type === 'data' && e.pluginId === 'auto-nexus' && e.dataType === 'status' && e.data?.collisionHp === 'off'), 'worker Collision HP off over WS');
    await request('/api/profiles', { name: 'second' });
    const other = new ProfileStore({ dir: config.dir, name: 'second' });
    other.scheduleSave({ schemaVersion: 1, plugins: { 'auto-nexus': { settings: { PreHitPrediction: true, ForceAutoNexusHealth: 42 } } } }); other.flush();
    const selected = await request<AppState>('/api/profiles/select', { name: 'second' });
    expect(selected.profile.active).toBe('second'); expect(selected.proxy.state).toBe('running');
    await until(() => first.closed, 'old game disconnected');
    expect(workers).toHaveLength(2); expect(workers[0].exited).toBe(true);
    expect(new ProfileStore({ dir: config.dir }).load().plugins['auto-nexus'].settings?.PreHitPrediction).toBe(false);
    const nexus = (await request<PluginSnapshot[]>('/api/plugins')).find(p => p.id === 'auto-nexus')!;
    expect(nexus.settings.find(s => s.key === 'ForceAutoNexusHealth')?.value).toBe(42);
    events.length = 0;
    const second = await connect();
    await until(() => events.some(e => e.type === 'data' && e.pluginId === 'auto-nexus' && e.data?.collisionHp === 'on'), 'restarted worker uses new profile');
    const shutdownPort = (await request<AppState>('/api/state')).proxy.port!;
    expect(shutdownPort).toBeGreaterThan(0);
    expect(await request('/api/shutdown', {})).toEqual({ ok: true });
    await until(() => workers.every(w => w.exited) && second.closed, 'shutdown stops worker and session');
    const probe = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(shutdownPort, '127.0.0.1', resolve); });
    } finally { await new Promise<void>(resolve => probe.close(() => resolve())); }
  } finally {
    ws?.terminate();
    for (const peer of games) peer.destroy();
    await controller?.shutdown(); await api?.close(); await upstream.close();
    detach(); log.setConsole(true); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
