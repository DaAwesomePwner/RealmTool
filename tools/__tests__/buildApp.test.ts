import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findInstaller } from '../build-app.ts';

describe('NSIS installer discovery', () => {
  let temp: string;
  let root: string;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'realmtool-installer-'));
    root = join(temp, 'project');
    vi.stubEnv('CARGO_TARGET_DIR', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });

  function installer(target: string): string {
    const dir = join(target, 'release/bundle/nsis');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'unrelated.exe'), 'fixture');
    const file = join(dir, 'RealmTool_0.1.0_x64-setup.exe');
    writeFileSync(file, 'fixture');
    return file;
  }

  it('uses src-tauri/target when CARGO_TARGET_DIR is unset', () => {
    const file = installer(join(root, 'src-tauri/target'));
    expect(findInstaller(root)).toBe(file);
  });

  it('uses an absolute CARGO_TARGET_DIR instead of the default target', () => {
    installer(join(root, 'src-tauri/target'));
    const target = join(temp, 'cache with spaces', 'target', 'build');
    const file = installer(target);
    vi.stubEnv('CARGO_TARGET_DIR', target);
    expect(findInstaller(root)).toBe(file);
  });

  it.each(['cache/target', '../cache/target'])('resolves %s from src-tauri, where Tauri runs Cargo', target => {
    vi.stubEnv('CARGO_TARGET_DIR', target);
    const file = installer(resolve(root, 'src-tauri', target));
    expect(findInstaller(root)).toBe(file);
  });
});
