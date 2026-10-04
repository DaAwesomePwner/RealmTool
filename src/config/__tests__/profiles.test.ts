import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProfile, deleteProfile, listProfiles, validProfileName } from '../profiles.ts';
import { emptyProfile, ProfileStore, writeJsonAtomic } from '../store.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'realmtool-profiles-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it.each(['../x', 'CON', 'con', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT9', 'a/b', 'a\\b', '', 'x'.repeat(41), ' leading', 'trailing ', 'a.b'])('rejects unsafe name %j everywhere', name => {
  expect(validProfileName(name)).toBe(false);
  expect(() => new ProfileStore({ dir, name })).toThrow();
  expect(() => createProfile(name, undefined, dir)).toThrow();
  expect(() => createProfile('safe', name, dir)).toThrow();
  expect(() => deleteProfile(name, 'default', dir)).toThrow();
  expect(readdirSync(dir)).toEqual([]);
});

it.each(['My Profile_1', 'a', 'x'.repeat(40), 'a-b', 'COM10'])('accepts valid name %s', name => {
  expect(validProfileName(name)).toBe(true);
  expect(new ProfileStore({ dir, name }).path).toBe(join(dir, 'profiles', `${name}.json`));
});

it('lists sorted profiles including the implicit default, ignoring unrelated entries', () => {
  expect(listProfiles(dir)).toEqual(['default']);
  createProfile('zebra', undefined, dir);
  createProfile('alpha', undefined, dir);
  writeFileSync(join(dir, 'profiles', 'invalid!.json'), '{}');
  writeFileSync(join(dir, 'profiles', 'old.json.corrupt-1'), '{}');
  mkdirSync(join(dir, 'profiles', 'directory.json'));
  expect(listProfiles(dir)).toEqual(['alpha', 'default', 'zebra']);
});

it('creates empty profiles and independent copies without replacing existing profiles', () => {
  createProfile('empty', undefined, dir);
  expect(new ProfileStore({ dir, name: 'empty' }).load()).toEqual(emptyProfile());
  createProfile('copy-default', 'default', dir);
  expect(new ProfileStore({ dir, name: 'copy-default' }).load()).toEqual(emptyProfile());
  const profile = { schemaVersion: 1, plugins: { test: { enabled: true, settings: { value: 4 } } } };
  writeJsonAtomic(join(dir, 'profiles', 'source.json'), profile);
  createProfile('copy', 'source', dir);
  expect(new ProfileStore({ dir, name: 'copy' }).load()).toEqual(profile);
  expect(() => createProfile('copy', undefined, dir)).toThrow();
  expect(() => createProfile('COPY', undefined, dir)).toThrow();
  expect(() => createProfile('default', undefined, dir)).toThrow();
  expect(() => createProfile('missing-copy', 'missing', dir)).toThrow();
  deleteProfile('source', 'default', dir);
  expect(JSON.parse(readFileSync(join(dir, 'profiles', 'copy.json'), 'utf8'))).toEqual(profile);
});

it('protects default and active profiles, and rejects deletion of missing profiles', () => {
  createProfile('active', undefined, dir);
  expect(() => deleteProfile('default', 'active', dir)).toThrow();
  expect(() => deleteProfile('DEFAULT', 'active', dir)).toThrow();
  expect(() => deleteProfile('active', 'ACTIVE', dir)).toThrow();
  expect(() => deleteProfile('missing', 'active', dir)).toThrow();
  deleteProfile('active', 'default', dir);
  expect(listProfiles(dir)).toEqual(['default']);
});
