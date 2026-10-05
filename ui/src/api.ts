import { invoke, isTauri } from '@tauri-apps/api/core';

export interface BackendInfo { port: number; token: string }

/** The backend's AppState, imported type-only so the bundle carries no backend code. */
export type { AppState } from '../../src/app/controller.ts';

export async function backendInfo(): Promise<BackendInfo> {
  if (isTauri()) return invoke<BackendInfo>('backend_info');
  const port = Number(import.meta.env.VITE_REALMTOOL_PORT);
  const token = import.meta.env.VITE_REALMTOOL_TOKEN as string | undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    throw new Error('Set VITE_REALMTOOL_PORT and VITE_REALMTOOL_TOKEN to connect to the development backend.');
  }
  return { port, token };
}

export class ApiClient {
  private readonly base: string;
  private readonly token: string;
  onConnection: (connected: boolean) => void = () => {};

  constructor(info: BackendInfo) {
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !info.token) throw new Error('Invalid backend connection information');
    this.base = `http://127.0.0.1:${info.port}`;
    this.token = info.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith('/api/') || new URL(path, this.base).origin !== this.base) throw new Error('Invalid API path');
    const response = await fetch(this.base + path, {
      method, headers: { Authorization: `Bearer ${this.token}`, ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      cache: 'no-store', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Request failed (${response.status})`);
    return result as T;
  }

  get<T>(path: string): Promise<T> { return this.request('GET', path); }
  post<T>(path: string, body: unknown): Promise<T> { return this.request('POST', path, body); }
  del<T>(path: string): Promise<T> { return this.request('DELETE', path); }

  async events(onEvent: (event: unknown) => void): Promise<() => void> {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let delay = 250;
    const schedule = () => {
      clearTimeout(watchdog);
      if (stopped || retry !== undefined) return;
      this.onConnection(false);
      retry = setTimeout(() => { retry = undefined; void connect(); }, delay);
      delay = Math.min(delay * 2, 5000);
    };
    const closeSocket = (current: WebSocket) => {
      current.onopen = null; current.onmessage = null; current.onclose = null; current.onerror = null;
      if (socket === current) socket = undefined;
      current.close();
    };
    const connect = async () => {
      try {
        const { ticket } = await this.post<{ ticket: string }>('/api/ws-ticket', {});
        if (stopped) return;
        const current = new WebSocket(`${this.base.replace('http:', 'ws:')}/api/events?ticket=${encodeURIComponent(ticket)}`);
        if (socket) closeSocket(socket);
        socket = current;
        current.onopen = () => { if (socket !== current) return; clearTimeout(watchdog); delay = 250; this.onConnection(true); };
        current.onmessage = event => {
          if (socket !== current) return;
          let parsed: unknown;
          try { parsed = JSON.parse(String(event.data)); } catch { return; }
          onEvent(parsed);
        };
        current.onclose = () => {
          if (socket !== current) return;
          closeSocket(current); schedule();
        };
        current.onerror = () => { if (socket !== current) return; closeSocket(current); schedule(); };
        watchdog = setTimeout(() => { if (socket !== current) return; closeSocket(current); schedule(); }, 5000);
      } catch { schedule(); }
    };
    await connect();
    return () => {
      stopped = true;
      clearTimeout(retry); clearTimeout(watchdog);
      if (socket) closeSocket(socket);
    };
  }
}
