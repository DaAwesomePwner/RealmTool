import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

/** null means unsupported or enumeration failed; [] means no game processes. */
export async function gameProcessIds(): Promise<number[] | null> {
  if (process.platform !== 'win32') return null;
  return new Promise(resolve => {
    execFile(win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', 'IMAGENAME eq RotMG Exalt.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        const ids = [...stdout.matchAll(/^"RotMG Exalt\.exe","(\d+)",/gim)].map(match => Number(match[1]));
        resolve(error ? null : ids.filter(pid => Number.isSafeInteger(pid) && pid > 0));
      });
  });
}
