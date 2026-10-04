// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { AppState } from '../api.ts';

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), exited: undefined as (() => void) | undefined }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: bridge.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: bridge.listen }));
afterEach(() => { window.dispatchEvent(new Event('beforeunload')); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('loads through the Tauri bridge, handles all event kinds, and restarts after backend-exited', async () => {
  const state: AppState = {
    proxy: { state: 'stopped', port: null, error: null }, game: { dir: null, candidates: [], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 0,
  };
  const plugin = { id: 'test', name: 'Test plugin', category: 'Utility', enabled: true, failed: null, settings: [], data: {} };
  bridge.invoke.mockResolvedValue({ port: 1234, token: 'secret' });
  bridge.listen.mockImplementation(async (_type, callback) => { bridge.exited = callback; return () => {}; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('ws-ticket') ? { ticket: 'one-use' } : url.endsWith('/state') ? state : url.endsWith('/plugins') ? [plugin] : { records: [], next: 0, dropped: false },
  ))));
  class Socket {
    static current: Socket;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    close = vi.fn();
    constructor() { Socket.current = this; }
  }
  vi.stubGlobal('WebSocket', Socket);
  const root = document.createElement('main'); root.id = 'app'; document.body.append(root);
  await import('../main.ts');
  await vi.waitFor(() => expect(root.textContent).toContain('Test plugin'));
  expect(bridge.invoke).toHaveBeenCalledWith('backend_info');
  expect(bridge.listen).toHaveBeenCalledWith('backend-exited', expect.any(Function));
  Socket.current.onopen!();
  const send = (event: unknown) => Socket.current.onmessage!({ data: JSON.stringify(event) });
  send({ type: 'state', state: { ...state, proxy: { state: 'running', port: 2050, error: null } } });
  send({ type: 'plugins', plugins: [plugin] });
  send({ type: 'data', pluginId: 'test', dataType: 'status', data: { state: 'Protection waiting' } });
  send({ type: 'log', record: { seq: 1, at: 0, level: 'info', module: 'test', message: 'Event delivered' } });
  expect(root.textContent).toContain('Stop proxy'); expect(root.textContent).toContain('Protection waiting'); expect(root.textContent).toContain('Event delivered');
  bridge.exited!(); expect(root.textContent).toContain('Backend stopped');
  expect(Socket.current.close).toHaveBeenCalled();
  const restart = [...root.querySelectorAll('button')].find(button => button.textContent === 'Restart')!;
  expect(restart.hidden).toBe(false);
  const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
  restart.click(); await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  expect(bridge.invoke).toHaveBeenCalledWith('restart_backend');
});

it.each(['old-first', 'new-first'])('retains overlapping history with intervening live records (%s)', async order => {
  vi.resetModules();
  const state: AppState = {
    proxy: { state: 'stopped', port: null, error: null }, game: { dir: null, candidates: [], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 0,
  };
  const record = (seq: number) => ({ seq, at: 0, level: 'info', module: 'test', message: `Record ${seq}` });
  const histories: Array<{ url: string; resolve: (response: Response) => void }> = [];
  bridge.invoke.mockResolvedValue({ port: 1234, token: 'secret' });
  bridge.listen.mockImplementation(async () => () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/logs')) return new Promise<Response>(resolve => histories.push({ url, resolve }));
    return new Response(JSON.stringify(url.endsWith('ws-ticket') ? { ticket: 'one-use' } : url.endsWith('/state') ? state : []));
  }));
  class Socket {
    static current: Socket;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    close = vi.fn();
    constructor() { Socket.current = this; }
  }
  vi.stubGlobal('WebSocket', Socket);
  const root = document.createElement('main'); root.id = 'app'; document.body.append(root);
  await import('../main.ts');
  await vi.waitFor(() => expect(histories).toHaveLength(1));
  histories[0].resolve(new Response(JSON.stringify({ records: [record(10)], next: 10, dropped: false })));
  await vi.waitFor(() => expect(root.querySelector('[data-seq="10"]')).not.toBeNull());
  Socket.current.onopen!();
  await vi.waitFor(() => expect(histories).toHaveLength(2));
  expect(histories[1].url).toContain('since=10');
  Socket.current.onmessage!({ data: JSON.stringify({ type: 'log', record: record(20) }) });
  Socket.current.onopen!();
  await vi.waitFor(() => expect(histories).toHaveLength(3));
  expect(histories[2].url).toContain('since=20');
  const finishOld = () => histories[1].resolve(new Response(JSON.stringify({ records: Array.from({ length: 10 }, (_, index) => record(index + 11)), next: 20, dropped: false })));
  // The response cursor must not skip records which weren't actually merged.
  const finishNew = () => histories[2].resolve(new Response(JSON.stringify({ records: [record(21)], next: 99, dropped: false })));
  if (order === 'old-first') { finishOld(); await new Promise(resolve => setTimeout(resolve, 0)); finishNew(); }
  else { finishNew(); await new Promise(resolve => setTimeout(resolve, 0)); finishOld(); }
  await vi.waitFor(() => expect([...root.querySelectorAll<HTMLElement>('.log-row')].map(row => Number(row.dataset.seq))).toEqual(Array.from({ length: 12 }, (_, index) => index + 10)));
  Socket.current.onopen!();
  await vi.waitFor(() => expect(histories).toHaveLength(4));
  expect(histories[3].url).toContain('since=21');
  histories[3].resolve(new Response(JSON.stringify({ records: [], next: 99, dropped: false })));
});
