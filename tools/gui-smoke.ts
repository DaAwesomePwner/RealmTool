import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectPage, waitForTarget } from './gui-smoke/cdp.ts';
import { launchEnvironment, prepareProfile, withApp } from './gui-smoke/process.ts';
import { connect } from './gui-smoke/transport.ts';
import { snapshotKnownFolders, verifyIsolation, type KnownFolderSnapshot } from './gui-smoke/isolation.ts';
import { captureDiagnostics, printFailureDiagnostics } from './gui-smoke/diagnostics.ts';

let diagnosticsDirectory: string | undefined;

interface SmokeState {
  root: string; exe: string; pid: number | null; launched: boolean;
  isolation?: KnownFolderSnapshot[]; profileVerified?: boolean;
}

async function verifyProfile(state: SmokeState, stateFile: string): Promise<void> {
  if (!state.isolation) {
    if (state.launched) throw new Error('Missing pre-launch known-folder snapshots');
    return;
  }
  await verifyIsolation(state.isolation, state.root, state.launched && !state.profileVerified);
  state.profileVerified = true;
  await writeFile(stateFile, JSON.stringify(state));
  console.log('Profile isolation verified: known-folder files unchanged; WebView2 data confined to temporary profile');
}

async function smoke(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('GUI smoke requires the Windows interactive runner');
  const { values } = parseArgs({ options: {
    exe: { type: 'string' }, screenshot: { type: 'string' }, state: { type: 'string' }, port: { type: 'string' },
    'verify-profile': { type: 'boolean' }, diagnose: { type: 'boolean' },
  } });
  const exe = values.exe ?? process.env.GUI_SMOKE_EXE;
  const screenshot = values.screenshot ?? process.env.GUI_SMOKE_SCREENSHOT;
  const stateFile = values.state ?? process.env.GUI_SMOKE_STATE;
  const port = Number(values.port ?? process.env.GUI_SMOKE_PORT ?? '9241');
  if (!exe || !screenshot || !stateFile) throw new Error('Provide --exe, --screenshot, --state (or GUI_SMOKE_* env)');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid CDP port');
  diagnosticsDirectory = resolve(process.env.GUI_SMOKE_DIAGNOSTICS ?? `${stateFile}.diagnostics`);
  const executable = resolve(exe);
  if (values['verify-profile'] || values.diagnose) {
    const state: SmokeState = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.exe !== executable || dirname(state.root) !== dirname(resolve(stateFile))
      || !state.root.startsWith(join(dirname(resolve(stateFile)), 'realmtool-gui-'))) throw new Error('Invalid GUI profile record');
    if (values.diagnose) {
      await captureDiagnostics({ ...state, directory: join(diagnosticsDirectory, 'fallback'), port });
    } else await verifyProfile(state, stateFile);
    return;
  }
  // Refuse to attach to another app that already owns the CDP endpoint.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
  const catalog = JSON.parse(await readFile(join(dirname(executable), 'app/data/catalogs/safety.json'), 'utf8'));
  if (typeof catalog.gameBuild !== 'string') throw new Error('Missing catalog gameBuild');
  await mkdir(dirname(resolve(stateFile)), { recursive: true });
  const root = await mkdtemp(join(dirname(resolve(stateFile)), 'realmtool-gui-'));
  const state: SmokeState = { root, exe: executable, pid: null, launched: false };
  let child: ChildProcess | undefined;
  // Preserve this record if cleanup fails so the workflow's always step can retry.
  const record = () => writeFile(stateFile, JSON.stringify(state));
  await withApp(async () => {
    await record();
    const gameDir = prepareProfile(root, catalog.gameBuild);
    state.isolation = await snapshotKnownFolders();
    state.launched = true;
    await record();
    const output = await open(join(root, 'app-output.log'), 'a');
    try {
      child = spawn(executable, [], { cwd: root, env: launchEnvironment(root, port), stdio: ['ignore', output.fd, output.fd] });
      await once(child, 'spawn');
    } finally { await output.close(); }
    state.pid = child.pid ?? null;
    await record();
    const target = await waitForTarget(port);
    const cdp = await connect(target.webSocketDebuggerUrl);
    try {
      const proxy = await inspectPage(cdp, { screenshot: resolve(screenshot), gameDir });
      console.log(`GUI smoke proxy path: ${proxy}`);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Desktop app exited during GUI smoke');
    } finally { cdp.close(); }
  }, {
    async diagnose() {
      await captureDiagnostics({ root, directory: diagnosticsDirectory!, exe: executable,
        pid: state.pid, child, port, environment: launchEnvironment(root, port) });
    },
    async stop() {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000 });
      if (result.error) throw result.error;
      if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
        throw new Error(`taskkill failed (${result.status}): ${result.stderr || result.stdout}`);
      }
    },
    async verify() { await verifyProfile(state, stateFile); },
    async remove() { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); },
  });
  // Keep snapshots until the workflow's independent always verification has run.
  console.log(`GUI smoke passed: rendered dashboard, connected fake-game backend, 10s without browser errors; ${screenshot}`);
}

smoke().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (diagnosticsDirectory) {
    try { await printFailureDiagnostics(diagnosticsDirectory, error); }
    catch (reportError) { console.error(`Could not report diagnostics: ${reportError}`); }
  }
});
