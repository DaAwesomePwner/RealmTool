import { readFileSync, statSync } from 'node:fs';
import { DEFAULT_HELPER_PATH, HELPER_MARKER } from '../src/game/helperInstaller.ts';

const path = process.argv[2] ?? DEFAULT_HELPER_PATH;
const bytes = readFileSync(path);
const size = statSync(path).size;
const problems: string[] = [];
if (bytes.readUInt16LE(0) !== 0x5a4d) problems.push('not a PE file (missing MZ)');
if (!bytes.includes(HELPER_MARKER, 0, 'latin1')) problems.push(`marker "${HELPER_MARKER}" missing`);
if (!bytes.includes('C:\\Windows\\System32\\winhttp.dll.WinHttpOpen', 0, 'latin1')) problems.push('winhttp export forwarders missing');
if (size > 200 * 1024) problems.push(`size ${size} bytes exceeds the 200 KiB budget`);
if (problems.length) {
  console.error(`verify-helper: ${path}\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`verify-helper: OK (${path}, ${(size / 1024).toFixed(1)} KiB)`);
