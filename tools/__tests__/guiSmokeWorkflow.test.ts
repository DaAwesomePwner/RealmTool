import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const available = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'gui-workflow-')); roots.push(root); return root; }
function step(name: string): string {
  return readFileSync(new URL('../../.github/workflows/gui-smoke.yml', import.meta.url), 'utf8')
    .split(`      - name: ${name}\n`)[1].split('      - ')[0].split('        run: |\n')[1]
    .split('\n').map(line => line.slice(10)).join('\n');
}
function run(script: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
}

it.skipIf(!available)('fallback kill touches only the recorded launch, preserving UTC time through JSON', () => {
  const root = fixture(); const state = join(root, 'state.json'); const killed = join(root, 'killed');
  const mocks = `
function Get-CimInstance { [pscustomobject]@{ ProcessId=123; ExecutablePath=$env:GUI_SMOKE_EXE; CreationDate=[DateTime]::Parse($env:FIXTURE_CREATED) } }
function taskkill.exe { 'killed' | Set-Content $env:FIXTURE_KILLED; $global:LASTEXITCODE=0 }
`;
  for (const [pid, created, expected] of [
    [null, '2026-10-14T10:00:00Z', false], [123, '2026-10-14T11:00:00Z', false],
    [123, '2026-10-14T10:00:00Z', true],
  ] as const) {
    writeFileSync(state, JSON.stringify({ launched: pid !== null, pid, creationDate: '2026-10-14T10:00:00Z' }));
    run(mocks + step("Always kill the job's app tree"), {
      GUI_SMOKE_STATE: state, GUI_SMOKE_EXE: join(root, 'realmtool-shell.exe'),
      FIXTURE_CREATED: created, FIXTURE_KILLED: killed, TZ: 'America/Chicago',
    });
    expect(existsSync(killed)).toBe(expected);
  }
});

it.skipIf(!available)('fallback skips attempted diagnostics and never overwrites the primary failure', () => {
  const root = fixture(); const state = join(root, 'state.json'); writeFileSync(state, '{}');
  const original = join(root, 'failure.txt'); writeFileSync(original, 'primary failure');
  const attempted = join(root, 'attempted.json'); writeFileSync(attempted, '{}');
  const env = { GUI_SMOKE_STATE: state, GUI_SMOKE_DIAGNOSTICS: root };
  const script = "function node { throw 'fixture collector failed' }\n" + step('Collect fallback diagnostics before killing the app');
  run(script, env); expect(existsSync(join(root, 'fallback'))).toBe(false);
  unlinkSync(attempted);
  run(script, env);
  expect(readFileSync(join(root, 'fallback/failure.txt'), 'utf8')).toContain('fixture collector failed');
  expect(readFileSync(original, 'utf8')).toBe('primary failure');
});
