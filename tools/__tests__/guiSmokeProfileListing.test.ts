import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const available = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function listing(count: number, length: number, missing = false) {
  const root = mkdtempSync(join(tmpdir(), 'gui-listing-')); roots.push(root);
  const path = join(root, 'listing.json');
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
. $env:FIXTURE_HELPER
function Get-ChildItem {
  param($LiteralPath, [switch]$Recurse, [switch]$Force)
  for ($i = 0; $i -lt [int]$env:FIXTURE_COUNT; $i++) {
    [pscustomobject]@{ FullName=('雪' * [int]$env:FIXTURE_LENGTH) + $i; Length=42; Attributes='Normal'; LinkTarget=$null }
  }
}
Write-TemporaryProfileListing -Root $env:FIXTURE_ROOT -Path $env:FIXTURE_OUTPUT
`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env,
    FIXTURE_HELPER: fileURLToPath(new URL('../gui-smoke/profile-listing.ps1', import.meta.url)),
    FIXTURE_ROOT: missing ? join(root, 'missing') : root, FIXTURE_OUTPUT: path,
    FIXTURE_COUNT: String(count), FIXTURE_LENGTH: String(length),
  } });
  expect(result.status, result.stderr).toBe(0);
  const bytes = readFileSync(path);
  expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
  return JSON.parse(bytes.toString('utf8'));
}

it.skipIf(!available)('retains small listings and distinguishes missing/empty profiles', () => {
  expect(listing(2, 5)).toMatchObject({ exists: true, truncated: false, entries: [
    { FullName: '雪雪雪雪雪0', Length: 42 }, { FullName: '雪雪雪雪雪1', Length: 42 },
  ] });
  expect(listing(0, 0)).toEqual({ exists: true, truncated: false, entries: [] });
  expect(listing(2, 5, true)).toEqual({ exists: false, truncated: false, entries: [] });
});

it.skipIf(!available)('caps entries and only marks truncation when entries were omitted', () => {
  const exact = listing(1000, 1);
  expect(exact.entries).toHaveLength(1000); expect(exact.truncated).toBe(false);
  const capped = listing(1002, 1);
  expect(capped.entries).toHaveLength(1000); expect(capped.truncated).toBe(true);
});

it.skipIf(!available)('caps UTF-8 bytes, including a single oversized entry, while preserving valid JSON', () => {
  const capped = listing(1000, 1000);
  expect(capped.entries.length).toBeGreaterThan(0);
  expect(capped.entries.length).toBeLessThan(100);
  expect(capped.truncated).toBe(true);
  expect(listing(1, 100_000)).toEqual({ exists: true, truncated: true, entries: [] });
});
