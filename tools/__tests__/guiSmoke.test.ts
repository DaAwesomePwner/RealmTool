import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPage, selectTarget, waitForTarget, type Cdp, type CdpEvent } from '../gui-smoke/cdp.ts';
import { launchEnvironment, prepareProfile, withApp } from '../gui-smoke/process.ts';
import { pageStatus } from '../gui-smoke/page.ts';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'realmtool-gui-test-')); roots.push(root); return root; };
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const target = { type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: 'ws://127.0.0.1:9241/devtools/page/1' };

it('selects only the app page with a local debugger on our port', () => {
  expect(selectTarget([{ ...target, type: 'worker' }, { ...target, url: 'about:blank' }, target], 9241)).toEqual(target);
  expect(selectTarget([{ ...target, webSocketDebuggerUrl: 'ws://example.com:9241/page' }], 9241)).toBeUndefined();
  expect(selectTarget([{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9238/page' }], 9241)).toBeUndefined();
});

it('retries discovery until the app page appears', async () => {
  vi.useFakeTimers();
  const discover = vi.fn().mockRejectedValueOnce(new Error('not listening')).mockResolvedValueOnce([]).mockResolvedValue([target]);
  const result = waitForTarget(9241, discover, 1000);
  await vi.runAllTimersAsync();
  expect(await result).toEqual(target);
  expect(discover).toHaveBeenCalledTimes(3);
});

it('bounds startup even when discovery never resolves', async () => {
  vi.useFakeTimers();
  const result = expect(waitForTarget(9241, () => new Promise(() => {}), 500)).rejects.toThrow(/Timed out.*page target/);
  await vi.runAllTimersAsync();
  await result;
});

function mockCdp(ready = true, status = 'Connecting to backend…') {
  let listener: (event: CdpEvent) => void = () => {};
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => params?.expression === pageStatus
    ? { result: { value: status } } : method === 'Runtime.evaluate'
    ? { result: { value: ready ? { ready: true, proxy: 'bound 2050' } : '#app has no rendered children' } }
    : method === 'Page.captureScreenshot' ? { data: Buffer.from('png fixture').toString('base64') } : {});
  const cdp: Cdp = { send, onEvent: callback => { listener = callback; return () => { listener = () => {}; }; }, close: vi.fn() };
  return { cdp, send, emit: (event: CdpEvent) => listener(event) };
}

it('observes a clean page for ten seconds and writes its screenshot', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp();
  const screenshot = join(temp(), 'nested/screen.png');
  const result = inspectPage(cdp, { screenshot, gameDir: 'fake' });
  let finished = false; void result.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(9999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBe('bound 2050');
  expect(send.mock.calls.map(([method]) => method)).toEqual(expect.arrayContaining(['Runtime.enable', 'Log.enable', 'Page.enable']));
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('waits for backend readiness before starting the ten-second observation window', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp(); const screenshot = join(temp(), 'connected.png');
  const original = send.getMockImplementation()!;
  const start = Date.now();
  send.mockImplementation(async (method, params) => method === 'Runtime.evaluate' && Date.now() - start < 1500
    ? { result: { value: 'Backend is not connected' } } : original(method, params));
  const result = inspectPage(cdp, { screenshot, gameDir: 'fake' });
  await vi.advanceTimersByTimeAsync(11_599);
  expect(send.mock.calls.some(([method]) => method === 'Page.captureScreenshot')).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe('bound 2050');
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('defaults to a 30-second readiness deadline and reports the visible status with a screenshot', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp(false); const screenshot = join(temp(), 'connecting.png');
  const original = send.getMockImplementation()!;
  send.mockImplementation(async (method, params) => method === 'Runtime.evaluate' && params?.expression !== pageStatus
    ? { result: { value: 'Dashboard content is missing' } } : original(method, params));
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake' }))
    .rejects.toThrow(/Timed out.*30000ms.*Dashboard content is missing.*Connecting to backend…/);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(send.mock.calls.some(([method]) => method === 'Page.captureScreenshot')).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('bounds an unresponsive readiness evaluation and still reads status and captures a screenshot', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp(); const screenshot = join(temp(), 'hung.png');
  const original = send.getMockImplementation()!;
  send.mockImplementation((method, params) => method === 'Runtime.evaluate' && params?.expression !== pageStatus
    ? new Promise(() => {}) : original(method, params));
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake', startupMs: 500 }))
    .rejects.toThrow(/Timed out.*connected dashboard.*Connecting to backend…/);
  await vi.advanceTimersByTimeAsync(500); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('fails if the UI disconnects during observation and captures its status', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp(true, 'Connection lost. Reconnecting…'); const screenshot = join(temp(), 'lost.png');
  const original = send.getMockImplementation()!;
  const start = Date.now();
  send.mockImplementation(async (method, params) => method === 'Runtime.evaluate' && params?.expression !== pageStatus && Date.now() > start
    ? { result: { value: 'Backend is not connected' } } : original(method, params));
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake' })).rejects.toThrow(/Connection lost. Reconnecting/);
  await vi.advanceTimersByTimeAsync(10_000); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('includes readiness timeout and visible status alongside startup CSP errors', async () => {
  vi.useFakeTimers();
  const { cdp, emit } = mockCdp(false); const screenshot = join(temp(), 'csp.png');
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake', startupMs: 500 }))
    .rejects.toThrow(/UI errors: CSP blocked[\s\S]*Timed out[\s\S]*Connecting to backend…/);
  emit({ method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'CSP blocked' } } });
  await vi.advanceTimersByTimeAsync(500); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('still captures a screenshot when the visible-status query hangs', async () => {
  vi.useFakeTimers();
  const { cdp, send } = mockCdp(false); const screenshot = join(temp(), 'no-status.png');
  const original = send.getMockImplementation()!;
  send.mockImplementation((method, params) => params?.expression === pageStatus ? new Promise(() => {}) : original(method, params));
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake', startupMs: 500 }))
    .rejects.toThrow(/Timed out.*visible status: \(unavailable\)/);
  await vi.advanceTimersByTimeAsync(1500); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it.each([
  { method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'boom' } } } },
  { method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ value: 'boom' }] } },
  { method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'boom' } } },
])('fails on $method and still captures a screenshot', async event => {
  vi.useFakeTimers();
  const { cdp, emit } = mockCdp(); const screenshot = join(temp(), 'failure.png');
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake' })).rejects.toThrow(/boom/);
  await vi.advanceTimersByTimeAsync(100); emit(event);
  await vi.runAllTimersAsync(); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('fails a missing root after the bounded render wait and captures it', async () => {
  vi.useFakeTimers();
  const { cdp } = mockCdp(false); const screenshot = join(temp(), 'missing.png');
  const result = expect(inspectPage(cdp, { screenshot, gameDir: 'fake', startupMs: 500 })).rejects.toThrow(/#app/);
  await vi.runAllTimersAsync(); await result;
  expect(readFileSync(screenshot).toString()).toBe('png fixture');
});

it('builds fake files and overrides inherited profile/debugging variables case-insensitively', () => {
  const root = temp(); const gameDir = prepareProfile(root, 'build-123');
  const env = launchEnvironment(root, 9241, { AppData: 'real', localappdata: 'real', NODE_OPTIONS: '--inspect', PATH: 'keep',
    webview2_additional_browser_arguments: '--inherited' });
  expect(env.AppData).toBeUndefined(); expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.PATH).toBe('keep');
  expect(env.APPDATA).toBe(join(root, 'home/AppData/Roaming')); expect(env.LOCALAPPDATA).toBe(join(root, 'home/AppData/Local'));
  expect(env.WEBVIEW2_USER_DATA_FOLDER).toBe(join(root, 'webview'));
  expect(env.REALMTOOL_GUI_SMOKE_CDP_PORT).toBe('9241');
  expect(env.webview2_additional_browser_arguments).toBeUndefined(); expect(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, 'home/AppData/Roaming/RealmTool/config.json'), 'utf8'))).toMatchObject({ gameDir, launcher: null });
  expect(readFileSync(join(gameDir, 'RotMG Exalt_Data/boot.config'), 'utf8')).toBe('build-guid=build-123\n');
  // Tauri's known-folder lookup fails ("unknown path") unless these exist under the fake USERPROFILE.
  expect(existsSync(join(env.USERPROFILE!, 'AppData/Roaming'))).toBe(true);
  expect(existsSync(join(env.USERPROFILE!, 'AppData/Local'))).toBe(true);
});

it('kills the process tree and removes the profile when inspection fails', async () => {
  const stop = vi.fn(async () => {}); const verify = vi.fn(async () => {}); const remove = vi.fn(async () => {});
  await expect(withApp(async () => { throw new Error('root missing'); }, { stop, verify, remove })).rejects.toThrow('root missing');
  expect(stop).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
  expect(stop.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
  expect(verify.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
});

it('attempts profile removal even when killing fails', async () => {
  const remove = vi.fn(async () => {});
  await expect(withApp(async () => {}, { stop: async () => { throw new Error('taskkill failed'); }, remove })).rejects.toThrow('taskkill failed');
  expect(remove).toHaveBeenCalledOnce();
});

it('fails isolation violations but still removes the temporary profile', async () => {
  const remove = vi.fn(async () => {});
  await expect(withApp(async () => {}, { stop: async () => {},
    verify: async () => { throw new Error('Known-folder isolation violated'); }, remove })).rejects.toThrow('isolation violated');
  expect(remove).toHaveBeenCalledOnce();
});
