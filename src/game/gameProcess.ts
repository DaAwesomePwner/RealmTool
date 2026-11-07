import { execFile } from 'node:child_process';

/** null means unsupported or enumeration failed; never treat that as an absent game. */
export async function isGameRunning(): Promise<boolean | null> {
  if (process.platform !== 'win32') return null;
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq RotMG Exalt.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve(error ? null : /^"RotMG Exalt\.exe",/im.test(stdout));
      });
  });
}
