import { readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { appDataDir, writeJsonAtomic } from './store.ts';
import { listProfiles, validProfileName } from './profiles.ts';
import { log } from '../util/log.ts';

export interface AppConfig { schemaVersion: 1; gameDir: string | null; helperDirs: string[]; launcher: string | null; activeProfile: string }

const defaults = (): AppConfig => ({ schemaVersion: 1, gameDir: null, helperDirs: [], launcher: null, activeProfile: 'default' });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function resolveHelperDir(dir: unknown): string {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('Invalid helperDirs');
  return resolve(dir);
}

function validate(value: Record<string, unknown>): AppConfig {
  const result = defaults();
  for (const key of ['gameDir', 'launcher'] as const) {
    if (key in value) {
      if (value[key] !== null && typeof value[key] !== 'string') throw new Error(`Invalid ${key}`);
      result[key] = value[key];
    }
  }
  if ('helperDirs' in value) {
    if (!Array.isArray(value.helperDirs) || value.helperDirs.length > 16) throw new Error('Invalid helperDirs');
    const seen = new Set<string>();
    for (const dir of value.helperDirs) {
      const path = resolveHelperDir(dir), key = path.toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.helperDirs.push(path); }
    }
  }
  if ('activeProfile' in value) {
    if (typeof value.activeProfile !== 'string' || !validProfileName(value.activeProfile)) {
      throw new Error('Invalid activeProfile');
    }
    result.activeProfile = value.activeProfile;
  }
  return result;
}

export class AppConfigStore {
  readonly dir: string;
  private readonly path: string;
  private config = defaults();
  private savingDisabled = false;

  constructor(dir: string = appDataDir()) {
    this.dir = dir;
    this.path = join(dir, 'config.json');
    const config = this.read();
    if (config) this.config = this.resolveActive(config);
  }

  private read(): AppConfig | null {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.savingDisabled = true;
        log.warn('Config', `Could not read ${this.path}; keeping current settings and not saving this session`);
      }
      return null;
    }
    try {
      const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isRecord(value)) throw new Error('Config is not an object');
      if ('schemaVersion' in value && value.schemaVersion !== 1) {
        this.savingDisabled = true;
        log.warn('Config', `Unknown schemaVersion in ${this.path}; keeping current settings and not saving this session`);
        return null;
      }
      return validate(value);
    } catch {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, backup); }
      catch {
        this.savingDisabled = true;
        log.warn('Config', `Corrupt ${this.path} could not be backed up; keeping current settings and not saving this session`);
        return null;
      }
      log.warn('Config', `Corrupt ${this.path}; kept it as ${backup} and kept current settings`);
      return null;
    }
  }

  get(): AppConfig { return { ...this.config, helperDirs: [...this.config.helperDirs] }; }

  update(patch: Partial<Omit<AppConfig, 'schemaVersion'>>): AppConfig {
    if (!isRecord(patch)) throw new Error('Invalid config update');
    return this.save(config => ({ ...config, ...patch }));
  }

  addHelperDir(dir: string): AppConfig {
    const target = resolveHelperDir(dir);
    return this.save(config => ({
      ...config, gameDir: config.gameDir ?? target,
      helperDirs: config.helperDirs.some(saved => saved.toLowerCase() === target.toLowerCase())
        ? config.helperDirs : [...config.helperDirs, target],
    }));
  }

  removeHelperDirs(dirs: string[]): AppConfig {
    if (!Array.isArray(dirs)) throw new Error('Invalid helperDirs');
    const removed = new Set(dirs.map(dir => resolveHelperDir(dir).toLowerCase()));
    return this.save(config => ({
      ...config, helperDirs: config.helperDirs.filter(dir => !removed.has(dir.toLowerCase())),
    }));
  }

  private save(change: (config: AppConfig) => Record<string, unknown>): AppConfig {
    if (this.savingDisabled) throw new Error('App config saving is disabled for this session');
    // Re-read immediately before changing and atomically writing the file. Without
    // cross-process locking, another writer can still race this read/write window.
    const latest = this.read() ?? this.config;
    if (this.savingDisabled) throw new Error('App config saving is disabled for this session');
    const next = this.resolveActive(validate(change(latest)));
    writeJsonAtomic(this.path, next);
    this.config = next;
    return this.get();
  }

  private resolveActive(config: AppConfig): AppConfig {
    const name = listProfiles(this.dir).find(name => name.toLowerCase() === config.activeProfile.toLowerCase());
    if (name) return { ...config, activeProfile: name };
    log.warn('Config', `Active profile ${config.activeProfile} is missing; using default`);
    return { ...config, activeProfile: 'default' };
  }
}
