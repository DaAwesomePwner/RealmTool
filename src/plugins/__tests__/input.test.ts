import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { definePlugin, type ClientConnection, type PulseResult } from '../api.ts';
import type { GameInputSource, GameWindow } from '../../input/gameInput.ts';
import { win32GameInputSource, win32GameInputError } from '../../input/win32GameInput.ts';
import { startHost, type Harness } from '../../testing/pluginHarness.ts';
import { log, type LogRecord } from '../../util/log.ts';

vi.mock('../../input/win32GameInput.ts', () => ({
  win32GameInputSource: vi.fn(() => null),
  win32GameInputError: vi.fn(() => 'native input unavailable in test'),
}));

const window: GameWindow = { handle: {}, minimized: false, client: { left: 0, top: 0, right: 100, bottom: 100 } };
function fake() {
  return {
    identify: vi.fn<GameInputSource['identify']>(() => ({ pid: 7, processStartTime: '100' })),
    findGameWindow: vi.fn<GameInputSource['findGameWindow']>(() => window),
    cursor: vi.fn(() => ({ x: 500, y: 500 })),
    post: vi.fn(() => true),
  };
}
const hosts: Harness[] = [];
const records: LogRecord[] = [];
let removeSink: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  log.setConsole(false);
  removeSink = log.addSink(record => records.push(record));
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.host.stop();
  removeSink();
  records.length = 0;
  log.setConsole(true);
});
function setup(input?: GameInputSource | null, capability = true) {
  const clients: ClientConnection[] = [];
  const h = startHost([definePlugin({
    id: 'input-test', name: 'Input test', apiVersion: 1,
    capabilities: capability ? ['input'] : [],
    register: ctx => ctx.on('clientConnected', client => clients.push(client)),
  })], { input });
  hosts.push(h);
  h.connect('c1', 54321);
  const ctx = h.host.context('input-test')!;
  return { h, ctx, clients, client: clients[0] };
}

it('requires the input capability', () => {
  const { ctx } = setup(null, false);
  expect(() => ctx.input).toThrow('"input" capability');
});

it('binds the first identity using the session port and pulses only its window', async () => {
  const source = fake();
  const { ctx, client } = setup(source);
  const result: PulseResult = await ctx.input.pulse(client);
  expect(result).toEqual({ ok: true, minimized: false });
  expect(source.identify).toHaveBeenCalledWith(54321);
  expect(source.findGameWindow).toHaveBeenCalledWith(7);
  expect(source.post.mock.calls).toEqual([[window.handle, 0x201, 1, 1], [window.handle, 0x202, 0, 1]]);
});

it.each([{ pid: 7, processStartTime: '200' }, { pid: 8, processStartTime: '100' }])(
  'rejects changed identity %j without looking up a window or posting', async identity => {
    const source = fake();
    const { ctx, client } = setup(source);
    await ctx.input.pulse(client);
    source.post.mockClear();
    source.findGameWindow.mockClear();
    source.identify.mockReturnValue(identity);
    expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'process-changed' });
    expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'process-changed' });
    expect(source.post).not.toHaveBeenCalled();
    expect(source.findGameWindow).not.toHaveBeenCalled();
  },
);

it('returns no-process when identification is missing', async () => {
  const source = fake();
  source.identify.mockReturnValue(null);
  const { ctx, client } = setup(source);
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'no-process' });
  expect(source.post).not.toHaveBeenCalled();
});

it('snapshots the identity and gives a replacement session its own binding', async () => {
  const source = fake();
  const identity = { pid: 7, processStartTime: '100' };
  source.identify.mockReturnValue(identity);
  const { ctx, client, h, clients } = setup(source);
  await ctx.input.pulse(client);
  identity.processStartTime = '200';
  source.post.mockClear();
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'process-changed' });
  expect(source.post).not.toHaveBeenCalled();
  h.close(client.clientId);
  h.connect('c1', 54322);
  expect(await ctx.input.pulse(clients[1])).toEqual({ ok: true, minimized: false });
  expect(source.identify).toHaveBeenLastCalledWith(54322);
});

it('still releases the click when disconnected between down and up', async () => {
  const source = fake();
  const { ctx, client, h } = setup(source);
  const pending = ctx.input.pulse(client);
  expect(source.post).toHaveBeenCalledTimes(1);
  h.close(client.clientId);
  expect(await pending).toEqual({ ok: true, minimized: false });
  expect(source.post.mock.calls).toEqual([[window.handle, 0x201, 1, 1], [window.handle, 0x202, 0, 1]]);
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'no-process' });
  expect(source.identify).toHaveBeenCalledTimes(1);
});

it('binds identity even if the first window lookup fails', async () => {
  const source = fake();
  source.findGameWindow.mockReturnValue(null);
  const { ctx, client } = setup(source);
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'no-window' });
  source.identify.mockReturnValue({ pid: 7, processStartTime: '200' });
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'process-changed' });
  expect(source.post).not.toHaveBeenCalled();
});

it('explicit null disables input without loading native code or warning', async () => {
  const { ctx, client } = setup(null);
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'unavailable' });
  expect(win32GameInputSource).not.toHaveBeenCalled();
  expect(records).toEqual([]);
});

it('loads the default lazily and warns once when unavailable', async () => {
  const { ctx, client } = setup();
  expect(win32GameInputSource).not.toHaveBeenCalled();
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'unavailable' });
  expect(win32GameInputSource).toHaveBeenCalled();
  expect(win32GameInputError).toHaveBeenCalledTimes(1);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('native input unavailable in test') });
});

it('rejects disconnected and unknown facades without identification', async () => {
  const source = fake();
  const { ctx, h, client } = setup(source);
  expect(await ctx.input.pulse({ ...client })).toEqual({ ok: false, reason: 'no-process' });
  h.close(client.clientId);
  expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'no-process' });
  expect(source.identify).not.toHaveBeenCalled();
  expect(source.post).not.toHaveBeenCalled();
});

it('contains identify exceptions and warns at most once per session', async () => {
  const source = fake();
  source.identify.mockImplementation(() => { throw new Error('lookup failed'); });
  const { ctx, client, h, clients } = setup(source);
  for (let i = 0; i < 2; i++) expect(await ctx.input.pulse(client)).toEqual({ ok: false, reason: 'no-process' });
  expect(records).toHaveLength(1);
  expect(records[0].level).toBe('warn');
  h.close(client.clientId);
  h.connect('c1', 54322);
  expect(await ctx.input.pulse(clients[1])).toEqual({ ok: false, reason: 'no-process' });
  expect(records).toHaveLength(2);
  expect(source.post).not.toHaveBeenCalled();
});
