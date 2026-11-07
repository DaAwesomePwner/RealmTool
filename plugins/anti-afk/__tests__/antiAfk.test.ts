import { afterEach, expect, it, vi } from 'vitest';
import plugin from '../index.ts';
import { InactivityDetector } from '../detector.ts';
import { validate } from '../settings.ts';
import { BUILTIN_PLUGINS } from '../../index.ts';
import type { ClientConnection, ConnectionEvent, PacketHook, PluginContext, PulseResult } from '../../../src/plugins/api.ts';
import { createPacket } from '../../../src/protocol/Packet.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
import { pulseGameWindow, type GameInputSource } from '../../../src/input/gameInput.ts';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0, change = () => {}, cleanup = () => {};
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const hooks = new Map<string, PacketHook>();
  const events = new Map<ConnectionEvent, (c: ClientConnection) => void>();
  const settings = new Map<string, unknown>();
  const data = new Map<string, any>();
  const lines: string[] = [];
  const pulse = vi.fn<() => Promise<PulseResult>>().mockResolvedValue({ ok: true, minimized: false });
  const setData = vi.fn((k: string, v: unknown) => data.set(k, v));
  const ctx = { enabled: true, input: { pulse },
    observePacket: (n: string, f: PacketHook) => hooks.set(n, f),
    on: (n: ConnectionEvent, f: (c: ClientConnection) => void) => events.set(n, f),
    registerSetting: (k: string, d: { value: unknown }) => settings.set(k, d.value),
    getSetting: (k: string) => settings.get(k), setData,
    log: (s: string) => lines.push(s), onEnabledChange: (f: () => void) => { change = f; },
    registerCleanup: (f: () => void) => { cleanup = f; },
  } as unknown as PluginContext;
  plugin.register(ctx);
  const client = { clientId: 'test', connected: true } as ClientConnection;
  function packet(name: string, records: unknown = [{ x: 1, y: 1 }]) {
    const p = createPacket(0, name, name === 'MAPINFO' || name === 'RECONNECT' ? 'server' : 'client');
    p.isDefined = true; p.data = { records };
    const before = structuredClone(p);
    hooks.get(name)?.(client, p);
    expect(structuredClone(p)).toEqual(before);
  }
  return { ctx, pulse, data, lines, client, packet, settings, setData,
    enable: (v = true) => { ctx.enabled = v; change(); },
    connect: () => events.get('clientConnected')!(client),
    close: () => { Object.assign(client, { connected: false }); events.get('clientDisconnected')!(client); },
    cleanup: () => cleanup(),
    gap: (ms: number) => { now += ms; packet('MOVE'); },
    moves: (ms: number, x = 1) => { for (let end = now + ms; now < end;) { now += 200; packet('MOVE', [{ x, y: 1 }]); } },
    start: () => packet('MOVE'),
  };
}
it('throttles 50 MOVEs per second and publishes only changed idle seconds', () => {
  const f = fixture(); f.setData.mockClear(); f.enable(); f.start();
  for (let i = 0; i < 50; i++) { f.gap(20); vi.advanceTimersByTime(20); }
  expect(f.setData.mock.calls.length).toBeLessThanOrEqual(2);
  expect(f.data.get('status').idleSeconds).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  f.setData.mockClear();
  vi.advanceTimersByTime(1000); // Detector clock unchanged: no duplicate status.
  expect(f.setData).not.toHaveBeenCalled();
  f.enable(false); expect(vi.getTimerCount()).toBe(0);
  f.enable(); expect(vi.getTimerCount()).toBe(1);
  f.cleanup(); expect(vi.getTimerCount()).toBe(0);
});
it('does not publish for disabled activity packets', () => {
  const f = fixture(); f.setData.mockClear();
  for (const name of ['PLAYERSHOOT', 'USEITEM', 'PLAYERTEXT', 'INVENTORYSWAP', 'MAPINFO', 'RECONNECT']) f.packet(name);
  vi.advanceTimersByTime(1000);
  expect(f.setData).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('publishes a pulse result immediately without waiting for the throttle', async () => {
  const f = fixture(); let resolve!: (result: PulseResult) => void;
  f.pulse.mockImplementation(() => new Promise(r => { resolve = r; }));
  f.enable(); f.start(); f.moves(300_200); f.setData.mockClear();
  resolve({ ok: true, minimized: false }); await Promise.resolve();
  expect(f.setData).toHaveBeenCalledTimes(1);
  expect(f.data.get('status')).toMatchObject({ pulses: 1, lastPulse: { result: 'sent' } });
});
it('registers off in the host and ignores disabled MOVEs', () => {
  const h = startHost([plugin], { input: null });
  try {
    expect(h.host.snapshot()[0]).toMatchObject({ enabled: false, failed: null });
  } finally { h.host.stop(); }
  const f = fixture(); f.start(); f.moves(360_000); expect(f.pulse).not.toHaveBeenCalled();
});
it('pulses once per consumed five-minute window and publishes status', async () => {
  const f = fixture(); f.enable(); f.start(); f.moves(300_000); expect(f.pulse).not.toHaveBeenCalled();
  f.moves(1000); await Promise.resolve(); expect(f.pulse).toHaveBeenCalledExactlyOnceWith(f.client);
  f.moves(300_000); await Promise.resolve(); expect(f.pulse).toHaveBeenCalledTimes(2);
  expect(f.data.get('status')).toMatchObject({ pulses: 2, lastPulse: { result: 'sent' } });
  expect(f.lines).toEqual(Array(2).fill('Inactive for 5 min; click sent.'));
});
it.each(['position', 'PLAYERSHOOT', 'USEITEM', 'PLAYERTEXT', 'INVENTORYSWAP', 'MAPINFO', 'RECONNECT', 'connect', 'gap'])('%s restarts inactivity', async activity => {
  const f = fixture(); f.enable(); f.start(); f.moves(240_000);
  let x = 1;
  if (activity === 'position') { x = 2; f.packet('MOVE', [{ x, y: 1 }]); }
  else if (activity === 'connect') { f.connect(); f.start(); }
  else if (activity === 'gap') f.gap(10_001);
  else { f.packet(activity); f.start(); }
  f.moves(60_000, x); expect(f.pulse).not.toHaveBeenCalled();
  f.moves(241_000, x); await Promise.resolve(); expect(f.pulse).toHaveBeenCalledTimes(1);
});
it('disable at 4:59 and re-enable both restart the window', () => {
  const f = fixture(); f.enable(); f.start(); f.moves(299_000); f.enable(false); f.moves(2000);
  expect(f.pulse).not.toHaveBeenCalled(); f.enable(); f.start(); f.moves(300_000);
  expect(f.pulse).not.toHaveBeenCalled(); f.moves(200); expect(f.pulse).toHaveBeenCalledTimes(1);
});
it.each(['disconnect', 'disable'])('finishes the matched click on %s and never starts another', async action => {
  const f = fixture(); let release!: () => void;
  const posts: number[] = [];
  const source: GameInputSource = { identify: () => null, findGameWindow: () => null,
    cursor: () => ({ x: 500, y: 500 }), post: (_h, m) => { posts.push(m); return true; } };
  f.pulse.mockImplementation(() => pulseGameWindow({ handle: {}, minimized: true,
    client: { left: 0, top: 0, right: 100, bottom: 100 } }, source,
  () => new Promise<void>(r => { release = r; })));
  f.enable(); f.start(); f.moves(300_200); expect(posts).toEqual([0x201]);
  if (action === 'disconnect') f.close(); else f.enable(false);
  release(); await Promise.resolve(); await Promise.resolve();
  expect(posts).toEqual([0x201, 0x202]);
  expect(f.data.get('status')).toMatchObject({ pulses: 1, lastPulse: { result: 'sent (minimized)' } });
  f.moves(600_000); expect(f.pulse).toHaveBeenCalledTimes(1);
});
it('logs each skip reason only once per session, including after success', async () => {
  const f = fixture(); f.enable(); f.start();
  for (const result of [{ ok: false, reason: 'cursor-over-game-ui' }, { ok: false, reason: 'no-window' },
    { ok: true, minimized: false }, { ok: false, reason: 'cursor-over-game-ui' }] as PulseResult[]) {
    f.pulse.mockResolvedValue(result); f.moves(300_200); await Promise.resolve();
  }
  expect(f.lines).toEqual(['Pulse skipped: cursor-over-game-ui.', 'Pulse skipped: no-window.', 'Inactive for 5 min; click sent.']);
  f.connect(); f.start(); f.moves(300_200); await Promise.resolve();
  expect(f.lines.at(-1)).toBe('Pulse skipped: cursor-over-game-ui.');
});
it('cleanup prevents further work', () => {
  const f = fixture(); f.enable(); f.start(); f.cleanup(); f.moves(360_000); expect(f.pulse).not.toHaveBeenCalled();
});
it('detector uses final finite position, resets invalid input, and keeps clients separate', () => {
  let now = 0; const d = new InactivityDetector(() => now);
  const a = { connected: true } as ClientConnection, b = { connected: true } as ClientConnection;
  const records = [{ x: 9, y: 9 }, { x: 1, y: 2 }, { x: NaN, y: 2 }];
  expect(d.observeMove(a, records, 1000)).toBe(false); now = 1001;
  expect(d.observeMove(a, records, 1000)).toBe(true); expect(d.observeMove(b, records, 1000)).toBe(false);
  expect(d.observeMove(a, [], 1000)).toBe(false); expect(d.idleMs(a)).toBeNull();
  d.clear(); expect(d.idleMs(b)).toBeNull();
});
it('validates the sole setting and registers last', () => {
  expect([0, 99, 4.7].map(v => validate('idleMinutes', v))).toEqual([1, 15, 4]);
  for (const v of ['5', null, NaN, Infinity, {}]) expect(() => validate('idleMinutes', v)).toThrow(TypeError);
  expect(() => validate('method', 5)).toThrow('Invalid Anti-AFK method');
  expect(BUILTIN_PLUGINS).toHaveLength(7); expect(BUILTIN_PLUGINS.at(-1)?.id).toBe('anti-afk');
});
