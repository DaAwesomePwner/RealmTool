import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import plugin from '../index.ts';
import type { ClientConnection, ConnectionEvent, PacketHook, PluginContext } from '../../../src/plugins/api.ts';
import { createPacket } from '../../../src/protocol/Packet.ts';
import { startHost, textData } from '../../../src/testing/pluginHarness.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';

function fixture() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const hooks = new Map<string, PacketHook>();
  const events = new Map<ConnectionEvent, (c: ClientConnection) => void>();
  const settings = new Map<string, unknown>();
  const data = new Map<string, unknown>();
  const lines: string[] = [];
  const ctx = {
    enabled: true, name: '', category: '',
    observePacket: (name: string, fn: PacketHook) => hooks.set(name, fn),
    on: (name: ConnectionEvent, fn: (c: ClientConnection) => void) => events.set(name, fn),
    registerSetting: (key: string, def: { value: unknown }) => settings.set(key, def.value),
    getSetting: (key: string) => settings.get(key),
    setData: (key: string, value: unknown) => data.set(key, value),
    log: (line: string) => lines.push(line),
    registerCleanup: vi.fn(), onEnabledChange: vi.fn(),
  } as unknown as PluginContext;
  plugin.register(ctx);
  const client = { clientId: 'abcdefgh-extra' } as ClientConnection;
  events.get('clientConnected')!(client);
  function packet(name: string, fields: Record<string, unknown>, unread = Buffer.alloc(0), direction: 'client' | 'server' = 'server') {
    const p = createPacket(0, name, direction);
    p.data = fields; p.isDefined = true; p.unreadData = unread;
    const before = structuredClone(p);
    hooks.get(name)?.(client, p);
    expect(structuredClone(p)).toEqual(before);
  }
  return { ctx, data, lines, settings, packet, hooks,
    at: (time: number) => { now = time; },
    close: () => events.get('clientDisconnected')!(client),
  };
}
beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

it('logs each server message with a short session prefix and publishes status', () => {
  const f = fixture();
  expect(plugin.capabilities).toEqual(['packets']);
  expect(f.ctx.name).toBe('Server Messages');
  expect(f.ctx.category).toBe('utility');
  f.packet('FAILURE', { errorId: 5, errorMessage: 'Inactive' });
  f.packet('GLOBALNOTIFICATION', { notificationType: 2, text: 'Warning' });
  f.packet('NOTIFICATION', { typeValue: 1, textByte: 3 }, Buffer.from([0, 5, ...Buffer.from('hello'), 0, ...Buffer.from('world')]));
  expect(f.lines).toEqual(['[abcdefgh] FAILURE 5: Inactive', '[abcdefgh] GLOBALNOTIFICATION 2: Warning', '[abcdefgh] NOTIFICATION type 1/3: hello | world (13 bytes)']);
  expect(f.data.get('status')).toMatchObject({ messagesLogged: 3, lastMessage: f.lines[2] });
});

function notificationBytes(text: string) {
  const bytes = Buffer.alloc(Buffer.byteLength(text) + 10);
  bytes.writeUInt16BE(Buffer.byteLength(text), 4);
  bytes.write(text, 6);
  return bytes;
}

it('suppresses varying plus-symbol amounts without changing the last logged message', () => {
  const f = fixture();
  expect(f.data.get('status')).toMatchObject({ suppressed: 0 });
  f.packet('FAILURE', { errorId: 0, errorMessage: '' });
  for (const amount of [45, 123]) {
    f.packet('NOTIFICATION', { typeValue: 6, textByte: 26 }, notificationBytes(`{"k":"s.plus_symbol","t":{"amount":"${amount}",}}`));
  }
  expect(f.lines).toEqual(['[abcdefgh] FAILURE 0: ']);
  expect(f.data.get('status')).toEqual({ sessionId: 'abcdefgh', messagesLogged: 1, lastMessage: f.lines[0], suppressed: 2 });
  f.packet('PLAYERTEXT', {}, undefined, 'client');
  f.at(1000);
  f.close();
  expect(f.lines[1]).toBe('[abcdefgh] Session ended after 0m 1s; idle: moved never, shot never, used item never, chatted 0m 1s ago; suppressed 2 "+N" notifications');
  f.packet('NOTIFICATION', { typeValue: 6, textByte: 26 }, notificationBytes('{"k":"s.plus_symbol","t":{"amount":"1",}}'));
  expect(f.data.get('status')).toMatchObject({ messagesLogged: 0, lastMessage: '', suppressed: 1 });
});

