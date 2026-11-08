import { isMainThread, workerData } from 'node:worker_threads';
import { parentedRefresh, runCatalogJob } from './catalogs/parentRefresh.ts';
import { pathToFileURL } from 'node:url';
import { realpathSync, statSync } from 'node:fs';
import { win32, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_PLUGINS } from '../plugins/index.ts';
import { appDataDir, ProfileStore } from './config/store.ts';
import { findExaltDirs, isExaltDir } from './game/exaltFinder.ts';
import { DEFAULT_HELPER_PATH, installHelper, uninstallHelper } from './game/helperInstaller.ts';
import { findLaunchTarget, openLaunchTarget, type LaunchTarget } from './game/gameLauncher.ts';
import type { PluginDefinition } from './plugins/api.ts';
import type { ProxyLike } from './plugins/host.ts';
import { loadSchema } from './protocol/schema.ts';
import { parseTargetFile } from './routing/targetResolver.ts';
import { tcpOwnerSourceError } from './routing/tcpProcessIdentity.ts';
import { ProxyHost, type ProxyHostOptions } from './transport/host.ts';
import { loadConsumables } from './data/consumables.ts';
import { loadSafetyCatalog } from './data/safety.ts';
import { resourcePaths } from './app/resources.ts';
import { log } from './util/log.ts';
import { AppController } from './app/controller.ts';
import { AppConfigStore } from './config/appConfig.ts';
import { LogRing } from './util/logStore.ts';
import { runSidecar } from './app/sidecar.ts';
import { startApiServer } from './api/server.ts';

const COMMANDS = ['start', 'serve', 'find-game', 'install-helper', 'uninstall-helper', 'config-path', 'help', 'selftest', 'refresh-data'] as const;
type Command = typeof COMMANDS[number];

export interface CliOptions {
  command: Command;
  gameDir?: string;
  outDir?: string;
  parentPipe?: boolean;
  helper: string;
  fallback?: string;
  launch: boolean;
  launcher?: string;
  quiet?: boolean;
}

export const HELP = `Usage: realmtool <command> [options]

Commands:
  start              Start the proxy, install the helper and open the RotMG Exalt Launcher (Ctrl+C to stop)
  serve              Run the authenticated desktop API and start the proxy without opening the launcher
  refresh-data       Refresh local game catalogs (no proxy restart needed)
  find-game          List detected Exalt install folders
  install-helper     Copy the helper DLL into the game folder
  uninstall-helper   Remove the helper DLL and restore any backed-up winhttp.dll
  config-path        Print the settings profile location

Options:
  --game-dir <dir>   Exalt "Production" folder (default: auto-detect)
  --out-dir <dir>    refresh-data: output folder (default: application data/catalogs)
  --helper <file>    Helper DLL to install (default: native/helper/bin/winhttp.dll)
  --fallback <ip>    Server to use when the helper recorded none
  --launcher <exe>    RotMG Exalt Launcher.exe to open (default: auto-detect Deca, then Steam)
  --no-launch        start: don't open the launcher
  --quiet            uninstall-helper: suppress success output (uses all saved helper directories)
  -h, --help         Show this help
`;

function validateLauncherOption(path: string): void {
  if (!path.trim()) throw new Error('--launcher must not be empty');
  if (win32.basename(path.trim()).toLowerCase() === 'rotmg exalt.exe') {
    throw new Error('Select the RotMG Exalt Launcher, not the game executable');
  }
}

export function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'game-dir': { type: 'string' },
      'out-dir': { type: 'string' },
      'parent-pipe': { type: 'boolean' },
      helper: { type: 'string' },
      fallback: { type: 'string' },
      launcher: { type: 'string' },
      'no-launch': { type: 'boolean', default: false },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals.length > 1) throw new Error(`Unexpected argument "${positionals[1]}". Run "realmtool help".`);
  const requested = values.help ? 'help' : (positionals[0] ?? 'help');
  if (!(COMMANDS as readonly string[]).includes(requested)) throw new Error(`Unknown command "${requested}". Run "realmtool help".`);
  if (values['game-dir'] !== undefined && !values['game-dir'].trim()) throw new Error('--game-dir must not be empty');
  const launcher = values.launcher?.trim();
  if (launcher !== undefined) validateLauncherOption(launcher);
  const fallback = values.fallback === undefined ? undefined : parseTargetFile(values.fallback);
  if (fallback === null) {
    throw new Error(`--fallback must be a public IPv4 address, got ${values.fallback}`);
  }
  return {
    command: requested as Command,
    gameDir: values['game-dir'],
    outDir: values['out-dir'],
    parentPipe: values['parent-pipe'],
    helper: values.helper ?? DEFAULT_HELPER_PATH,
    fallback,
    launch: !values['no-launch'],
    launcher,
    quiet: values.quiet,
  };
}

