import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

interface ExistingProcess {
  Name: string; ProcessId: number; SessionId: number; OwnerSid: string;
  ExecutablePath: string | null; CreationDate: string;
}

export function existingInstances(processes: ExistingProcess[], sessionId: number, userSid: string): ExistingProcess[] {
  return processes.filter(process => /^(realmtool-shell|realmtool)\.exe$/i.test(process.Name)
    && process.SessionId === sessionId && process.OwnerSid === userSid);
}

export function assertNoExistingInstances(processes: ExistingProcess[], sessionId: number, userSid: string): void {
  const existing = existingInstances(processes, sessionId, userSid);
  if (existing.length) throw new Error(`Refusing to launch: RealmTool is already running for this user in session ${sessionId}. `
    + `A second instance can hand off and exit without CDP. Existing processes will not be killed:\n`
    + existing.map(process => `PID ${process.ProcessId}; path ${process.ExecutablePath ?? '(unavailable)'}; started ${process.CreationDate}`).join('\n'));
}

async function query(script: string): Promise<any> {
  const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export async function checkExistingInstances(): Promise<void> {
  const result = await query(`
$ErrorActionPreference = 'Stop'
$sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$apps = @(Get-CimInstance Win32_Process -Filter "SessionId = $sessionId" -OperationTimeoutSec 8 |
  Where-Object { $_.Name -match '^(realmtool-shell|realmtool)\\.exe$' } | ForEach-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0) { throw "Cannot determine owner of existing RealmTool PID $($_.ProcessId)" }
    [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; SessionId=$_.SessionId;
      OwnerSid=$owner.Sid; ExecutablePath=$_.ExecutablePath; CreationDate=$_.CreationDate }
  })
@{ processes=$apps; sessionId=$sessionId; userSid=$userSid } | ConvertTo-Json -Depth 4 -Compress
`);
  assertNoExistingInstances(result.processes, result.sessionId, result.userSid);
}

/** Persist exact OS creation time so fallback cleanup cannot kill a reused PID or a pre-existing app. */
export async function launchCreationDate(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid launched PID');
  const date = await query(`$ErrorActionPreference='Stop'; $app=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -OperationTimeoutSec 8; if ($app) { $app.CreationDate.ToUniversalTime().ToString('o') | ConvertTo-Json -Compress } else { 'null' }`);
  return typeof date === 'string' ? date : undefined;
}

export function assertAppRunning(child: { exitCode: number | null; signalCode: string | null }): void {
  if (child.exitCode !== null) throw new Error(`Desktop app exited with code ${child.exitCode} before CDP`
    + (child.exitCode === 0 ? '; likely a single-instance handoff' : ''));
  if (child.signalCode !== null) throw new Error(`Desktop app exited with signal ${child.signalCode} before CDP`);
}
