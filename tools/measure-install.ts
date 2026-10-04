// Installed-size gate for build machines or a clean Windows user account.
// NSIS changes real HKCU registration and shell shortcuts even with isolated
// APPDATA, so refuse to run when an existing installation is detected.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { findInstaller } from './build-app.ts';

export const INSTALL_BUDGET = 125_829_120;
export interface InstalledFile { path: string; size: number }

export interface RegistrationKey { defaultValue?: string; empty: boolean }
export interface Registration {
  query(key: string): RegistrationKey | null;
  /** An empty value name deletes only (Default); omitted means an empty key. */
  delete(key: string, value?: ''): void;
}

export function cleanupInstallRegistration(dir: string, reg: Registration): void {
  const key = 'HKCU\\Software\\realmtool\\RealmTool';
  const parent = 'HKCU\\Software\\realmtool';
  const saved = reg.query(key)?.defaultValue;
  const normalize = (path: string) => win32.normalize(path).replace(/\\+$/, '').toLowerCase();
  if (!saved || normalize(saved) !== normalize(dir)) return;
  reg.delete(key, '');
  if (reg.query(key)?.empty) reg.delete(key);
  if (reg.query(parent)?.empty) reg.delete(parent);
}

// Use .NET registry APIs rather than parsing localized reg.exe value labels.
// DeleteSubKey is nonrecursive, and key deletion rechecks both counts.
function registryCommand(key: string, operation: string): string {
  if (!['HKCU\\Software\\realmtool\\RealmTool', 'HKCU\\Software\\realmtool'].includes(key)) {
    throw new Error(`Unexpected measurement registry key: ${key}`);
  }
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$path = '${key.slice(5)}'
$root = [Microsoft.Win32.Registry]::CurrentUser
${operation}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Registry cleanup failed for ${key}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const systemRegistration: Registration = {
  query(key) {
    return JSON.parse(registryCommand(key, `
$entry = $root.OpenSubKey($path)
if ($null -eq $entry) { 'null'; exit }
try {
  $value = $entry.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  @{ defaultValue = $value; empty = ($entry.ValueCount -eq 0 -and $entry.SubKeyCount -eq 0) } | ConvertTo-Json -Compress
} finally { $entry.Dispose() }`)) as RegistrationKey | null;
  },
  delete(key, value) {
    registryCommand(key, `
$entry = $root.OpenSubKey($path, $true)
if ($null -eq $entry) { exit }
try {
  ${value === '' ? "$entry.DeleteValue('', $false)" : '$empty = ($entry.ValueCount -eq 0 -and $entry.SubKeyCount -eq 0)'}
} finally { $entry.Dispose() }
${value === '' ? '' : 'if ($empty) { $root.DeleteSubKey($path, $false) }'}`);
  },
};

export interface InstallPreflight {
  reg(key: string): boolean;
  exists(path: string): boolean;
}

export function preflightInstall(home: string, probe: InstallPreflight): void {
  // The installed CLI's embedded NSIS template defines UNINSTKEY using
  // PRODUCTNAME and MANUPRODUCTKEY as Software\MANUFACTURER\PRODUCTNAME.
  // With no configured publisher, Tauri uses identifier element 2: realmtool.
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
  const indicators = [...keys.filter(key => probe.reg(key)), ...shortcuts.filter(path => probe.exists(path))];
  if (indicators.length) {
    throw new Error(`Refusing to measure: existing RealmTool installation detected at ${indicators.join(', ')}. Use a build machine or a clean Windows user account.`);
  }
}

const systemPreflight: InstallPreflight = {
  reg(key) {
    const result = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    // Exit 1 also covers access errors. Only an explicit missing-key result is
    // safe; unrecognized/localized errors fail closed rather than permit install.
    if (result.status === 1 && /unable to find the specified registry key or value/i.test(result.stderr)) return false;
    throw new Error(`Could not check existing RealmTool registration: ${key} (${result.status ?? result.signal}). ${result.stderr.trim()}`);
  },
  exists: existsSync,
};

export function inspectInstall(root: string, topN = 10): { total: number; files: InstalledFile[]; top: InstalledFile[] } {
  const files: InstalledFile[] = [];
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const path = prefix + name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected installed link: ${path}`);
      if (stat.isDirectory()) walk(absolute, path + '/');
      else if (stat.isFile()) files.push({ path, size: stat.size });
    }
  }
  walk(root, '');
  files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  return { total: files.reduce((sum, file) => sum + file.size, 0), files, top: files.slice(0, topN) };
}

export function validateInstall(files: InstalledFile[]): string[] {
  const errors: string[] = [];
  if (files.reduce((sum, file) => sum + file.size, 0) > INSTALL_BUDGET) errors.push('Installed size exceeds 120 MiB');
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/').toLowerCase();
    if (path.endsWith('.ts')) errors.push(`TypeScript source installed: ${file.path}`);
    if (path.includes('/koffi/') && /\.(node|dll|so|dylib)$/.test(path)
      && !path.endsWith('/koffi/build/koffi/win32_x64/koffi.node')) {
      errors.push(`Non-win32_x64 Koffi binary installed: ${file.path}`);
    }
  }
  return errors;
}

export function installationArgs(dir: string): string[] { return ['/S', `/D=${dir}`]; }

export async function measureInstall(setup: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Installer measurement requires Windows');
  preflightInstall(homedir(), systemPreflight);
  const temp = mkdtempSync(join(tmpdir(), 'realmtool-install-'));
  const dir = join(temp, 'RealmTool');
  // Keep the uninstall hook away from the user's saved game directory.
  const env = { ...process.env, APPDATA: join(temp, 'appdata') };
  function run(exe: string, args: string[], verbatim = false): void {
    const result = spawnSync(exe, args, { env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: verbatim });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${exe} exited ${result.status ?? result.signal}`);
  }
  try {
    // NSIS consumes the entire unquoted remainder of its command line as /D.
    run(resolve(setup), installationArgs(dir), true);
    const report = inspectInstall(dir);
    console.log(`Installed: ${report.total} bytes (${(report.total / 1024 / 1024).toFixed(2)} MiB)`);
    for (const file of report.top) console.log(`${file.size}\t${file.path}`);
    const errors = validateInstall(report.files);
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    if (existsSync(dir)) {
      const uninstall = join(dir, 'uninstall.exe');
      if (!existsSync(uninstall)) throw new Error(`Uninstaller missing; inspect ${dir}`);
      run(uninstall, ['/S']);
      // NSIS relaunches its uninstaller from TEMP before removing itself.
      const deadline = Date.now() + 30_000;
      while (existsSync(dir) && Date.now() < deadline) await setTimeout(200);
      if (existsSync(dir)) throw new Error(`Uninstaller left the installation directory: ${dir}`);
    }
    cleanupInstallRegistration(dir, systemRegistration);
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await measureInstall(process.argv[2] ?? findInstaller());
}
