import { EventEmitter, once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, request, type IncomingHttpHeaders } from 'node:http';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController, OperationBusyError, type AppState, type ControllerDeps } from '../../app/controller.ts';
import { AppConfigStore } from '../../config/appConfig.ts';
import { ProfileStore } from '../../config/store.ts';
import { resourcePaths } from '../../app/resources.ts';
import { FakeProxy } from '../../testing/pluginHarness.ts';
import { log } from '../../util/log.ts';
import autoNexus from '../../../plugins/auto-nexus/index.ts';
import type { PluginSnapshot } from '../../plugins/snapshot.ts';
import { LogRing } from '../../util/logStore.ts';
import { startApiServer } from '../server.ts';

const token = 'a'.repeat(43), origin = 'http://tauri.localhost';
function fakeController() {
  const state: AppState = {
    proxy: { state: 'stopped', port: null, error: null },
    game: { dir: null, candidates: [], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 0,
  };
  return Object.assign(new EventEmitter(), {
    state: vi.fn(() => state), plugins: vi.fn(() => []),
    startProxy: vi.fn(async () => {}), stopProxy: vi.fn(async () => {}), launchGame: vi.fn(async () => {}),
    installHelper: vi.fn(async () => ({ status: 'installed', target: 'private path', backedUp: false })),
    uninstallHelper: vi.fn(async () => 'removed'), setGameDir: vi.fn(async (_dir: string) => {}),
    setLauncher: vi.fn(async (_path: string | null) => {}), createProfile: vi.fn(async (_name: string, _from?: string) => {}),
    deleteProfile: vi.fn(async (_name: string) => {}), selectProfile: vi.fn(async (_name: string) => {}),
    setPluginEnabled: vi.fn((_id: string, _enabled: boolean): { ok: boolean; error?: string } => ({ ok: true })),
    updatePluginSetting: vi.fn((_id: string, _key: string, _value: unknown): { ok: boolean; error?: string } => ({ ok: true })),
    shutdown: vi.fn(async () => {}),
  });
}

describe('loopback API', () => {
  let controller: ReturnType<typeof fakeController>, logs: LogRing;
  let api: Awaited<ReturnType<typeof startApiServer>>;
  let agent: Agent;
  const clients: WebSocket[] = [];
  beforeEach(async () => {
    controller = fakeController(); logs = new LogRing(2); agent = new Agent({ keepAlive: true, maxSockets: 1 });
    api = await startApiServer(controller as unknown as AppController, logs, { token, origins: [origin], port: 0 });
  });
  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.terminate();
    agent?.destroy(); await api?.close(); vi.restoreAllMocks();
  });
  function http(path: string, method = 'GET', body?: unknown, headers: Record<string, string | undefined> = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: any; socket: unknown }>((resolve, reject) => {
      const defaults: Record<string, string | undefined> = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json', ...headers };
      const req = request({ host: '127.0.0.1', port: api.port, path, method, agent,
        headers: Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== undefined)) }, res => {
        const socket = res.socket; let text = '';
        res.setEncoding('utf8'); res.on('data', data => { text += data; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : undefined, socket }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  function untouched() { for (const value of Object.values(controller)) if (vi.isMockFunction(value)) expect(value).not.toHaveBeenCalled(); }
  async function ticket() { return (await http('/api/ws-ticket', 'POST', {})).body.ticket as string; }
  function connect(value?: string, wsOrigin: string | undefined = origin, path?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${api.port}${path ?? `/api/events${value ? `?ticket=${value}` : ''}`}`, { origin: wsOrigin });
    clients.push(ws); return ws;
  }
  function refused(ws: WebSocket) {
    return new Promise<number>((resolve, reject) => {
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); ws.terminate(); });
      ws.on('open', () => reject(new Error('Unexpected upgrade')));
    });
  }
  async function opened() {
    const ws = connect(await ticket()); const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString()))); await once(ws, 'open');
    return { ws, messages };
  }
  function upgrade(path: string, overrides: { method?: string; host?: string; origin?: string } = {}) {
    return new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: api.port, path, method: overrides.method ?? 'GET', agent: false,
        headers: { Host: overrides.host ?? `127.0.0.1:${api.port}`, Origin: overrides.origin ?? origin,
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, res => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Unexpected upgrade')); });
      req.on('error', reject); req.end();
    });
  }

  it.each([
    ['missing token', {}, { Authorization: undefined }, 401],
    ['wrong token', {}, { Authorization: `Bearer ${'b'.repeat(43)}` }, 401],
    ['short token', {}, { Authorization: 'Bearer x' }, 401],
    ['query token', {}, { Authorization: undefined }, 401],
    ['localhost Host', {}, { Host: 'localhost:1' }, 403],
    ['wrong port', {}, { Host: '127.0.0.1:1' }, 403],
    ['foreign Origin', {}, { Origin: 'https://evil.example' }, 403],
    ['null Origin', {}, { Origin: 'null' }, 403],
    ['form body', 'enabled=true', { 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
  ])('rejects %s before touching the controller', async (name, body, headers, status) => {
    if ('Host' in headers && name === 'localhost Host') headers.Host = `localhost:${api.port}`;
    const path = `/api/proxy/start${name === 'query token' ? `?token=${token}` : ''}`;
    expect((await http(path, 'POST', body, headers)).status).toBe(status); untouched();
  });
  it('rejects query credentials even alongside valid authorization', async () => {
    expect((await http(`/api/state?token=${token}`)).status).toBe(401); untouched();
  });
  it('GET on mutation paths returns 405 and unknown routes return 404', async () => {
    expect((await http('/api/proxy/start')).status).toBe(405);
    expect((await http('/api/unknown')).status).toBe(404); untouched();
  });
  it('allows tokenless preflight with exact CORS headers and no controller calls', async () => {
    const res = await http('/api/proxy/start', 'OPTIONS', undefined, { Authorization: undefined });
    expect(res.status).toBe(204); expect(res.body).toBeUndefined();
    expect(res.headers).toMatchObject({ 'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600', vary: 'Origin' }); untouched();
  });
  it.each(['https://evil.example', 'null', undefined])('rejects preflight Origin %s', async Origin => {
    const res = await http('/api/proxy/start', 'OPTIONS', undefined, { Authorization: undefined, Origin });
    expect(res.status).toBe(403); expect(res.headers['access-control-allow-origin']).toBeUndefined(); untouched();
  });
  it('rejects preflight with the wrong Host', async () => {
    expect((await http('/api/proxy/start', 'OPTIONS', undefined, { Authorization: undefined, Host: 'localhost:1' })).status).toBe(403); untouched();
  });
  it('allows the shell without Origin and only emits CORS for an allowed Origin', async () => {
    const res = await http('/api/state', 'GET', undefined, { Origin: undefined });
    expect(res.status).toBe(200); expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect((await http('/api/state')).headers['access-control-allow-origin']).toBe(origin);
  });
  it('accepts the shell HTTP/1.0 state and shutdown requests', async () => {
    for (const method of ['GET', 'POST']) {
      const path = method === 'GET' ? '/api/state' : '/api/shutdown';
      const socket = connectTcp(api.port, '127.0.0.1');
      let response = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { response += chunk; });
      const ended = once(socket, 'end');
      socket.end(`${method} ${path} HTTP/1.0\r\nHost: 127.0.0.1:${api.port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\n${method === 'POST' ? 'Content-Length: 2\r\n' : ''}\r\n${method === 'POST' ? '{}' : ''}`);
      await ended;
      expect(response).toMatch(/^HTTP\/1\.1 200 /);
      const body = JSON.parse(response.split('\r\n\r\n')[1]);
      expect(body).toEqual(method === 'GET' ? controller.state() : { ok: true });
    }
    await vi.waitFor(() => expect(controller.shutdown).toHaveBeenCalledOnce());
  });
  it('can delete a profile named select without colliding with profile selection', async () => {
    expect((await http('/api/profiles/select', 'DELETE')).status).toBe(200);
    expect(controller.deleteProfile).toHaveBeenCalledWith('select');
    expect(controller.selectProfile).not.toHaveBeenCalled();
  });
  it('maps all controller routes and returns their specified shapes', async () => {
    const state = controller.state(); controller.state.mockClear();
    expect((await http('/api/state')).body).toEqual(state);
    expect((await http('/api/plugins')).body).toEqual([]);
    expect(controller.plugins).toHaveBeenCalledOnce();
    for (const [path, method] of [['/api/proxy/start', 'startProxy'], ['/api/proxy/stop', 'stopProxy'], ['/api/game/launch', 'launchGame']] as const) {
      expect((await http(path, 'POST', {})).body).toEqual(state); expect(controller[method]).toHaveBeenCalledOnce();
    }
    expect((await http('/api/helper/install', 'POST', {})).body).toEqual({ status: 'installed' });
    expect(controller.installHelper).toHaveBeenCalledOnce();
    expect((await http('/api/helper/uninstall', 'POST', {})).body).toEqual({ status: 'removed' });
    expect(controller.uninstallHelper).toHaveBeenCalledOnce();
    expect((await http('/api/game/dir', 'POST', { dir: 'D:/Exalt' })).body).toEqual(state);
    expect(controller.setGameDir).toHaveBeenCalledWith('D:/Exalt');
    for (const path of ['D:/Launcher.exe', null]) {
      expect((await http('/api/game/launcher', 'POST', { path })).body).toEqual(state); expect(controller.setLauncher).toHaveBeenLastCalledWith(path);
    }
    expect((await http('/api/profiles')).body).toEqual(state.profile);
    expect((await http('/api/profiles', 'POST', { name: 'copy', from: 'default' })).body).toEqual(state.profile);
    expect(controller.createProfile).toHaveBeenCalledWith('copy', 'default');
    expect((await http('/api/profiles/copy%20two', 'DELETE')).body).toEqual(state.profile);
    expect(controller.deleteProfile).toHaveBeenCalledWith('copy two');
    expect((await http('/api/profiles/select', 'POST', { name: 'copy' })).body).toEqual(state);
    expect(controller.selectProfile).toHaveBeenCalledWith('copy');
    expect((await http('/api/plugins/test/enabled', 'POST', { enabled: false })).body).toEqual({ ok: true });
    expect(controller.setPluginEnabled).toHaveBeenCalledWith('test', false);
    expect((await http('/api/plugins/test/settings/list', 'POST', { value: 'x'.repeat(100500) })).body).toEqual({ ok: true });
    expect(controller.updatePluginSetting).toHaveBeenCalledWith('test', 'list', 'x'.repeat(100500));
    for (let at = 1; at <= 3; at++) logs.push({ at, level: 'info', module: 'test', message: `${at}` });
    expect((await http('/api/logs?since=0')).body).toEqual(logs.since(0));
    expect((await http('/api/logs?since=2')).body).toEqual(logs.since(2));
  });
  it('maps busy, running-state conflicts, stopped plugins and plugin validation errors', async () => {
    controller.startProxy.mockRejectedValue(new OperationBusyError());
    expect((await http('/api/proxy/start', 'POST', {})).status).toBe(409);
    controller.uninstallHelper.mockRejectedValue(new Error('Stop the proxy before uninstalling the helper'));
    expect((await http('/api/helper/uninstall', 'POST', {})).status).toBe(409);
    controller.updatePluginSetting.mockReturnValue({ ok: false, error: 'Threshold must be a number' });
    const rejected = await http('/api/plugins/test/settings/threshold', 'POST', { value: 'bad' });
    expect(rejected.status).toBe(400); expect(rejected.body).toEqual({ error: 'Threshold must be a number' });
    controller.updatePluginSetting.mockReturnValue({ ok: false, error: 'Proxy is stopped' });
    controller.setPluginEnabled.mockReturnValue({ ok: false, error: 'Proxy is stopped' });
    expect((await http('/api/plugins/test/settings/threshold', 'POST', { value: 10 })).status).toBe(409);
    expect((await http('/api/plugins/test/enabled', 'POST', { enabled: true })).status).toBe(409);
  });
  it.each([
    ['/api/plugins/test/enabled', { enabled: 'true' }], ['/api/plugins/test/settings/key', {}],
    ['/api/game/dir', { dir: 123 }], ['/api/game/launcher', {}], ['/api/profiles', { name: 123 }],
    ['/api/profiles', { name: 'copy', from: 123 }], ['/api/profiles/select', {}], ['/api/proxy/start', []],
    ['/api/proxy/start', '{invalid'], ['/api/proxy/start', { extra: true }],
  ])('validates %s before controller access', async (path, body) => {
    expect((await http(path, 'POST', body)).status).toBe(400); untouched();
  });
  it('rejects invalid log cursors', async () => {
    for (const since of ['-1', 'NaN', 'Infinity', '1.5', '9007199254740992']) expect((await http(`/api/logs?since=${since}`)).status).toBe(400);
    untouched();
  });
  it('drains oversized bodies and retains the same keepalive connection', async () => {
    const rejected = await http('/api/proxy/start', 'POST', { value: 'x'.repeat(256 * 1024) });
    expect(rejected.status).toBe(413); untouched();
    const next = await http('/api/state'); expect(next.status).toBe(200); expect(next.socket).toBe(rejected.socket);
  });
  it('rejects missing, reused, expired and foreign-Origin WS tickets', async () => {
    expect(await refused(connect())).toBe(401);
    expect(await refused(connect(undefined, origin, `/api/events?token=${token}`))).toBe(401);
    const foreign = await ticket(); expect(await refused(connect(foreign, 'https://evil.example'))).toBe(403);
    expect(await refused(connect(await ticket(), 'null'))).toBe(403);
    const value = await ticket(); const ws = connect(value); await once(ws, 'open');
    expect(await refused(connect(value))).toBe(401);
    const expired = await ticket(); const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001);
    expect(await refused(connect(expired))).toBe(401); now.mockRestore(); untouched();
  });
  it.each([
    ['wrong Host', { host: 'localhost:1' }, '/api/events', '', 403],
    ['wrong Origin', { origin: 'https://evil.example' }, '/api/events', '', 403],
    ['wrong path', {}, '/api/unknown', '', 404],
    ['POST method', { method: 'POST' }, '/api/events', '', 405],
    ['query bearer', {}, '/api/events', `&token=${token}`, 401],
  ])('burns the ticket when rejecting an upgrade for %s', async (_cause, overrides, path, extra, status) => {
    const value = await ticket();
    expect(await upgrade(`${path}?ticket=${value}${extra}`, overrides)).toBe(status);
    expect(await refused(connect(value))).toBe(401); untouched();
  });
  it.each(['distinct', 'repeated', 'invalid first'])('burns every ticket in rejected multi-ticket upgrades (%s)', async kind => {
    const first = kind === 'invalid first' ? 'invalid-ticket' : await ticket();
    const second = kind === 'repeated' ? first : await ticket();
    expect(await upgrade(`/api/events?ticket=${first}&ticket=${second}`)).toBe(401);
    for (const value of new Set([first, second])) expect(await refused(connect(value))).toBe(401);
    untouched();
  });
  it('burns the ticket when the client cap rejects an upgrade, even after a slot opens', async () => {
    for (let i = 0; i < 4; i++) await opened();
    const value = await ticket();
    expect(await refused(connect(value))).toBe(409);
    const closed = once(clients[0], 'close'); clients[0].close(); await closed;
    expect(await refused(connect(value))).toBe(401); untouched();
  });
  it('delivers state, coalesced plugin snapshots, data and logs; ignores client commands', async () => {
    const { ws, messages } = await opened();
    const state = controller.state(); controller.state.mockClear();
    controller.emit('state', state);
    controller.emit('plugins', [{ id: 'old' }]); controller.emit('plugins', [{ id: 'new' }]);
    controller.emit('data', { pluginId: 'test', type: 'status', data: { safe: true } });
    const record = logs.push({ at: 1, level: 'info', module: 'test', message: 'hello' });
    ws.send(JSON.stringify({ type: 'shutdown' }));
    await vi.waitFor(() => expect(messages).toHaveLength(4));
    expect(messages).toContainEqual({ type: 'state', state });
    expect(messages).toContainEqual({ type: 'plugins', plugins: [{ id: 'new' }] });
    expect(messages).toContainEqual({ type: 'data', pluginId: 'test', dataType: 'status', data: { safe: true } });
    expect(messages).toContainEqual({ type: 'log', record }); untouched();
  });
  it('closes a slow consumer with 1013 when its send queue exceeds 1 MiB', async () => {
    const { ws } = await opened();
    // Deterministic transport backpressure without relying on OS socket buffer sizes.
    const original = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
    Object.defineProperty(WebSocket.prototype, 'bufferedAmount', { configurable: true, get: () => 1024 * 1024 });
    const closed = once(ws, 'close');
    try { controller.emit('state', { revision: 1 }); }
    finally { Object.defineProperty(WebSocket.prototype, 'bufferedAmount', original); }
    expect((await closed)[0]).toBe(1013);
  });
  it('refuses a fifth websocket', async () => {
    for (let i = 0; i < 4; i++) await opened();
    expect(await refused(connect(await ticket()))).toBe(409); untouched();
  });
  it('responds to shutdown before invoking the controller', async () => {
    controller.shutdown.mockImplementation(async () => { await api.close(); });
    const res = await http('/api/shutdown', 'POST', {});
    expect(res.status).toBe(200); expect(res.body).toEqual({ ok: true });
    await vi.waitFor(() => expect(controller.shutdown).toHaveBeenCalledOnce());
  });
  it('detaches subscriptions and closes connected sockets on close', async () => {
    const { ws } = await opened(); const closed = once(ws, 'close');
    controller.emit('plugins', []);
    await api.close(); await closed;
    for (const event of ['state', 'plugins', 'data']) expect(controller.listenerCount(event)).toBe(0);
    logs.push({ at: 1, level: 'info', module: 'test', message: 'after close' });
  });
});

it('preserves real plugin validation, stored clamping, worker configuration and stopped behavior over HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-api-plugins-'));
  for (const key of ['TMP', 'TEMP', 'TMPDIR', 'APPDATA']) vi.stubEnv(key, root);
  log.setConsole(false); const detach = log.addSink(() => {});
  const config = new AppConfigStore(root); config.update({ gameDir: root });
  const host = Object.assign(new FakeProxy(), { start: async () => 2050, stop: async () => {} });
  const button = vi.fn(), logs = new LogRing();
  const controller = new AppController({ config, resources: resourcePaths(), logs }, {
    findGameDirs: () => [], isGameDir: () => true, nativeModuleError: () => null,
    inspectHelper: () => ({ state: 'absent', backup: false }),
    installHelper: () => ({ status: 'installed', target: 'fixture', backedUp: false }),
    createHost: () => host as unknown as ReturnType<ControllerDeps['createHost']>,
    plugins: [autoNexus, { id: 'fixture', name: 'Fixture', apiVersion: 1, capabilities: [], register(ctx) {
      ctx.registerSetting('number', { label: 'Number', type: 'number', value: 1, max: 2 });
      ctx.registerSetting('secret', { label: 'Secret', type: 'text', value: '', hidden: true });
      ctx.registerSetting('go', { label: 'Go', type: 'button', value: undefined }, button);
    } }],
  });
  const api = await startApiServer(controller, logs, { token, origins: [origin] });
  async function call(path: string, body?: unknown) {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }
  try {
    expect(await call('plugins')).toEqual({ status: 200, body: [] });
    expect(await call('plugins/fixture/enabled', { enabled: true })).toEqual({ status: 409, body: { error: 'Proxy is stopped' } });
    expect(await call('plugins/fixture/settings/number', { value: 2 })).toEqual({ status: 409, body: { error: 'Proxy is stopped' } });
    expect((await call('proxy/start', {})).status).toBe(200);
    expect(await call('plugins/auto-nexus/settings/ForceAutoNexusHealth', { value: 150 })).toEqual({ status: 200, body: { ok: true } });
    const plugins = (await call('plugins')).body as PluginSnapshot[];
    expect(plugins.find(p => p.id === 'auto-nexus')!.settings.find(s => s.key === 'ForceAutoNexusHealth')!.value).toBe(100);
    expect(plugins.find(p => p.id === 'fixture')!.settings.map(s => s.key)).not.toContain('secret');
    expect((await call('plugins/auto-nexus/settings/PreHitPrediction', { value: false })).status).toBe(200);
    expect(host.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { preHitPrediction: false } } });
    expect((await call('plugins/fixture/enabled', { enabled: false })).status).toBe(200);
    const save = vi.spyOn(ProfileStore.prototype, 'scheduleSave');
    const before = controller.plugins(), workerBefore = structuredClone(host.configured);
    for (const [id, key, value, error] of [
      ['auto-nexus', 'PreHitPrediction', 'false', 'PreHitPrediction must be a boolean'],
      ['fixture', 'number', 3, 'Invalid value for number'], ['fixture', 'number', '2', 'Invalid value for number'],
      ['fixture', 'missing', true, 'Unknown setting: missing'], ['fixture', 'secret', 'x', 'Unknown setting: secret'],
      ['fixture', 'go', true, 'Plugin is disabled'], ['missing', 'number', 1, 'Unknown plugin: missing'],
    ] as const) {
      expect(await call(`plugins/${id}/settings/${key}`, { value })).toEqual({ status: 400, body: { error } });
    }
    expect(controller.plugins()).toEqual(before); expect(host.configured).toEqual(workerBefore);
    expect(save).not.toHaveBeenCalled(); expect(button).not.toHaveBeenCalled(); save.mockRestore();
    await call('proxy/stop', {});
    expect(new ProfileStore({ dir: root }).load().plugins['auto-nexus'].settings).toMatchObject({ ForceAutoNexusHealth: 100, PreHitPrediction: false });
  } finally {
    await api.close(); await controller.shutdown(); detach(); log.setConsole(true);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    expect(root.startsWith(join(tmpdir(), 'realmtool-api-plugins-'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
