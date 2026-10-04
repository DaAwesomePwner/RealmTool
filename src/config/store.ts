import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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
  const temp = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    fd = openSync(temp, 'w');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written === 0) throw new Error('Could not make progress writing profile');
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeProfile(value: unknown): Profile {
  if (!isRecord(value)) throw new Error('profile is not an object');
  if ('schemaVersion' in value && value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error('profile.schemaVersion is unsupported');
  }
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

export interface ProfileFs {
  readFile(path: string): string;
  rename(from: string, to: string): void;
  writeJson(path: string, value: unknown): void;
}

const defaultProfileFs: ProfileFs = {
  readFile: path => readFileSync(path, 'utf8'),
  rename: renameSync,
  writeJson: writeJsonAtomic,
};

const errorDetail = (error: unknown): string =>
  (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

export interface ProfileStoreOptions {
  dir: string;
  name?: string;
  debounceMs?: number;
  fs?: ProfileFs;
}

export class ProfileStore {
  readonly path: string;
  private readonly debounceMs: number;
  private readonly fs: ProfileFs;
  private savingDisabledForSession = false;
  private pending: Profile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProfileStoreOptions) {
    this.path = join(options.dir, 'profiles', `${options.name ?? 'default'}.json`);
    this.debounceMs = options.debounceMs ?? 800;
    this.fs = options.fs ?? defaultProfileFs;
  }

  get savingDisabled(): boolean {
    return this.savingDisabledForSession;
  }

  load(): Profile {
    let text: string;
    try {
      text = this.fs.readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyProfile();
      this.savingDisabledForSession = true;
      log.warn('Config', `Could not read ${this.path} (${errorDetail(error)}); using defaults and not saving settings this session so the file is left untouched`);
      return emptyProfile();
    }
    try {
      const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (isRecord(value) && typeof value.schemaVersion === 'number'
        && Number.isInteger(value.schemaVersion) && value.schemaVersion > PROFILE_SCHEMA_VERSION) {
        this.savingDisabledForSession = true;
        log.warn('Config', `Profile ${this.path} was written by a newer RealmTool (schema ${value.schemaVersion}); using defaults and not saving settings this session so the file is left untouched`);
        return emptyProfile();
      }
      return normalizeProfile(value);
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try {
        this.fs.rename(this.path, backup);
      } catch (backupError) {
        this.savingDisabledForSession = true;
        log.warn('Config', `Profile ${this.path} is unreadable (${errorDetail(error)}) and could not be backed up (${errorDetail(backupError)}); using defaults and not saving settings this session so the file is left untouched`);
        return emptyProfile();
      }
      log.warn('Config', `Profile ${this.path} is unreadable (${(error as Error).message}); kept it as ${backup} and started from defaults`);
      return emptyProfile();
    }
  }

  scheduleSave(profile: Profile): void {
    if (this.savingDisabled) return;
    this.pending = profile;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.savingDisabled) return;
    const profile = this.pending;
    if (!profile) return;
    try {
      this.fs.writeJson(this.path, profile);
      this.pending = null;
    } catch (error) {
      log.error('Config', `Could not save ${this.path}`, error);
    }
  }
}
