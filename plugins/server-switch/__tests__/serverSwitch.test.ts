import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHost, textData, type Harness } from '../../../src/testing/pluginHarness.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';
import { ServerDirectory } from '../directory.ts';
import serverSwitch, { createServerSwitch } from '../index.ts';
import { BUILTIN_PLUGINS } from '../../index.ts';

const fallback = [{ name: 'USWest', address: '1.2.3.4' }, { name: 'Australia', address: '2.3.4.5' }];
let h: Harness;
let directory: ServerDirectory;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let id: string;
const records: LogRecord[] = [];
let removeSink: () => void;
beforeEach(() => {
  log.setConsole(false);
  removeSink = log.addSink(record => records.push(record));
  fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('<Server><Name>USWest</Name><DNS>1.2.3.4</DNS></Server>'));
  directory = new ServerDirectory({ fallback, fetch });
  h = startHost([createServerSwitch(directory)]);
  id = h.connect();
});
afterEach(() => {
  h.host.stop();
  expect(records.filter(record => record.level === 'error' || record.level === 'warn')).toEqual([]);
  removeSink();
  records.length = 0;
  log.setConsole(true);
  vi.restoreAllMocks();
});
const command = (text: string) => h.packet(id, 'PLAYERTEXT', { text });
const packets = () => h.proxy.injected.map(packet => h.factory.createFromBytes(packet.data, 'server'));
function expectNotification(sender: string, message: string) {
  expect(h.proxy.injected).toHaveLength(1);
  expect(h.proxy.injected[0]).toMatchObject({ id, toClient: true });
  expect(packets()[0].name).toBe('TEXT');
  expect(packets()[0].data).toEqual(textData({ name: sender, objectId: -1, numStars: -1, text: message, cleanText: message }));
}
function expectReconnect(sender: string, message: string, name: string, host: string, port: number) {
  expect(h.proxy.injected).toHaveLength(2);
  expect(h.proxy.injected.map(packet => [packet.id, packet.toClient])).toEqual([[id, true], [id, true]]);
  const [notification, reconnect] = packets();
  expect(notification.name).toBe('TEXT');
  expect(notification.data).toEqual(textData({ name: sender, objectId: -1, numStars: -1, text: message, cleanText: message }));
  expect(reconnect.name).toBe('RECONNECT');
  expect(reconnect.data).toEqual({ name, host, port, gameId: -2, keyTime: -1, key: Buffer.alloc(0) });
}

describe('Server Switch commands', () => {
  it('registers the default plugin as a built-in with the required capabilities', () => {
    expect(serverSwitch).toMatchObject({ id: 'server-switch', name: 'Server Switch', apiVersion: 1, capabilities: ['packets', 'commands', 'notifications', 'inject'] });
    expect(BUILTIN_PLUGINS).toContain(serverSwitch);
  });
  it('consumes /con usw and injects notification followed by the real reconnect target', () => {
    expect(command('/con usw')?.data).toBeNull();
    expectReconnect('Server Switch', 'Connecting to USWest...', 'USWest', '1.2.3.4', 2050);
  });
  it.each(['/con', '/con a b'])('lists servers for %s', text => {
    expect(command(text)?.data).toBeNull();
    expectNotification('Server Switch', 'Use /con <name, abbreviation, or IPv4>, e.g. /con USEast or /con USE. Servers: USWest, Australia');
  });
  it('rejects unknown servers without injecting RECONNECT', () => {
    expect(command('/con nowhere')?.data).toBeNull();
    expectNotification('Server Switch', 'Unknown server or invalid IPv4 address. Use /con to list servers.');
  });
  it.each([['/goto 1.2.3.4', 2050], ['/goto 1.2.3.4:2051', 2051]] as const)('connects with %s', (text, port) => {
    expect(command(text)?.data).toBeNull();
    expectReconnect('IP Connect', `Connecting to 1.2.3.4:${port}...`, `1.2.3.4:${port}`, '1.2.3.4', port);
  });
  it.each(['0', '99999', '-1', '2051garbage', ''])('rejects invalid port "%s"', port => {
    expect(command(`/goto 1.2.3.4:${port}`)?.data).toBeNull();
    expectNotification('IP Connect', `Invalid port: ${port}`);
  });
  it('rejects invalid IPv4 octets', () => {
    expect(command('/goto 999.1.1.1')?.data).toBeNull();
    expectNotification('IP Connect', 'Invalid IP: 999.1.1.1');
  });
  it.each(['/goto', '/goto a b', '/goto 1.2.3.4:2050:2051'])('shows usage for %s', text => {
    expect(command(text)?.data).toBeNull();
    expectNotification('IP Connect', 'Usage: /goto {ip} or /goto {ip}:{port}');
  });
  it('reports no established server before routing', () => {
    expect(command('/ip')?.data).toBeNull();
    expectNotification('Server Switch', 'No established server connection.');
  });
  it('reports the actual routed host and port', () => {
    h.route(id, '5.6.7.8');
    expect(command('/ip')?.data).toBeNull();
    expectNotification('Server Switch', 'Connected to 5.6.7.8:2050');
  });
  it('refreshes exactly once for an observed HELLO with an access token', async () => {
    const refresh = vi.spyOn(directory, 'refresh');
    expect(h.proxy.interest.observe?.client).toContain('HELLO');
    h.packet(id, 'HELLO', { gameId: -2, buildVersion: 'b', accessToken: 'test-token', keyTime: -1, key: Buffer.alloc(0), gameNet: '', playPlatform: '', platformToken: '', userToken: '', clientIdentification: '' }, { observeOnly: true });
    expect(refresh).toHaveBeenCalledExactlyOnceWith('test-token');
    await refresh.mock.results[0].value;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.proxy.forwards).toHaveLength(0);
    expect(h.proxy.injected).toHaveLength(0);
  });
  it('passes /con through while disabled', () => {
    h.host.context('server-switch')!.enabled = false;
    const verdict = command('/con usw');
    expect(verdict).toBeDefined();
    expect(verdict!.data).not.toBeNull();
    expect(h.factory.createFromBytes(verdict!.data!, 'client').data.text).toBe('/con usw');
    expect(h.proxy.injected).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
