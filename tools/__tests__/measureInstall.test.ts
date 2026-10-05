import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_BUDGET, inspectInstall, installationArgs, validateInstall, preflightInstall,
  cleanupInstallRegistration, type RegistrationKey } from '../measure-install.ts';

describe('measurement registration cleanup', () => {
  const key = 'HKCU\\Software\\realmtool\\RealmTool';
  const parent = 'HKCU\\Software\\realmtool';
  const dir = 'C:\\Temp\\measurement\\RealmTool';
  function registry(defaultValue?: string, extraValue = false, sibling = false) {
    const keys = new Map<string, RegistrationKey>();
    if (defaultValue !== undefined) {
      keys.set(key, { defaultValue, empty: false });
      keys.set(parent, { empty: false });
    }
    return {
      query: vi.fn((path: string) => keys.get(path) ?? null),
      delete: vi.fn((path: string, value?: '') => {
        if (value === '') keys.set(path, { empty: !extraValue });
        else {
          keys.delete(path);
          if (path === key) keys.set(parent, { empty: !sibling });
        }
      }),
    };
  }
  it('deletes the matching normalized default, then empty product and publisher keys', () => {
    const reg = registry('c:/TEMP/measurement/unused/../realmtool/');
    cleanupInstallRegistration(dir, reg);
    expect(reg.delete.mock.calls).toEqual([[key, ''], [key], [parent]]);
  });
  it('does not touch a registration pointing elsewhere', () => {
    const reg = registry('C:\\Users\\user\\RealmTool');
    cleanupInstallRegistration(dir, reg);
    expect(reg.delete).not.toHaveBeenCalled();
    expect(reg.query.mock.calls).toEqual([[key]]);
  });
  it('does nothing when the registration is missing', () => {
    const reg = registry();
    cleanupInstallRegistration(dir, reg);
    expect(reg.delete).not.toHaveBeenCalled();
  });
  it('preserves a product key with other values', () => {
    const reg = registry(dir, true);
    cleanupInstallRegistration(dir, reg);
    expect(reg.delete.mock.calls).toEqual([[key, '']]);
  });
  it('preserves a publisher key with another child', () => {
    const reg = registry(dir, false, true);
    cleanupInstallRegistration(dir, reg);
    expect(reg.delete.mock.calls).toEqual([[key, ''], [key]]);
  });
});

describe('clean-user installation preflight', () => {
  const home = join('C:', 'Users', 'real-user');
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RealmTool',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\net.realmtool.app',
    'HKCU\\Software\\realmtool\\RealmTool',
    'HKCU\\Software\\net.realmtool.app',
  ];
  const shortcuts = [
    join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'RealmTool.lnk'),
    join(home, 'Desktop', 'RealmTool.lnk'),
  ];
  it.each([...keys, ...shortcuts])('refuses before installation when %s exists', indicator => {
    const install = vi.fn();
    expect(() => {
      preflightInstall(home, { reg: key => key === indicator, exists: path => path === indicator });
      install();
    }).toThrow(/existing RealmTool installation/i);
    expect(install).not.toHaveBeenCalled();
  });
  it('proceeds only when all real-user indicators are absent', () => {
    const reg = vi.fn(() => false);
    const exists = vi.fn(() => false);
    expect(() => preflightInstall(home, { reg, exists })).not.toThrow();
    expect(reg.mock.calls).toEqual(keys.map(key => [key]));
    expect(exists.mock.calls).toEqual(shortcuts.map(path => [path]));
  });
});

describe('installed package gate', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  it('sums nested files and orders the top N by size', () => {
    root = mkdtempSync(join(tmpdir(), 'realmtool-size-'));
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'node.exe'), Buffer.alloc(30));
    writeFileSync(join(root, 'app', 'main.mjs'), Buffer.alloc(20));
    writeFileSync(join(root, 'uninstall.exe'), Buffer.alloc(10));
    expect(inspectInstall(root, 2)).toEqual({ total: 60, files: [
      { path: 'node.exe', size: 30 }, { path: 'app/main.mjs', size: 20 }, { path: 'uninstall.exe', size: 10 },
    ], top: [{ path: 'node.exe', size: 30 }, { path: 'app/main.mjs', size: 20 }] });
  });
  it('accepts the exact budget and rejects one byte over it', () => {
    expect(INSTALL_BUDGET).toBe(125_829_120);
    expect(validateInstall([{ path: 'node.exe', size: INSTALL_BUDGET }])).toEqual([]);
    expect(validateInstall([{ path: 'node.exe', size: INSTALL_BUDGET + 1 }])).toContain('Installed size exceeds 120 MiB');
  });
  it.each(['app/source.ts', 'app/types.d.ts', 'app/SOURCE.TS',
    'app/backend/node_modules/koffi/build/koffi/linux_x64/koffi.node',
    'app/backend/node_modules/koffi/build/koffi/win32_arm64/koffi.node',
    'app\\backend\\node_modules\\koffi\\build\\koffi\\darwin_x64\\koffi.node',
  ])('rejects forbidden file %s', path => {
    expect(validateInstall([{ path, size: 1 }])).not.toEqual([]);
  });
  it('allows only the win32_x64 Koffi binary and ordinary resources', () => {
    expect(validateInstall(['app/backend/node_modules/koffi/build/koffi/win32_x64/koffi.node',
      'app/backend/main.mjs', 'app/native/winhttp.dll'].map(path => ({ path, size: 10 })))).toEqual([]);
  });
  it('keeps the unquoted NSIS directory argument last, including spaces', () => {
    expect(installationArgs('C:\\Temp\\Realm Tool')).toEqual(['/S', '/D=C:\\Temp\\Realm Tool']);
  });
});
