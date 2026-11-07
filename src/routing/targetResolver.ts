import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GAME_PORT } from '../protocol/constants.ts';
import { log } from '../util/log.ts';
import type { Destination } from './router.ts';
import { readTcpProcessIdentity, type ProcessIdentity } from './tcpProcessIdentity.ts';

/** The helper writes %TEMP%\realmtool_target_<pid>.txt just before redirecting a connect. */
export const TARGET_FILE_PREFIX = 'realmtool_target_';

export function targetFilePath(pid: number, dir: string = tmpdir()): string {
  return join(dir, `${TARGET_FILE_PREFIX}${pid}.txt`);
}

export function parseTargetFile(text: string): string | null {
  const ip = text.trim();
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  if (!parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return null;
  if (parts[0] === '127') return null;
  return ip;
}

export interface TargetResolverOptions {
  tempDir?: string;
  proxyPort?: number;
  identify?: (remotePort: number) => ProcessIdentity | null;
}

/** Maps a new loopback game socket to the server the game originally tried to reach. */
export function createTargetResolver(options: TargetResolverOptions = {}): (remotePort: number) => Destination | null {
  // GetTempPathW prefers TMP over TEMP; Node's Windows tmpdir() does the reverse.
  const candidates = options.tempDir !== undefined
    ? [options.tempDir]
    : [tmpdir(), process.env.TMP, process.env.TEMP, process.env.USERPROFILE];
  const dirs = [...new Set(candidates
    .filter((dir): dir is string => Boolean(dir))
    .map(dir => resolve(dir)))];
  const proxyPort = options.proxyPort ?? GAME_PORT;
  const identify = options.identify ?? ((remotePort: number) => readTcpProcessIdentity(remotePort, proxyPort));
  return remotePort => {
    const identity = identify(remotePort);
    if (!identity) return null;
    for (const dir of dirs) {
      const path = targetFilePath(identity.pid, dir);
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      try { unlinkSync(path); } catch (error) {
        log.warn('Routing', `Failed to remove target file ${path}: ${(error as Error).message}`);
      }
      const host = parseTargetFile(text);
      return host ? { host, port: GAME_PORT } : null;
    }
    return null;
  };
}

export function removeStaleTargetFiles(dir: string = tmpdir()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/^realmtool_target_\d+\.txt$/.test(name)) continue;
    try { unlinkSync(join(dir, name)); removed++; } catch { /* in use or already gone */ }
  }
  return removed;
}
