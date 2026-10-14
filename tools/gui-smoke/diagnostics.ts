import { execFile } from 'node:child_process';
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

interface ProcessRow {
  ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null;
  SessionId?: number; ExecutablePath?: string | null; CreationDate?: string;
}
interface Listener { OwningProcess: number; LocalPort: number; LocalAddress?: string }
interface Inventory {
  processes: ProcessRow[]; listeners: Listener[]; errors: string[];
  sessionId: number; rootAlive: boolean; exitCode: number | null;
}
interface Options {
  root: string; directory: string; exe: string; pid: number | null; port: number;
  child?: { exitCode: number | null; signalCode: string | null };
  environment?: NodeJS.ProcessEnv;
}

/** Start with the recorded PID even if it exited; surviving children still carry its parent ID. */
export function summarizeProcesses(processes: ProcessRow[], listeners: Listener[], pid: number | null) {
  const ids = new Set<number>(pid === null ? [] : [pid]);
  let previous: number;
  do {
    previous = ids.size;
    for (const process of processes) if (ids.has(process.ParentProcessId)) ids.add(process.ProcessId);
  } while (previous !== ids.size);
  return {
    tree: processes.filter(process => ids.has(process.ProcessId)),
    listeners: listeners.filter(listener => ids.has(listener.OwningProcess)),
    otherAppProcesses: processes.filter(process => !ids.has(process.ProcessId)
      && /^(realmtool-shell|msedgewebview2)\.exe$/i.test(process.Name)),
  };
}

export async function readTail(path: string, lines = 80, bytes = 32_768): Promise<string> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - bytes));
    return buffer.subarray(0, bytesRead).toString('utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } finally { await file.close(); }
}

async function collectWindows(options: Options): Promise<Inventory> {
  const { stdout, stderr } = await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./diagnostics.ps1', import.meta.url)),
    '-Root', options.root, '-Directory', options.directory, '-AppPid', String(options.pid ?? 0)],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (stderr) await writeFile(join(options.directory, 'collector-stderr.txt'), stderr);
  return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

export async function captureDiagnostics(options: Options, collect = collectWindows): Promise<void> {
  const { directory, child } = options;
  await mkdir(directory, { recursive: true });
  const errors: unknown[] = [];
  const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
  // Do not dump inherited secrets. Record only the launch overrides relevant to this failure.
  const environment = Object.fromEntries(Object.entries(options.environment ?? {}).filter(([key]) =>
    /^(APPDATA|LOCALAPPDATA|USERPROFILE|HOME|TEMP|TMP|TMPDIR|ROTMG_PATH|WEBVIEW2_.*)$/i.test(key)));
  await attempt(() => writeFile(join(directory, 'launch.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), root: options.root, exe: options.exe, pid: options.pid,
    alive: options.pid === null ? false : child ? child.exitCode === null && child.signalCode === null : null,
    exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null, environment,
  }, null, 2)));
  await attempt(() => copyFile(join(options.root, 'app-output.log'), join(directory, 'app-output.log')));
  await attempt(async () => {
    const inventory = await collect(options);
    const { processes, listeners, ...context } = inventory;
    const portListeners = listeners.filter(listener => [options.port, 2050].includes(listener.LocalPort));
    await writeFile(join(directory, 'processes.json'), JSON.stringify({ ...context,
      ...summarizeProcesses(processes, listeners, options.pid), portListeners,
      portOwners: processes.filter(process => portListeners.some(listener => listener.OwningProcess === process.ProcessId)),
    }, null, 2));
    if (inventory.errors.length) throw new Error(inventory.errors.join('\n'));
  });
  if (errors.length) {
    await writeFile(join(directory, 'collector-error.txt'), errors.map(String).join('\n'));
    throw new AggregateError(errors, errors.map(String).join('\n'));
  }
  await writeFile(join(directory, 'complete.json'), JSON.stringify({ capturedAt: new Date().toISOString() }));
}

export async function printFailureDiagnostics(directory: string, error: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'failure.txt'), String(error));
  try { console.error(`App stdout/stderr (tail):\n${await readTail(join(directory, 'app-output.log')) || '(empty)'}`); }
  catch (tailError) { console.error(`App output unavailable: ${tailError}`); }
  console.error(`GUI smoke diagnostics: ${directory}`);
}
