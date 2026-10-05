import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppController, AppState, ControllerEvents } from '../app/controller.ts';
import type { PluginSnapshot } from '../plugins/snapshot.ts';
import type { LogRing } from '../util/logStore.ts';
import { ApiAuth } from './auth.ts';
import { HttpError, route, sendError, sendJson } from './routes.ts';

function requestUrl(req: IncomingMessage): URL {
  // Only origin-form request targets are accepted; never trust a supplied URL authority.
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'Invalid request target');
  return new URL(req.url, 'http://127.0.0.1');
}

function rejectQueryCredentials(url: URL): void {
  if (url.searchParams.has('token') || url.searchParams.has('access_token')) throw new HttpError(401, 'Query credentials are not accepted');
}

export function startApiServer(controller: AppController, logs: LogRing,
  options: { token: string; origins: string[]; port?: number }): Promise<{ port: number; close(): Promise<void> }> {
  const auth = new ApiAuth(options.token, options.origins);
  let port = 0, closing = false;
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const preflight = req.method === 'OPTIONS';
    const denied = preflight ? auth.checkLocation(req.headers, port, true) : auth.check(req.headers, port);
    if (denied) { req.resume(); sendJson(res, denied, { error: denied === 401 ? 'Unauthorized' : 'Forbidden' }); return; }
    if (auth.allowedOrigin(req.headers.origin)) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (preflight) {
      req.resume(); res.setHeader('Access-Control-Max-Age', '600'); res.writeHead(204); res.end(); return;
    }
    void (async () => {
      try {
        const url = requestUrl(req);
        rejectQueryCredentials(url);
        await route(req, res, url, controller, logs, auth);
      }
      catch (error) { req.resume(); if (!res.destroyed && !res.headersSent) sendError(res, error); }
    })();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  function reject(socket: Duplex, status: number): void {
    const body = JSON.stringify({ error: status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Upgrade rejected' });
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
  }
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    try {
      const url = requestUrl(req);
      // Presenting a ticket spends it, even if any later upgrade check rejects.
      // Do not short-circuit: multi-ticket attempts must consume every value.
      const tickets = url.searchParams.getAll('ticket');
      const validTickets = tickets.map(ticket => auth.consumeTicket(ticket));
      const denied = auth.checkLocation(req.headers, port);
      if (denied) throw new HttpError(denied, 'Forbidden');
      rejectQueryCredentials(url);
      if (url.pathname !== '/api/events') throw new HttpError(404, 'Not found');
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      if (closing || wss.clients.size >= 4) throw new HttpError(409, 'Too many clients');
      if (tickets.length !== 1 || !validTickets[0]) throw new HttpError(401, 'Invalid ticket');
      wss.handleUpgrade(req, socket, head, ws => { ws.on('error', () => {}); });
    } catch (error) { reject(socket, error instanceof HttpError ? error.status : 400); }
  });

  const closeTimers = new Set<NodeJS.Timeout>();
  function broadcast(event: unknown): void {
    if (closing || !wss.clients.size) return;
    const data = JSON.stringify(event), size = Buffer.byteLength(data);
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount + size > 1024 * 1024) {
        ws.close(1013, 'Send queue exceeded');
        // A peer that does not read cannot finish a close handshake indefinitely.
        const timer = setTimeout(() => { closeTimers.delete(timer); ws.terminate(); }, 1000);
        timer.unref(); closeTimers.add(timer);
        ws.once('close', () => { clearTimeout(timer); closeTimers.delete(timer); });
      } else ws.send(data, error => { if (error) ws.terminate(); });
    }
  }
  let pluginTimer: NodeJS.Timeout | undefined;
  let pendingPlugins: PluginSnapshot[];
  const state = (state: AppState) => broadcast({ type: 'state', state });
  const plugins = (plugins: PluginSnapshot[]) => {
    pendingPlugins = plugins;
    pluginTimer ??= setTimeout(() => { pluginTimer = undefined; broadcast({ type: 'plugins', plugins: pendingPlugins }); }, 100);
  };
  const data = (event: ControllerEvents['data'][0]) => broadcast({ type: 'data', pluginId: event.pluginId, dataType: event.type, data: event.data });
  controller.on('state', state); controller.on('plugins', plugins); controller.on('data', data);
  const detachLogs = logs.subscribe(record => broadcast({ type: 'log', record }));
  function detach(): void {
    closing = true; auth.clear(); detachLogs();
    controller.off('state', state); controller.off('plugins', plugins); controller.off('data', data);
    clearTimeout(pluginTimer);
    for (const timer of closeTimers) clearTimeout(timer);
    closeTimers.clear();
  }
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    return closePromise ??= new Promise<void>((resolve, reject) => {
      detach();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { detach(); wss.close(); reject(error); };
    server.once('error', failed);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', failed);
      port = (server.address() as { port: number }).port;
      resolve({ port, close });
    });
  });
}
