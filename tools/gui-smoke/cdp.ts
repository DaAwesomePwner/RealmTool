import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pageAssertion, pageStatus } from './page.ts';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface CdpEvent { method: string; params?: Record<string, any> }
export interface Cdp {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
  close(): void;
}
interface Target { type: string; url: string; webSocketDebuggerUrl: string }

export function selectTarget(raw: unknown, port: number): Target | undefined {
  if (!Array.isArray(raw)) return;
  return raw.find(target => {
    try {
      const page = new URL(target.url), socket = new URL(target.webSocketDebuggerUrl);
      return target.type === 'page' && page.origin === 'http://tauri.localhost'
        && socket.protocol === 'ws:' && socket.hostname === '127.0.0.1' && socket.port === String(port);
    } catch { return false; }
  });
}

export async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function discoverTargets(port: number, timeout: number): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
  return response.json();
}

export async function waitForTarget(port: number, discover = discoverTargets, startupMs = 60_000, checkAlive = () => {}): Promise<Target> {
  const deadline = Date.now() + startupMs;
  let last = 'no matching page';
  checkAlive();
  while (Date.now() < deadline) {
    checkAlive();
    let target: Target | undefined;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      target = selectTarget(await bounded(discover(port, Math.min(2000, remaining)), Math.min(2000, remaining), 'page target'), port);
    } catch (error) { last = String(error); }
    checkAlive();
    if (target) return target;
    await delay(Math.max(0, Math.min(200, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for RealmTool page target on ${port}: ${last}`);
}

export function eventError(event: CdpEvent): string | undefined {
  const params = event.params;
  if (event.method === 'Runtime.exceptionThrown') {
    return params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? 'Uncaught exception';
  }
  if (event.method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
    return params.args?.map((arg: any) => arg.description ?? arg.value ?? arg.type).join(' ') || 'console.error';
  }
  if (event.method === 'Log.entryAdded' && params?.entry?.level === 'error') return params.entry.text || 'Browser log error';
}

export async function inspectPage(cdp: Cdp, options: { screenshot: string; gameDir: string; startupMs?: number }): Promise<string> {
  const errors: string[] = [];
  const unsubscribe = cdp.onEvent(event => { const error = eventError(event); if (error) errors.push(error); });
  let failure: unknown;
  let proxy = '';
  const assertPage = async (): Promise<string | null> => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: pageAssertion(options.gameDir), awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`UI assertion threw: ${JSON.stringify(result.exceptionDetails)}`);
    if (result.result?.value?.ready === true && typeof result.result.value.proxy === 'string') {
      proxy = result.result.value.proxy;
      return null;
    }
    return String(result.result?.value ?? 'UI assertion returned no value');
  };
  try {
    // Runtime.enable replays retained exceptions and console messages from startup.
    for (const domain of ['Runtime', 'Log', 'Page']) await cdp.send(`${domain}.enable`);
    const startupMs = options.startupMs ?? 30_000;
    const deadline = Date.now() + startupMs;
    let reason: string | null = 'No readiness result';
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out after ${startupMs}ms waiting for connected dashboard: ${reason}`);
      reason = await bounded(assertPage(), remaining, `connected dashboard (${startupMs}ms): ${reason}`);
      if (reason === null) break;
      await delay(Math.max(0, Math.min(200, deadline - Date.now())));
    }
    await delay(10_000);
    reason = await bounded(assertPage(), 5000, 'connected dashboard after observation');
    if (reason) throw new Error(reason);
  } catch (error) {
    let status = '(unavailable)';
    try {
      const result = await bounded(cdp.send('Runtime.evaluate', { expression: pageStatus, returnByValue: true }), 1000, 'visible UI status');
      if (typeof result.result?.value === 'string') status = result.result.value;
    } catch { /* Preserve the original failure even if the renderer cannot answer. */ }
    failure = new Error(`${error instanceof Error ? error.message : String(error)}; visible status: ${status}`, { cause: error });
  }
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (typeof data !== 'string' || !data.length) throw new Error('CDP returned an empty screenshot');
    await mkdir(dirname(options.screenshot), { recursive: true });
    await writeFile(options.screenshot, Buffer.from(data, 'base64'));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'UI assertion and screenshot failed') : error;
  } finally { unsubscribe(); }
  if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
    `UI errors: ${errors.join('\n')}${failure instanceof Error ? `\n${failure.message}` : ''}`);
  if (failure) throw failure;
  return proxy;
}
