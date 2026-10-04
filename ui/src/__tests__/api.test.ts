// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../api.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('authenticates HTTP, preserves backend rejection messages and never sends tokens to arbitrary origins', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal('fetch', fetch);
  const api = new ApiClient({ port: 1234, token: 'secret' });
  await api.get('/api/state'); await api.post('/api/proxy/start', {}); await api.del('/api/profiles/other');
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:1234\/api\//);
    expect(init.headers.Authorization).toBe('Bearer secret'); expect(url).not.toContain('secret');
  }
  expect(fetch.mock.calls[1][1].headers['Content-Type']).toBe('application/json');
  expect(fetch.mock.calls[1][1].body).toBe('{}');
  expect(fetch.mock.calls[2][1].method).toBe('DELETE');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Proxy is stopped' }), { status: 409 }));
  await expect(api.post('/api/proxy/start', {})).rejects.toThrow('Proxy is stopped');
  await expect(api.get('https://example.com/api/state')).rejects.toThrow();
});

it('gets a fresh one-use ticket before each WebSocket, reconnects with bounded backoff and cancels cleanly', async () => {
  vi.useFakeTimers(); const order: string[] = []; let tickets = 0;
  const fetch = vi.fn(async () => { order.push('ticket'); return new Response(JSON.stringify({ ticket: `ticket-${++tickets}` })); });
  class Socket {
    static sockets: Socket[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    close = vi.fn();
    readonly url: string;
    constructor(url: string) { this.url = url; order.push('socket'); Socket.sockets.push(this); }
  }
  vi.stubGlobal('fetch', fetch); vi.stubGlobal('WebSocket', Socket);
  const api = new ApiClient({ port: 1234, token: 'secret' }); const event = vi.fn();
  const stop = await api.events(event);
  expect(order).toEqual(['ticket', 'socket']);
  expect(Socket.sockets[0].url).toBe('ws://127.0.0.1:1234/api/events?ticket=ticket-1');
  Socket.sockets[0].onmessage!({ data: JSON.stringify({ type: 'state', state: {} }) }); expect(event).toHaveBeenCalledWith({ type: 'state', state: {} });
  for (let i = 0; i < 5; i++) {
    Socket.sockets.at(-1)!.onclose!(); await vi.advanceTimersByTimeAsync(5000);
    expect(Socket.sockets.length).toBe(i + 2);
  }
  expect(tickets).toBe(6); stop();
  expect(Socket.sockets.at(-1)!.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000); expect(tickets).toBe(6);
});

it('retries a failed ticket request and cancels retries without opening a socket', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  const socket = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubGlobal('WebSocket', socket);
  const api = new ApiClient({ port: 1234, token: 'secret' });
  const stop = await api.events(() => {});
  await vi.advanceTimersByTimeAsync(250); expect(fetch).toHaveBeenCalledTimes(2);
  stop(); await vi.advanceTimersByTimeAsync(10000);
  expect(fetch).toHaveBeenCalledTimes(2); expect(socket).not.toHaveBeenCalled();
});
