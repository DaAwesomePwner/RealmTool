import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EXALT_EXE } from './exaltFinder.ts';

/** Start Exalt detached from RealmTool's lifetime. Returns the PID when the OS reports one. */
export function launchExalt(gameDir: string, args: string[] = []): number | undefined {
  const child = spawn(join(gameDir, EXALT_EXE), args, { cwd: gameDir, detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}