export function resolveGameDir(options: CliOptions): string | null {
  if (options.gameDir) {
    const gameDir = resolve(options.gameDir);
    return isExaltDir(gameDir) ? gameDir : null;
  }
  const discovered = findExaltDirs()[0];
  return discovered ? resolve(discovered) : null;
}

export interface RunDeps {
  createHost(options: ProxyHostOptions): ProxyLike & Pick<ProxyHost, 'start' | 'stop'>;
  plugins: readonly PluginDefinition[];
  profileDir(): string;
  launch(onError: (error: Error) => void, override?: string): LaunchTarget | null;
  /** Loads the native TCP owner lookup; returns why it is unavailable, or null when it works. */
  nativeModuleError(): string | null;
  /** Resolves when the user asks to stop (SIGINT/SIGTERM). Returns a disposer that removes the handlers. */
  onShutdown(handler: () => void): () => void;
}

const defaultRunDeps: RunDeps = {
  createHost: options => new ProxyHost(options),
  plugins: BUILTIN_PLUGINS,
  profileDir: () => appDataDir(),
  launch: (onError, override) => {
    const target = findLaunchTarget(undefined, override);
    if (target?.kind === 'deca') validateLauncherOption(target.exe);
    if (target) openLaunchTarget(target, onError);
    return target;
  },
  nativeModuleError: tcpOwnerSourceError,
  onShutdown(handler) {
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    return () => {
      process.removeListener('SIGINT', handler);
      process.removeListener('SIGTERM', handler);
    };
  },
};

export async function runProxy(options: CliOptions, gameDir: string, deps: RunDeps = defaultRunDeps): Promise<number> {
  if (options.launcher !== undefined) validateLauncherOption(options.launcher);
  const config = new AppConfigStore(deps.profileDir());
  config.update({ gameDir, launcher: options.launcher ?? null });
  const controller = new AppController({ config, resources: { ...resourcePaths(), helperDll: options.helper },
    logs: new LogRing(), fallback: options.fallback }, deps);
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });
  let shutdownRequested = false;
  controller.on('state', state => { if (state.proxy.state === 'failed') finish(1); });
  const dispose = deps.onShutdown(() => {
    shutdownRequested = true;
    finish(0);
    // Cancels the remaining startup steps; finally below observes shutdown errors.
    void controller.shutdown().catch(() => {});
  });
  try {
    try { await controller.startProxy(); } catch { return 1; }
    if (shutdownRequested) return await finished;
    if (options.launch) {
      try { await controller.launchGame(); } catch { return 1; }
    } else {
      log.info('Game', 'Start the game from your launcher; RealmTool is ready.');
    }
    return await finished;
  } finally {
    try { await controller.shutdown(); } finally { dispose(); }
  }
}

function forgetHelperDirs(config: AppConfigStore, processed: Set<string>): void {
  if (!processed.size) return;
  try { config.removeHelperDirs([...processed]); }
  catch { /* Uninstallation must still finish if config saving is unavailable. */ }
}

