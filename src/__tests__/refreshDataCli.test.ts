import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { serializedFile } from '../testing/unityAssets.ts';

const exec = promisify(execFile), dirs: string[] = [];
const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'realmtool-refresh-cli-')); dirs.push(root);
  const gameDir = join(root, 'game'), data = join(gameDir, 'RotMG Exalt_Data'); mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'boot.config'), 'build-guid=fixture');
  writeFileSync(join(data, 'resources.assets'), serializedFile([
    { classId: 49, text: '<?xml version="1.0"?><Objects><Object type="42"><Consumable/><Activate amount="20">Heal</Activate><Projectile/></Object></Objects>' },
    { classId: 49, text: '<?xml version="1.0"?><GroundTypes><Ground type="2"><MaxDamage>10</MaxDamage></Ground></GroundTypes>' },
  ]));
  return { root, gameDir, env: { ...process.env, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), ROTMG_PATH: gameDir } };
}
it('refresh-data exits zero with one result line and defaults to configured game and appdata output', async () => {
  const f = fixture(), app = join(f.env.APPDATA, 'RealmTool'); mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'config.json'), JSON.stringify({ schemaVersion: 1, gameDir: f.gameDir }));
  const { stdout, stderr } = await exec(process.execPath, [cli, 'refresh-data'], { env: f.env });
  expect(stderr).toBe(''); expect(stdout.trim().split(/\r?\n/)).toHaveLength(1);
  expect(JSON.parse(stdout)).toMatchObject({ gameBuild: 'fixture', items: 1, projectiles: 1, tiles: 1, ms: expect.any(Number) });
  expect(JSON.parse(readFileSync(join(app, 'data/catalogs/safety.json'), 'utf8')).gameBuild).toBe('fixture');
  const stamp = (file: string) => { const { size, mtimeMs } = statSync(join(f.gameDir, 'RotMG Exalt_Data', file)); return { size, mtimeMs }; };
  expect(JSON.parse(readFileSync(join(app, 'data/catalogs/source.json'), 'utf8'))).toEqual({ schemaVersion: 1, gameBuild: 'fixture',
    resourcesAssets: stamp('resources.assets'), bootConfig: stamp('boot.config') });
  const output = join(f.root, 'explicit');
  await exec(process.execPath, [cli, 'refresh-data', '--game-dir', f.gameDir, '--out-dir', output], { env: f.env });
  expect(JSON.parse(readFileSync(join(output, 'consumables.json'), 'utf8')).items).toHaveLength(1);
});
it('refresh-data exits one with a clear error and no result on extraction failure', async () => {
  const f = fixture(); writeFileSync(join(f.gameDir, 'RotMG Exalt_Data/resources.assets'), 'invalid');
  await expect(exec(process.execPath, [cli, 'refresh-data', '--game-dir', f.gameDir], { env: f.env }))
    .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(/truncated|invalid|header/i) });
});

it('preserves the generator CLI arguments and two output lines', async () => {
  const f = fixture(), wrapper = fileURLToPath(new URL('../../tools/gen-catalogs.ts', import.meta.url));
  const out = join(f.root, 'generated');
  const { stdout, stderr } = await exec(process.execPath, [wrapper, '--game-dir', f.gameDir, '--out-dir', out], { env: f.env });
  expect(stderr).toBe(''); expect(stdout.trim().split(/\r?\n/)).toHaveLength(2);
  expect(stdout).toContain(`${join(out, 'consumables.json')}: 1 items,`);
  expect(stdout).toContain(`${join(out, 'safety.json')}: 1 projectiles, 1 tiles,`);
  expect(stdout.match(/gameBuild=fixture/g)).toHaveLength(2);
  expect(readdirSync(out).sort()).toEqual(['consumables.json', 'safety.json']);
});

it('refresh-data reports invalid arguments with exit one', async () => {
  const f = fixture();
  await expect(exec(process.execPath, [cli, 'refresh-data', '--out-dir'], { env: f.env }))
    .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('--out-dir') });
});

it('parent-pipe mode exits nonzero without publishing when stdin closes', async () => {
  const f = fixture(), out = join(f.root, 'orphan-output');
  const child = spawn(process.execPath, [cli, 'refresh-data', '--parent-pipe', '--game-dir', f.gameDir, '--out-dir', out],
    { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); }); child.stdout.resume();
  const closed = once(child, 'close'); child.stdin.end();
  const [code] = await closed;
  expect(code).toBe(1); expect(stderr).toContain('Refresh parent disconnected');
  expect(existsSync(join(out, 'source.json'))).toBe(false);
  expect(existsSync(join(out, 'consumables.json'))).toBe(false);
  expect(existsSync(join(out, 'safety.json'))).toBe(false);
});
it('parent-pipe mode publishes normally while its parent pipe stays open', async () => {
  const f = fixture(), out = join(f.root, 'parented-output');
  const child = spawn(process.execPath, [cli, 'refresh-data', '--parent-pipe', '--game-dir', f.gameDir, '--out-dir', out],
    { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += String(bytes); }); child.stderr.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'close'); child.stdin.destroy();
  expect(code, stderr).toBe(0); expect(JSON.parse(stdout).gameBuild).toBe('fixture');
  expect(existsSync(join(out, 'source.json'))).toBe(true);
});
