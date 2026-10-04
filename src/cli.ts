import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';
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

const COMMANDS = ['start', 'serve', 'find-game', 'install-helper', 'uninstall-helper', 'config-path', 'help', 'selftest'] as const;
type Command = typeof COMMANDS[number];

export interface CliOptions {
  command: Command;
  gameDir?: string;
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
  find-game          List detected Exalt install folders
  install-helper     Copy the helper DLL into the game folder
  uninstall-helper   Remove the helper DLL and restore any backed-up winhttp.dll
  config-path        Print the settings profile location

Options:
  --game-dir <dir>   Exalt "Production" folder (default: auto-detect)
  --helper <file>    Helper DLL to install (default: native/helper/bin/winhttp.dll)
  --fallback <ip>    Server to use when the helper recorded none
  --launcher <exe>    RotMG Exalt Launcher.exe to open (default: auto-detect Deca, then Steam)
  --no-launch        start: don't open the launcher
  --quiet            uninstall-helper: suppress success output (uses saved game directory)
  -h, --help         Show this help
`;

function validateLauncherOption(path: string): void {
  if (!path.trim()) throw new Error('--launcher must not be empty');
  if (basename(path.trim()).toLowerCase() === 'rotmg exalt.exe') {
    throw new Error('Select the RotMG Exalt Launcher, not the game executable');
  }
}

export function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'game-dir': { type: 'string' },
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

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCli(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
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
    const detach = log.addSink(record => logs.push(record));
    try {
      return await runSidecar({ env: process.env, stdin: process.stdin, stdout: process.stdout,
        startApi: async (controller, token, origins) => {
          const api = await startApiServer(controller, logs, { token, origins });
          // runSidecar writes READY in the promise continuation, before this next turn.
          const start = setImmediate(() => { void controller.startProxy().catch(() => { /* Controller retains and logs the failure. */ }); });
          return { port: api.port, close: () => { clearImmediate(start); return api.close(); } };
        },
      });
    } finally { detach(); }
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
  if (options.command === 'uninstall-helper' && options.quiet && !options.gameDir) {
    options.gameDir = new AppConfigStore().get().gameDir ?? undefined;
    // An unused desktop installation has no helper to restore. Do not discover
    // and modify an unrelated game installation during a quiet app uninstall.
    if (!options.gameDir && options.quiet) return 0;
  }
  const gameDir = resolveGameDir(options);
  if (!gameDir) {
    log.error('Game', options.gameDir
      ? `"${options.gameDir}" does not contain RotMG Exalt.exe`
      : 'No Exalt install found. Pass --game-dir or set ROTMG_PATH.');
    return 1;
  }
  try {
    if (options.command === 'install-helper') {
      const result = installHelper(gameDir, options.helper);
      log.info('Helper', `${result.status} at ${result.target}${result.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
      return 0;
    }
    if (options.command === 'uninstall-helper') {
      const status = uninstallHelper(gameDir);
      if (!options.quiet) log.info('Helper', `${status} (${gameDir})`);
      return 0;
    }
    return await runProxy(options, gameDir);
  } catch (error) {
    log.error('RealmTool', (error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
