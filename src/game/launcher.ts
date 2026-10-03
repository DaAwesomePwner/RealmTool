import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../util/log.ts';
import { EXALT_EXE } from './exaltFinder.ts';

function defaultLaunchError(error: Error): void {
  log.error('Game', 'Could not start RotMG Exalt.exe', error);
}

/** Start Exalt detached from RealmTool's lifetime. Returns the PID when the OS reports one. */
export function launchExalt(gameDir: string, args: string[] = [], onError: (error: Error) => void = defaultLaunchError): number | undefined {
  const child = spawn(join(gameDir, EXALT_EXE), args, { cwd: gameDir, detached: true, stdio: 'ignore' });
  child.once('error', onError);
  child.unref();
  return child.pid;
}
