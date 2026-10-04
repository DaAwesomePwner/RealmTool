import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { appDataDir, emptyProfile, writeJsonAtomic } from './store.ts';

/** 1–40 chars of [A-Za-z0-9 _-], no leading/trailing space, not a Windows reserved device name. */
export function validProfileName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(name)
    && name === name.trim() && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name);
}

function assertName(name: string): void {
  if (!validProfileName(name)) throw new Error('Invalid profile name');
}

export function listProfiles(dir: string = appDataDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5)).filter(validProfileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    names = [];
  }
  return ['default', ...names.filter(name => name.toLowerCase() !== 'default')].sort();
}

export function createProfile(name: string, from?: string, dir: string = appDataDir()): void {
  assertName(name);
  if (from !== undefined) assertName(from);
  const names = listProfiles(dir);
  if (names.some(existing => existing.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Profile already exists: ${name}`);
  }
  let value: unknown = emptyProfile();
  if (from !== undefined) {
    const source = names.find(existing => existing.toLowerCase() === from.toLowerCase());
    if (!source) throw new Error(`Profile does not exist: ${from}`);
    try {
      value = JSON.parse(readFileSync(join(dir, 'profiles', `${source}.json`), 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (source !== 'default' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  writeJsonAtomic(join(dir, 'profiles', `${name}.json`), value);
}

export function deleteProfile(name: string, active: string, dir: string = appDataDir()): void {
  assertName(name);
  assertName(active);
  if (name.toLowerCase() === 'default' || name.toLowerCase() === active.toLowerCase()) {
    throw new Error('Cannot delete the default or active profile');
  }
  const existing = listProfiles(dir).find(entry => entry.toLowerCase() === name.toLowerCase());
  if (!existing) throw new Error(`Profile does not exist: ${name}`);
  unlinkSync(join(dir, 'profiles', `${existing}.json`));
}