it('preserves useful notifications and empty failures exactly', () => {
  const f = fixture();
  const notifications = [
    [6, 26, '{"k":"s.opened_by","t":{"player":"Sharkpuffs",}}'],
    [8, 10, '{"k":"s.dungeon_opened_by","t":{"player":"Sharkpuffs",}}'],
    [4, 34, 'This server will restart in 20 minutes, please exit the game accordingly'],
    [4, 34, 'giftChestOccupied'],
    [6, 26, '{"k":"s.plus_symbol_extra"}'],
    [6, 26, '{"message":"s.plus_symbol"}'],
  ] as const;
  for (const [typeValue, textByte, text] of notifications) {
    f.packet('NOTIFICATION', { typeValue, textByte }, notificationBytes(text));
  }
  f.packet('FAILURE', { errorId: 0, errorMessage: '' });
  expect(f.lines).toEqual([
    ...notifications.map(([typeValue, textByte, text]) => `[abcdefgh] NOTIFICATION type ${typeValue}/${textByte}: ${text} (${notificationBytes(text).length} bytes)`),
    '[abcdefgh] FAILURE 0: ',
  ]);
  expect(f.data.get('status')).toMatchObject({ messagesLogged: 7, suppressed: 0 });
});

it('logs system senders with any recipient but excludes recipient-bearing player traffic', () => {
  const f = fixture();
  for (const name of ['', '*Error*', 'Server']) f.packet('TEXT', { name, objectId: name === 'Server' ? -1 : 1, recipient: '', text: 'notice' });
  for (const recipient of ['', 'Me', '*guild*', '*party*']) f.packet('TEXT', { name: 'Player', objectId: 1, recipient, text: 'private' });
  for (const recipient of ['Me', '*Guild*', '*Party*']) f.packet('TEXT', { name: 'Player', objectId: -1, recipient, text: 'private' });
  for (const name of ['', '*Error*']) {
    for (const recipient of ['Me', '*Guild*', '*Party*']) f.packet('TEXT', { name, objectId: 1, recipient, text: 'notice' });
  }
  expect(f.lines).toEqual([
    '[abcdefgh] TEXT (system): notice', '[abcdefgh] TEXT *Error*: notice', '[abcdefgh] TEXT Server: notice',
    ...['(system)', '*Error*'].flatMap(name => ['Me', '*Guild*', '*Party*'].map(recipient => `[abcdefgh] TEXT ${name} → ${recipient}: notice`)),
  ]);
});

it('collapses line breaks and caps the entire log line', () => {
  const f = fixture();
  f.packet('FAILURE', { errorId: 1, errorMessage: 'one\r\ntwo\nthree' });
  expect(f.lines[0]).toBe('[abcdefgh] FAILURE 1: one two three');
  f.packet('TEXT', { name: '', text: 'x'.repeat(800) });
  expect(f.lines[1]).toHaveLength(500);
  expect(f.lines[1]).toMatch(/…$/);
});

it('extracts UTF-8 and length-prefixed strings including short strings without binary noise', () => {
  const f = fixture();
  const bytes = Buffer.concat([Buffer.from([0, 2]), Buffer.from('OK'), Buffer.from([0, 0xff]), Buffer.from('café'), Buffer.from([0])]);
  f.packet('NOTIFICATION', { typeValue: 0, textByte: 0 }, bytes);
  expect(f.lines[0]).toBe('[abcdefgh] NOTIFICATION type 0/0: OK | café (12 bytes)');
});

it('scans only the first 4096 notification bytes while reporting the full size', () => {
  const f = fixture();
  const bytes = Buffer.alloc(128 * 1024);
  bytes.writeUInt16BE(5, 0);
  bytes.write('hello', 2);
  bytes.write('outside scan', 4096);
  f.packet('NOTIFICATION', { typeValue: 0, textByte: 0 }, bytes);
  expect(f.lines).toEqual(['[abcdefgh] NOTIFICATION type 0/0: hello (131072 bytes)']);
});

