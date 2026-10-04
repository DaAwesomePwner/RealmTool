import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../util/log.ts';

export const PROFILE_SCHEMA_VERSION = 1;

export interface PluginProfileEntry {
  enabled?: boolean;
  settings?: Record<string, unknown>;
}

export interface Profile {
  schemaVersion: number;
  plugins: Record<string, PluginProfileEntry>;
}

export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'RealmTool');
}

export function emptyProfile(): Profile {
  return { schemaVersion: PROFILE_SCHEMA_VERSION, plugins: {} };
}

/** Write via a temp file in the same folder, fsync, then rename over the target. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeProfile(value: unknown): Profile {
  if (!isRecord(value)) throw new Error('profile is not an object');
  const profile = emptyProfile();
  if (value.plugins === undefined) return profile;
  if (!isRecord(value.plugins)) throw new Error('profile.plugins is not an object');
  for (const [id, entry] of Object.entries(value.plugins)) {
    if (!isRecord(entry)) {
      log.warn('Config', `Ignoring invalid profile entry for ${id}`);
      continue;
    }
    const next: PluginProfileEntry = {};
    if (typeof entry.enabled === 'boolean') next.enabled = entry.enabled;
    if (isRecord(entry.settings)) next.settings = entry.settings;
    profile.plugins[id] = next;
  }
  return profile;
}

export interface ProfileStoreOptions {
  dir: string;
  name?: string;
  debounceMs?: number;
}

export class ProfileStore {
  readonly path: string;
  private readonly debounceMs: number;
  private pending: Profile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProfileStoreOptions) {
    this.path = join(options.dir, 'profiles', `${options.name ?? 'default'}.json`);
    this.debounceMs = options.debounceMs ?? 800;
  }

  load(): Profile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProfile();
      throw error;
    }
    try {
      return normalizeProfile(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, backup); } catch { /* keep going with defaults either way */ }
      log.warn('Config', `Profile ${this.path} is unreadable (${(error as Error).message}); kept it as ${backup} and started from defaults`);
      return emptyProfile();
    }
  }

  scheduleSave(profile: Profile): void {
    this.pending = profile;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const profile = this.pending;
    this.pending = null;
    if (!profile) return;
    try {
      writeJsonAtomic(this.path, profile);
    } catch (error) {
      log.error('Config', `Could not save ${this.path}`, error);
    }
  }
}
