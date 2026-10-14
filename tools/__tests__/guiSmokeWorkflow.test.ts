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
function run(script: string, env: NodeJS.ProcessEnv, expectedStatus = 0) {
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\n" + script], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr).toBe(expectedStatus);
  return result;
}

it.skipIf(!available)('fallback kills every exact build-path match even without usable state', () => {
  const root = fixture(); const killed = join(root, 'killed');
  const mocks = `
function Get-CimInstance {
  [pscustomobject]@{ ProcessId=123; ExecutablePath=$env:GUI_SMOKE_EXE; CreationDate=[DateTime]::Parse('2020-01-01T10:00:00Z') }
  [pscustomobject]@{ ProcessId=124; ExecutablePath=(Join-Path (Split-Path $env:GUI_SMOKE_EXE) './realmtool-shell.exe') }
  [pscustomobject]@{ ProcessId=125; ExecutablePath=(Join-Path (Split-Path $env:GUI_SMOKE_EXE) 'installed/realmtool-shell.exe') }
  [pscustomobject]@{ ProcessId=126; ExecutablePath=(Join-Path (Split-Path $env:GUI_SMOKE_EXE) 'installed/RealmTool.exe') }
}
function taskkill.exe { ($args -join ' ') | Add-Content $env:FIXTURE_KILLED; $global:LASTEXITCODE=0 }
`;
  const state = join(root, 'state.json');
  for (const record of [undefined, '{broken', JSON.stringify({ launched: false, pid: 999, creationDate: '2026-10-14T10:00:00Z' })]) {
    if (record !== undefined) writeFileSync(state, record);
    run(mocks + step("Always kill the job's app tree"), {
      GUI_SMOKE_STATE: state, GUI_SMOKE_EXE: join(root, 'realmtool-shell.exe'),
      FIXTURE_KILLED: killed,
    });
    expect(readFileSync(killed, 'utf8').trim().split(/\r?\n/)).toEqual(['/PID 123 /T /F', '/PID 124 /T /F']);
    unlinkSync(killed);
  }
});

it.skipIf(!available)('fallback tolerates a nonzero collector exit and an unwritable error report', () => {
  const root = fixture(); const state = join(root, 'state.json'); writeFileSync(state, '{}');
  writeFileSync(join(root, 'fallback'), 'not a directory');
  const result = run("function node { $global:LASTEXITCODE=7 }\n" + step('Collect fallback diagnostics before killing the app'),
    { GUI_SMOKE_STATE: state, GUI_SMOKE_DIAGNOSTICS: root });
  expect(result.stdout).toContain('Fallback diagnostics exited 7');
  expect(result.stdout).toContain('Could not save fallback diagnostics error');
});

it.skipIf(!available)('requires a screenshot file after successful smoke even if diagnostics exist', () => {
  const root = fixture(); const screenshot = join(root, 'smoke.png');
  writeFileSync(join(root, 'diagnostics.json'), '{}');
  const script = step('Require screenshot after successful smoke');
  expect(run(script, { GUI_SMOKE_SCREENSHOT: screenshot }, 1).stderr).toContain('GUI smoke passed but its screenshot is missing');
  expect(run(script, { GUI_SMOKE_SCREENSHOT: root }, 1).stderr).toContain('screenshot is missing');
  writeFileSync(screenshot, 'screenshot');
  run(script, { GUI_SMOKE_SCREENSHOT: screenshot });
});

it('retries failed uploads once with a distinct name and preserves smoke failures', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/gui-smoke.yml', import.meta.url), 'utf8');
  const block = (name: string) => workflow.split(`      - name: ${name}\n`)[1].split('      - ')[0];
  expect(block('Launch real app and inspect WebView2 over CDP')).toContain('id: smoke');
  expect(block('Launch real app and inspect WebView2 over CDP')).not.toContain('continue-on-error');
  expect(block('Require screenshot after successful smoke')).toContain("if: always() && steps.smoke.outcome == 'success'");
  const first = block('Upload GUI smoke evidence'); const retry = block('Retry GUI smoke evidence upload');
  expect(first).toContain('id: upload'); expect(first).toContain('if: always()');
  expect(first).toContain('continue-on-error: true');
  expect(retry).toContain("if: always() && steps.upload.outcome == 'failure'");
  expect(retry).not.toContain('continue-on-error');
  const name = (text: string) => text.match(/^          name: (.+)$/m)![1];
  expect(name(retry)).not.toBe(name(first));
  for (const upload of [first, retry]) {
    expect(upload).toContain('${{ env.GUI_SMOKE_SCREENSHOT }}');
    expect(upload).toContain('${{ env.GUI_SMOKE_DIAGNOSTICS }}');
    expect(upload).toContain('if-no-files-found: warn');
    expect(upload).toContain('retention-days: 7');
  }
  expect(block('Collect fallback diagnostics before killing the app')).toContain('continue-on-error: true');
});

it.skipIf(!available)('fallback reports failed kills only when the process remains', () => {
  const root = fixture();
  const script = `
function Get-CimInstance { [pscustomobject]@{ ProcessId=123; ExecutablePath=$env:GUI_SMOKE_EXE } }
function taskkill.exe { $global:LASTEXITCODE=1 }
function Get-Process { if ($env:FIXTURE_REMAINS -eq 'true') { [pscustomobject]@{ Id=123 } } }
` + step("Always kill the job's app tree");
  for (const remains of [false, true]) {
    const result = run(script, { GUI_SMOKE_EXE: join(root, 'realmtool-shell.exe'), FIXTURE_REMAINS: String(remains) }, remains ? 1 : 0);
    if (remains) expect(result.stderr).toContain('Could not kill GUI smoke process 123');
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
