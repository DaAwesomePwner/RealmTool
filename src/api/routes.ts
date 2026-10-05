import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppController, OperationBusyError } from '../app/controller.ts';
import type { LogRing } from '../util/logStore.ts';
import { log } from '../util/log.ts';
import type { ApiAuth } from './auth.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Request failed';
  const status = error instanceof HttpError ? error.status
    : error instanceof OperationBusyError || message.startsWith('Stop the proxy before ') ? 409 : 400;
  sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    req.resume(); throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0, oversized = false;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) { oversized = true; chunks.length = 0; }
    if (!oversized) chunks.push(chunk);
  }
  // Consume the whole request, so a 413 does not poison the keepalive connection.
  if (oversized) throw new HttpError(413, 'Request body exceeds 256 KiB');
  let body: unknown;
  try { body = size === 0 && req.method === 'DELETE' ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new HttpError(400, 'Invalid request fields');
  }
}
function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') throw new HttpError(400, `${key} must be a string`);
  return body[key];
}
function pluginResult(result: { ok: true } | { ok: false; error: string }): { ok: true } {
  if (!result.ok) throw new HttpError(result.error === 'Proxy is stopped' ? 409 : 400, result.error);
  return result;
}

/** Called only after request authentication; a matched path has an explicit method list. */
export async function route(req: IncomingMessage, res: ServerResponse, url: URL,
  controller: AppController, logs: LogRing, auth: ApiAuth): Promise<void> {
  let parts: string[];
  try { parts = url.pathname.split('/').slice(1).map(decodeURIComponent); }
  catch { throw new HttpError(400, 'Invalid path encoding'); }
  const path = url.pathname;
  const enabled = parts.length === 4 && parts[0] === 'api' && parts[1] === 'plugins' && parts[3] === 'enabled';
  const setting = parts.length === 5 && parts[0] === 'api' && parts[1] === 'plugins' && parts[3] === 'settings';
  const profilePath = parts.length === 3 && parts[0] === 'api' && parts[1] === 'profiles';
  const reads = ['/api/state', '/api/plugins', '/api/logs'];
  const actions = ['/api/proxy/start', '/api/proxy/stop', '/api/game/launch', '/api/helper/install', '/api/helper/uninstall',
    '/api/game/dir', '/api/game/launcher', '/api/profiles/select', '/api/ws-ticket', '/api/shutdown'];
  const methods = reads.includes(path) ? ['GET'] : path === '/api/profiles' ? ['GET', 'POST']
    : path === '/api/profiles/select' ? ['POST', 'DELETE']
    : enabled || setting || actions.includes(path) ? ['POST'] : profilePath ? ['DELETE'] : [];
  if (!methods.length) throw new HttpError(404, 'Not found');
  if (!methods.includes(req.method ?? '')) { res.setHeader('Allow', methods.join(', ')); throw new HttpError(405, 'Method not allowed'); }

  if (req.method === 'GET') {
    if (path === '/api/state') return sendJson(res, 200, controller.state());
    if (path === '/api/plugins') return sendJson(res, 200, controller.plugins());
    if (path === '/api/profiles') return sendJson(res, 200, controller.state().profile);
    const raw = url.searchParams.get('since') ?? '0', seq = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seq)) throw new HttpError(400, 'since must be a nonnegative safe integer');
    return sendJson(res, 200, logs.since(seq));
  }

  const body = await readBody(req);
  let result: unknown;
  if (enabled) {
    fields(body, ['enabled']);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    result = pluginResult(controller.setPluginEnabled(parts[2], body.enabled));
  } else if (setting) {
    fields(body, ['value']); result = pluginResult(controller.updatePluginSetting(parts[2], parts[4], body.value));
  } else if (profilePath && req.method === 'DELETE') {
    fields(body, []); await controller.deleteProfile(parts[2]); result = controller.state().profile;
  } else if (path === '/api/game/dir') {
    fields(body, ['dir']); await controller.setGameDir(stringField(body, 'dir')); result = controller.state();
  } else if (path === '/api/game/launcher') {
    fields(body, ['path']);
    const launcher = body.path === null ? null : stringField(body, 'path');
    await controller.setLauncher(launcher); result = controller.state();
  } else if (path === '/api/profiles') {
    fields(body, ['name'], ['from']);
    await controller.createProfile(stringField(body, 'name'), Object.hasOwn(body, 'from') ? stringField(body, 'from') : undefined);
    result = controller.state().profile;
  } else if (path === '/api/profiles/select') {
    fields(body, ['name']); await controller.selectProfile(stringField(body, 'name')); result = controller.state();
  } else {
    fields(body, []);
    switch (path) {
      case '/api/proxy/start': await controller.startProxy(); result = controller.state(); break;
      case '/api/proxy/stop': await controller.stopProxy(); result = controller.state(); break;
      case '/api/game/launch': await controller.launchGame(); result = controller.state(); break;
      case '/api/helper/install': result = { status: (await controller.installHelper()).status }; break;
      case '/api/helper/uninstall': result = { status: await controller.uninstallHelper() }; break;
      case '/api/ws-ticket': result = { ticket: auth.issueTicket() }; break;
      case '/api/shutdown':
        // Let the response finish before runSidecar tears down its listener.
        res.once('finish', () => setImmediate(() => {
          void controller.shutdown().catch(() => log.error('API', 'Shutdown failed'));
        }));
        result = { ok: true }; break;
    }
  }
  sendJson(res, 200, result);
}
