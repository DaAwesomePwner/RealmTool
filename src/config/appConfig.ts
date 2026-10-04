import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir, writeJsonAtomic } from './store.ts';
import { listProfiles, validProfileName } from './profiles.ts';
import { log } from '../util/log.ts';

export interface AppConfig { schemaVersion: 1; gameDir: string | null; launcher: string | null; activeProfile: string }

const defaults = (): AppConfig => ({ schemaVersion: 1, gameDir: null, launcher: null, activeProfile: 'default' });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validate(value: Record<string, unknown>): AppConfig {
  const result = defaults();
  for (const key of ['gameDir', 'launcher'] as const) {
    if (key in value) {
      if (value[key] !== null && typeof value[key] !== 'string') throw new Error(`Invalid ${key}`);
      result[key] = value[key];
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
  private readonly dir: string;
  private readonly path: string;
  private config = defaults();
  private savingDisabled = false;

  constructor(dir: string = appDataDir()) {
    this.dir = dir;
    this.path = join(dir, 'config.json');
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.savingDisabled = true;
        log.warn('Config', `Could not read ${this.path}; using defaults and not saving this session`);
      }
      return;
    }
    try {
      const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isRecord(value)) throw new Error('Config is not an object');
      if ('schemaVersion' in value && value.schemaVersion !== 1) {
        this.savingDisabled = true;
        log.warn('Config', `Unknown schemaVersion in ${this.path}; using defaults and not saving this session`);
        return;
      }
      this.config = validate(value);
    } catch {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, backup); }
      catch {
        this.savingDisabled = true;
        log.warn('Config', `Corrupt ${this.path} could not be backed up; using defaults and not saving this session`);
        return;
      }
      log.warn('Config', `Corrupt ${this.path}; kept it as ${backup} and started from defaults`);
      return;
    }
    this.config = this.resolveActive(this.config);
  }

  get(): AppConfig { return { ...this.config }; }

  update(patch: Partial<Omit<AppConfig, 'schemaVersion'>>): AppConfig {
    if (this.savingDisabled) throw new Error('App config saving is disabled for this session');
    if (!isRecord(patch)) throw new Error('Invalid config update');
    const next = this.resolveActive(validate({ ...this.config, ...patch }));
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
