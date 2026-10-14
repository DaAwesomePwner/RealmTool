import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

interface BuildProcess { ProcessId: number; ExecutablePath: string | null; CreationDate?: string }

/** The GUI build path belongs exclusively to this job; executable names alone prove nothing. */
export function sameExecutablePath(actual: string | null | undefined, expected: string): boolean {
  return !!actual && win32.isAbsolute(actual) && win32.isAbsolute(expected)
    && win32.normalize(actual).toLowerCase() === win32.normalize(expected).toLowerCase();
}

async function readProcesses(pid?: number): Promise<BuildProcess[]> {
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) throw new Error('Invalid process PID');
  const filter = pid === undefined ? '' : `-Filter 'ProcessId = ${pid}'`;
  const { stdout } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process ${filter} -OperationTimeoutSec 8 | Select-Object ProcessId, ExecutablePath, CreationDate); ConvertTo-Json -InputObject $rows -Compress`],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

async function inspectProcess(pid: number): Promise<BuildProcess | undefined> { return (await readProcesses(pid))[0]; }
async function terminateTree(pid: number): Promise<void> {
  await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
}

export async function stopBuildProcess(pid: number, executable: string, inspect = inspectProcess, terminate = terminateTree): Promise<void> {
  const owned = (process: BuildProcess | undefined) => process?.ProcessId === pid && sameExecutablePath(process.ExecutablePath, executable);
  if (!owned(await inspect(pid))) return;
  try { await terminate(pid); }
  catch (error) {
    // taskkill can lose a race with a normal exit. A surviving build-path process is a real cleanup failure.
    if (owned(await inspect(pid))) throw error;
  }
}

export async function cleanupBuildProcesses(executable: string, inspect = readProcesses, stop = stopBuildProcess): Promise<void> {
  for (const process of await inspect()) {
    if (!sameExecutablePath(process.ExecutablePath, executable)) continue;
    console.warn(`Cleaning up leftover GUI smoke process: PID ${process.ProcessId}; path ${process.ExecutablePath}; started ${process.CreationDate ?? '(unknown)'}`);
    await stop(process.ProcessId, executable);
  }
}