function uninstallSavedHelpers(): number {
  const store = new AppConfigStore(), config = store.get();
  const dirs = new Map<string, string>();
  for (const dir of [...config.helperDirs, ...(config.gameDir ? [config.gameDir] : [])]) {
    const path = resolve(dir), key = path.toLowerCase();
    if (!dirs.has(key)) dirs.set(key, path);
  }
  const processed = new Set<string>();
  let code = 0;
  for (const [key, dir] of dirs) {
    try {
      if (!statSync(dir).isDirectory()) { processed.add(key); continue; }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') processed.add(key);
      // Keep targets we could not inspect so a later uninstall can retry them.
      continue;
    }
    try {
      uninstallHelper(dir);
      // All returned statuses, including foreign, mean no helper remains to remove.
      processed.add(key);
    } catch (error) {
      log.error('Helper', `${dir}: ${(error as Error).message}`);
      code = 1;
    }
  }
  forgetHelperDirs(store, processed);
  return code;
}

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    console.error((error as Error).message);
    return argv[0] === 'refresh-data' ? 1 : 2;
  }
  if (options.command === 'refresh-data') {
    try {
      const started = performance.now();
      const gameDir = options.gameDir ?? new AppConfigStore().get().gameDir ?? findExaltDirs()[0];
      if (!gameDir) throw new Error('No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
      if (options.outDir !== undefined && !options.outDir.trim()) throw new Error('--out-dir must not be empty');
      const { generateCatalogs } = await import('./catalogs/generate.ts');
      const args = ['--game-dir', gameDir, '--out-dir', options.outDir ?? join(appDataDir(), 'data', 'catalogs')];
      const result = options.parentPipe ? await parentedRefresh(new URL(import.meta.url), args, process.stdin)
        : generateCatalogs(args, { writeSource: true });
      console.log(JSON.stringify({ gameBuild: result.gameBuild, items: result.consumables.items,
        projectiles: result.safety.projectiles, tiles: result.safety.tiles, ms: Math.round(performance.now() - started) }));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      // A lost supervisor must terminate all extraction threads immediately.
      if (options.parentPipe) process.exit(1);
      return 1;
    }
  }
  if (options.command === 'selftest') {
    const host = new ProxyHost({ schema: loadSchema(), listenPort: 0 });
    try {
      // Read package catalogs, independent of any user overrides.
      const appDataDir = resourcePaths().root;
      const consumables = loadConsumables({ appDataDir });
      const safety = loadSafetyCatalog({ appDataDir });
      if (!consumables.ok) throw new Error(consumables.reason);
      if (!safety.ok) throw new Error(safety.reason);
      await host.start();
      console.log('selftest ok');
      return 0;
    } catch (error) {
      log.error('Selftest', (error as Error).message);
      return 1;
    } finally { await host.stop(); }
  }
  if (options.command === 'serve') {
    const logs = new LogRing();
    return await runSidecar({ logs, env: process.env, stdin: process.stdin, stdout: process.stdout,
      startApi: async (controller, token, origins) => {
        const api = await startApiServer(controller, logs, { token, origins });
        // runSidecar writes READY in the promise continuation, before this next turn.
        const start = setImmediate(() => { void controller.startProxy().catch(() => { /* Controller retains and logs the failure. */ }); });
        return { port: api.port, close: () => { clearImmediate(start); return api.close(); } };
      },
    });
  }
  if (options.command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (options.command === 'config-path') {
    console.log(new ProfileStore({ dir: appDataDir() }).path);
    return 0;
  }
  if (options.command === 'find-game') {
    const dirs = findExaltDirs();
    console.log(dirs.length ? dirs.join('\n') : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return dirs.length ? 0 : 1;
  }
  // Quiet app uninstall only visits recorded targets, never discovery or overrides.
  if (options.command === 'uninstall-helper' && options.quiet) return uninstallSavedHelpers();
  const gameDir = resolveGameDir(options);
  if (!gameDir) {
    log.error('Game', options.gameDir
      ? `"${options.gameDir}" does not contain RotMG Exalt.exe`
      : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return 1;
  }
  try {
    if (options.command === 'install-helper') {
      const store = new AppConfigStore();
      try { store.addHelperDir(gameDir); }
      catch (cause) { throw new Error('Could not save the game folder; the helper was not installed', { cause }); }
      const result = installHelper(gameDir, options.helper);
      log.info('Helper', `${result.status} at ${result.target}${result.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
      return 0;
    }
    if (options.command === 'uninstall-helper') {
      const status = uninstallHelper(gameDir);
      forgetHelperDirs(new AppConfigStore(), new Set([gameDir.toLowerCase()]));
      if (!options.quiet) log.info('Helper', `${status} (${gameDir})`);
      return 0;
    }
    return await runProxy(options, gameDir);
  } catch (error) {
    log.error('RealmTool', (error as Error).message);
    return 1;
  }
}

// Node resolves entry-point symlinks (including macOS /var), but argv retains the supplied path.
if (!isMainThread && workerData?.kind === 'catalog-refresh') {
  void runCatalogJob(workerData);
} else if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href
  || import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
