import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pageAssertion } from './page.ts';

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

export async function waitForTarget(port: number, discover = discoverTargets, startupMs = 60_000): Promise<Target> {
  const deadline = Date.now() + startupMs;
  let last = 'no matching page';
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const target = selectTarget(await bounded(discover(port, Math.min(2000, remaining)), remaining, 'page target'), port);
      if (target) return target;
    } catch (error) { last = String(error); }
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
    const deadline = Date.now() + (options.startupMs ?? 60_000);
    let reason: string | null;
    while ((reason = await assertPage()) !== null) {
      if (errors.length) throw new Error(errors.join('\n'));
      if (Date.now() >= deadline) throw new Error(`UI did not become ready: ${reason}`);
      await delay(200);
    }
    await delay(10_000);
    reason = await assertPage();
    if (reason) throw new Error(reason);
  } catch (error) { failure = error; }
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (typeof data !== 'string' || !data.length) throw new Error('CDP returned an empty screenshot');
    await mkdir(dirname(options.screenshot), { recursive: true });
    await writeFile(options.screenshot, Buffer.from(data, 'base64'));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'UI assertion and screenshot failed') : error;
  } finally { unsubscribe(); }
  if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, `UI errors: ${errors.join('\n')}`);
  if (failure) throw failure;
  return proxy;
}
