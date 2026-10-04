// Server list logic ported from realm-engine-client client/src/services/ServerSwitchService.ts and
// ServerListFetcher.ts @ 88a66b2 (MIT, see NOTICE). The display-sync (DLL) path is intentionally omitted.
import { isIPv4 } from 'node:net';
import { log } from '../../src/util/log.ts';

export const SERVER_LIST_URL = 'https://www.realmofthemadgod.com/account/servers';
const NAME = /^[a-z][a-z\d]{0,63}$/i;
const SUCCESS_REFRESH_MS = 15 * 60_000;
const FAILURE_RETRY_MS = 60_000;

// Only locally constructed API failures have messages safe to log.
class ServerListApiError extends Error {}

export interface ServerEntry { name: string; address: string }
export type Resolution = { ok: true; name: string; address: string } | { ok: false; message: string };

const valid = (name: unknown, address: unknown): boolean =>
  typeof name === 'string' && typeof address === 'string' && NAME.test(name) && isIPv4(address);

export function parseServerList(xml: string): ServerEntry[] {
  const servers: ServerEntry[] = [];
  for (const block of xml.match(/<Server>[\s\S]*?<\/Server>/g) ?? []) {
    if (/<AdminOnly\s*\/>|<AdminOnly>/.test(block)) continue;
    const name = /<Name>([^<]*)<\/Name>/.exec(block)?.[1];
    const address = /<DNS>([^<]*)<\/DNS>/.exec(block)?.[1];
    if (valid(name, address)) servers.push({ name: name!, address: address! });
  }
  return servers;
}

export function fallbackServers(json: Record<string, unknown>): ServerEntry[] {
  return Object.entries(json).filter(([name, address]) => valid(name, address)).map(([name, address]) => ({ name, address: address as string }));
}

/** Upper-case letters and digits of a server name, lower-cased: USWest → usw, USEast2 → use2. */
export function abbreviation(name: string): string {
  return name.replace(/[^A-Z\d]/g, '').toLowerCase();
}

const ambiguous = (matches: readonly ServerEntry[]): Resolution =>
  ({ ok: false, message: `Ambiguous server: ${matches.map(s => s.name).join(', ')}. Use the full name.` });

export function resolveServer(query: string, servers: readonly ServerEntry[]): Resolution {
  const text = query.trim();
  if (!text) return { ok: false, message: 'Use a server name, abbreviation, or IPv4 address.' };
  if (isIPv4(text)) return { ok: true, name: text, address: text };
  const lower = text.toLowerCase();
  const exact = servers.find(s => s.name.toLowerCase() === lower);
  if (exact) return { ok: true, ...exact };
  for (const matches of [servers.filter(s => abbreviation(s.name) === lower), servers.filter(s => s.name.toLowerCase().startsWith(lower))]) {
    if (matches.length === 1) return { ok: true, ...matches[0] };
    if (matches.length > 1) return ambiguous(matches);
  }
  return { ok: false, message: 'Unknown server or invalid IPv4 address. Use /con to list servers.' };
}

export interface DirectoryOptions {
  fallback: readonly ServerEntry[];
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** In-memory server list. The access token is only ever a parameter: it is never stored or logged. */
export class ServerDirectory {
  private servers: ServerEntry[];
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: DirectoryOptions) {
    this.servers = [...options.fallback];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  list(): readonly ServerEntry[] {
    return this.servers;
  }

  refresh(accessToken: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!accessToken || this.now() < this.nextRefreshAt) return Promise.resolve();
    this.inFlight = this.load(accessToken).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async load(accessToken: string): Promise<void> {
    try {
      const query = new URLSearchParams({ accessToken, game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' });
      const response = await this.fetchImpl(`${SERVER_LIST_URL}?${query}`, {
        headers: {
          'User-Agent': 'UnityPlayer/2021.3.31f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
          'X-Unity-Version': '2021.3.31f1',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new ServerListApiError(`Server list API returned ${response.status}`);
      const servers = parseServerList(await response.text());
      if (servers.length === 0) throw new ServerListApiError('Server list API returned no servers');
      this.servers = servers;
      this.nextRefreshAt = this.now() + SUCCESS_REFRESH_MS;
      log.info('Server Switch', `Loaded ${servers.length} servers`);
    } catch (error) {
      this.nextRefreshAt = this.now() + FAILURE_RETRY_MS;
      // Fetch errors can include the request URL and encoded access token.
      const message = error instanceof ServerListApiError ? error.message
        : error instanceof Error
          ? error.name === 'TimeoutError' || error.name === 'AbortError' ? 'request timed out' : error.constructor.name
          : 'unknown error';
      log.warn('Server Switch', `Server list refresh failed (${message}); using the last known list`);
    }
  }
}
