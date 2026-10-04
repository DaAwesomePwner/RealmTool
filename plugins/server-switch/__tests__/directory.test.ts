import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log, type LogRecord } from '../../../src/util/log.ts';
import { abbreviation, fallbackServers, parseServerList, resolveServer, SERVER_LIST_URL, ServerDirectory } from '../directory.ts';

const fallback = [{ name: 'USWest', address: '1.2.3.4' }];
const refreshed = [{ name: 'USEast2', address: '5.6.7.8' }];
const xml = '<Servers><Server><Name>USEast2</Name><DNS>5.6.7.8</DNS></Server></Servers>';
const records: LogRecord[] = [];
let removeSink: () => void;
beforeEach(() => {
  log.setConsole(false);
  removeSink = log.addSink(record => records.push(record));
});
afterEach(() => {
  removeSink();
  records.length = 0;
  log.setConsole(true);
  vi.restoreAllMocks();
});

describe('server directory parsing and resolution', () => {
  it('keeps valid public servers and skips admin, invalid, and incomplete blocks', () => {
    const block = (name: string, address: string, extra = '') => `<Server><Name>${name}</Name><DNS>${address}</DNS>${extra}</Server>`;
    expect(parseServerList(`<Servers>${[
      block('USWest', '1.2.3.4'),
      block('AdminA', '1.2.3.4', '<AdminOnly/>'),
      block('AdminB', '1.2.3.4', '<AdminOnly>true</AdminOnly>'),
      block('AdminC', '1.2.3.4', '<AdminOnly />'),
      block('9Bad', '1.2.3.4'), block('Has Space', '1.2.3.4'),
      block('Hostname', 'host.example'), block('Short', '1.2.3'),
      block('BadOctet', '999.1.1.1'), block('A'.repeat(65), '1.2.3.4'),
      '<Server><Name>NoDNS</Name></Server>', '<Server><DNS>1.2.3.4</DNS></Server>',
    ].join('')}</Servers>`)).toEqual(fallback);
    expect(parseServerList('')).toEqual([]);
  });

  it('validates fallback names and addresses', () => {
    expect(fallbackServers({ USWest: '1.2.3.4', '9Bad': '1.2.3.4', 'Has Space': '1.2.3.4', Host: 'host.example', Short: '1.2.3', Null: null, Number: 123 })).toEqual(fallback);
  });

  it.each([['USWest', 'usw'], ['USEast2', 'use2'], ['EUSouthWest', 'eusw']])('abbreviates %s to %s', (name, expected) => {
    expect(abbreviation(name)).toBe(expected);
  });

  const servers = [...fallback, { name: 'Australia', address: '2.3.4.5' }, { name: 'USSouth', address: '3.4.5.6' }, { name: 'USSouth3', address: '4.5.6.7' }];
  it.each([
    ['1.2.3.4', '1.2.3.4', '1.2.3.4'],
    [' uSwEsT ', 'USWest', '1.2.3.4'],
    ['usw', 'USWest', '1.2.3.4'],
    ['austr', 'Australia', '2.3.4.5'],
  ])('resolves %s', (query, name, address) => {
    expect(resolveServer(query, servers)).toEqual({ ok: true, name, address });
  });
  it.each([
    ['  ', 'Use a server name, abbreviation, or IPv4 address.'],
    ['ussou', 'Ambiguous server: USSouth, USSouth3. Use the full name.'],
    ['nowhere', 'Unknown server or invalid IPv4 address. Use /con to list servers.'],
    ['999.1.1.1', 'Unknown server or invalid IPv4 address. Use /con to list servers.'],
  ])('rejects %s with the exact message', (query, message) => {
    expect(resolveServer(query, servers)).toEqual({ ok: false, message });
  });
  it('rejects ambiguous abbreviations', () => {
    expect(resolveServer('usw', [...fallback, { name: 'USWinter', address: '2.3.4.5' }])).toEqual({ ok: false, message: 'Ambiguous server: USWest, USWinter. Use the full name.' });
  });
});

describe('ServerDirectory.refresh', () => {
  it('GETs the official endpoint with exact query and headers, then replaces the fallback', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(xml));
    const directory = new ServerDirectory({ fallback, fetch });
    expect(directory.list()).toEqual(fallback);
    await directory.refresh('token +&');
    expect(SERVER_LIST_URL).toBe('https://www.realmofthemadgod.com/account/servers');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${SERVER_LIST_URL}?accessToken=token+%2B%26&game_net=Unity&play_platform=Unity&game_net_user_id=`);
    expect(options?.method ?? 'GET').toBe('GET');
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toEqual({
      'User-Agent': 'UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
      'X-Unity-Version': '2021.3.31f1',
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(directory.list()).toEqual(refreshed);
    expect(records).toEqual([expect.objectContaining({ level: 'info', message: 'Loaded 1 servers' })]);
  });

  it('deduplicates in-flight calls', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const directory = new ServerDirectory({ fallback, fetch });
    const first = directory.refresh('first');
    const second = directory.refresh('second');
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(new Response(xml));
    await Promise.all([first, second]);
    expect(directory.list()).toEqual(refreshed);
  });

  it('skips refreshes for exactly 15 minutes after success', async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(xml));
    const directory = new ServerDirectory({ fallback, fetch, now: () => now });
    await directory.refresh('token');
    now = 15 * 60_000 - 1;
    await directory.refresh('token');
    expect(fetch).toHaveBeenCalledTimes(1);
    now++;
    await directory.refresh('token');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['non-OK response', () => Promise.resolve(new Response('', { status: 503 })), 'Server list API returned 503'],
    ['thrown error', () => Promise.reject(new Error('offline')), 'offline'],
    ['empty parse', () => Promise.resolve(new Response('<Servers/>')), 'Server list API returned no servers'],
  ] as const)('retains the last successful list on %s and retries after 60 seconds', async (_label, fail, message) => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(xml)).mockImplementation(fail);
    const directory = new ServerDirectory({ fallback, fetch, now: () => now });
    await directory.refresh('token');
    now = 15 * 60_000;
    await directory.refresh('token');
    expect(directory.list()).toEqual(refreshed);
    expect(records.at(-1)).toMatchObject({ level: 'warn', message: `Server list refresh failed (${message}); using the last known list` });
    now += 60_000 - 1;
    await directory.refresh('token');
    expect(fetch).toHaveBeenCalledTimes(2);
    now++;
    await directory.refresh('token');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(directory.list()).toEqual(refreshed);
  });

  it('redacts every occurrence of the token in fetch errors and keeps fallback data', async () => {
    const token = 'secret-access-token';
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`failed ${token} again ${token}`));
    const directory = new ServerDirectory({ fallback, fetch });
    await directory.refresh(token);
    expect(directory.list()).toEqual(fallback);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: 'warn', message: 'Server list refresh failed (failed <token> again <token>); using the last known list' });
    expect(JSON.stringify(records)).not.toContain(token);
  });

  it('does not fetch without an access token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await new ServerDirectory({ fallback, fetch }).refresh('');
    expect(fetch).not.toHaveBeenCalled();
  });
});
