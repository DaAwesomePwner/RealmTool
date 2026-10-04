import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function findInstaller(root = projectRoot): string {
  const dir = join(root, 'src-tauri/target/release/bundle/nsis');
  const files = readdirSync(dir).filter(name => name.endsWith('-setup.exe'));
  if (files.length !== 1) throw new Error(`Expected one NSIS installer in ${dir}; found ${files.length}`);
  return join(dir, files[0]);
}

export function buildApp(): void {
  if (process.platform !== 'win32') throw new Error('The app build requires Windows x64');
  // cmd is needed for npm.cmd/npx.cmd; commands contain no caller-supplied input.
  for (const command of ['npm run build:helper', 'npm run fetch:node', 'npm run build:backend',
    'npm run ui:build', 'npx tauri build']) {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  }
  console.log(`Installer: ${findInstaller()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildApp();