it('tracks changed final MOVE positions and independent activity using monotonic time', () => {
  const f = fixture();
  const move = (x: number) => f.packet('MOVE', { records: [{ x: 999, y: 999 }, { x, y: 2 }] }, undefined, 'client');
  move(1); // First position establishes a baseline, not evidence of movement.
  f.at(10_000); move(2);
  f.at(20_000); f.packet('PLAYERSHOOT', {}, undefined, 'client');
  f.at(30_000); f.packet('USEITEM', {}, undefined, 'client');
  f.at(40_000); f.packet('PLAYERTEXT', { text: 'never log me' }, undefined, 'client');
  f.at(60_000); move(2);
  f.at(70_000); f.close();
  expect(f.lines).toEqual(['[abcdefgh] Session ended after 1m 10s; idle: moved 1m 0s ago, shot 0m 50s ago, used item 0m 40s ago, chatted 0m 30s ago']);
});

it('gates messages but always logs disconnect while enabled, with never for unseen activity', () => {
  const f = fixture();
  f.settings.set('logSystemMessages', false);
  f.packet('FAILURE', { errorId: 1, errorMessage: 'hidden' });
  f.at(65_000); f.close();
  expect(f.lines).toEqual(['[abcdefgh] Session ended after 1m 5s; idle: moved never, shot never, used item never, chatted never']);
  expect(f.hooks.has('HELLO')).toBe(false);
});

it('does not log while disabled or for packets in the wrong direction', () => {
  const f = fixture();
  f.packet('FAILURE', { errorId: 1, errorMessage: 'wrong direction' }, undefined, 'client');
  f.ctx.enabled = false;
  f.packet('FAILURE', { errorId: 1, errorMessage: 'disabled' });
  f.close();
  expect(f.lines).toEqual([]);
});

it('uses the real host logger, defaults enabled, isolates sessions and only observes traffic', () => {
  log.setConsole(false);
  const records: LogRecord[] = [];
  const removeSink = log.addSink(record => records.push(record));
  const h = startHost([plugin]);
  try {
    expect(h.host.context(plugin.id)!.enabled).toBe(true);
    const a = h.connect('aaaaaaaa-one');
    const b = h.connect('bbbbbbbb-two');
    h.packet(a, 'TEXT', textData({ name: '', text: 'System notice' }), { observeOnly: true });
    h.packet(b, 'FAILURE', { errorId: 5, errorMessage: 'Closed' }, { observeOnly: true });
    expect(h.host.data(plugin.id)!.get('status')).toMatchObject({ sessionId: 'bbbbbbbb', messagesLogged: 1 });
    const verdict = h.packet(a, 'TEXT', textData({ name: '*Help*', text: 'Help notice' }));
    expect(verdict!.data).not.toBeNull();
    expect(h.host.data(plugin.id)!.get('status')).toMatchObject({ sessionId: 'aaaaaaaa', messagesLogged: 2 });
    h.close(a); h.close(b);
    expect(records.filter(record => record.module === 'Server Messages').map(record => record.message)).toEqual([
      '[aaaaaaaa] TEXT (system): System notice', '[bbbbbbbb] FAILURE 5: Closed', '[aaaaaaaa] TEXT *Help*: Help notice',
      expect.stringContaining('[aaaaaaaa] Session ended after'), expect.stringContaining('[bbbbbbbb] Session ended after'),
    ]);
    expect(h.proxy.injected).toEqual([]);
    expect(records.filter(record => record.level === 'error')).toEqual([]);
  } finally {
    h.host.stop(); removeSink(); log.setConsole(true);
  }
});

it('decodes realm queue notifications', () => {
  const f = fixture();
  const queue = Buffer.alloc(6);
  queue.writeInt32BE(2, 0);
  queue.writeInt16BE(17, 4);
  f.packet('NOTIFICATION', { typeValue: 5, textByte: 40 }, queue);
  expect(f.lines).toEqual(['[abcdefgh] NOTIFICATION type 5/40: queue message 2, position 17 (6 bytes)']);
});
