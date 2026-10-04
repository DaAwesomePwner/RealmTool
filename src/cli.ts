import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BUILTIN_PLUGINS } from '../plugins/index.ts';
import { appDataDir, ProfileStore } from './config/store.ts';
import { findExaltDirs, isExaltDir } from './game/exaltFinder.ts';
import { DEFAULT_HELPER_PATH, installHelper, uninstallHelper } from './game/helperInstaller.ts';
import { describeLaunchTarget, findLaunchTarget, openLaunchTarget, type LaunchTarget } from './game/gameLauncher.ts';
import { GAME_PORT } from './protocol/constants.ts';
import type { PluginDefinition } from './plugins/api.ts';
import { PluginHost } from './plugins/host.ts';
import { createFactory, loadSchema } from './protocol/schema.ts';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles } from './routing/targetResolver.ts';
import { tcpOwnerSourceError } from './routing/tcpProcessIdentity.ts';
import { ProxyHost, type ProxyHostOptions } from './transport/host.ts';
import { log } from './util/log.ts';

/** The checkout whose node_modules must hold koffi. */
const REPO_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

const COMMANDS = ['start', 'find-game', 'install-helper', 'uninstall-helper', 'config-path', 'help'] as const;
type Command = typeof COMMANDS[number];

export interface CliOptions {
  command: Command;
  gameDir?: string;
  helper: string;
  fallback?: string;
  launch: boolean;
  launcher?: string;
}

export const HELP = `Usage: realmtool <command> [options]

Commands:
  start              Start the proxy, install the helper and open the RotMG Exalt Launcher (Ctrl+C to stop)
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
  -h, --help         Show this help
`;

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
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals.length > 1) throw new Error(`Unexpected argument "${positionals[1]}". Run "realmtool help".`);
  const requested = values.help ? 'help' : (positionals[0] ?? 'help');
  if (!(COMMANDS as readonly string[]).includes(requested)) throw new Error(`Unknown command "${requested}". Run "realmtool help".`);
  if (values['game-dir'] !== undefined && !values['game-dir'].trim()) throw new Error('--game-dir must not be empty');
  const launcher = values.launcher?.trim();
  if (launcher === '') throw new Error('--launcher must not be empty');
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
  createHost(options: ProxyHostOptions): Pick<ProxyHost, 'on' | 'off' | 'start' | 'stop' | 'setInterest' | 'forward' | 'inject'>;
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
  // Without the TCP owner lookup no connection can be matched to the helper's target, so
  // the game would hang on the loading screen. Stop before touching the game folder.
  const nativeError = deps.nativeModuleError();
  if (nativeError) {
    if (!options.fallback) {
      log.error('RealmTool', `RealmTool can't load its native module (koffi): run "npm install" in ${REPO_DIR} and try again`);
      return 1;
    }
    log.warn('Routing', `Native module unavailable; new connections will use the fallback server ${options.fallback}`);
  }

  const stale = removeStaleTargetFiles();
  if (stale) log.info('Helper', `Removed ${stale} stale target file(s)`);

  const schema = loadSchema();
  const factory = createFactory(schema);
  const host = deps.createHost({
    schema,
    listenPort: GAME_PORT,
    fallbackDestination: options.fallback ? { host: options.fallback, port: GAME_PORT } : null,
    resolveTarget: createTargetResolver({ proxyPort: GAME_PORT }),
  });
  let dispose: (() => void) | undefined;
  let plugins: PluginHost | undefined;
  try {
    plugins = new PluginHost({ proxy: host, factory, definitions: deps.plugins, profile: new ProfileStore({ dir: deps.profileDir() }) });
    plugins.start();
    log.info('Plugins', `Loaded ${plugins.loaded().join(', ') || 'no plugins'}`);

    host.on('session', ({ id, remotePort }) => log.info('Proxy', `Game connected (${id.slice(0, 8)}, port ${remotePort})`));
    host.on('routed', ({ id, host: server, port, restored }) =>
      log.info('Proxy', `${id.slice(0, 8)} → ${server}:${port}${restored ? ' (transfer)' : ''}`));
    host.on('closed', ({ id, by }) => log.info('Proxy', `${id.slice(0, 8)} closed by ${by}`));
    host.on('diagnostic', ({ id, message }) => log.warn('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));
    host.on('fault', ({ id, message }) => log.error('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));

    let shutdownRequested = false;
    let finish!: (code: number) => void;
    const finished = new Promise<number>(resolve => { finish = resolve; });
    host.on('exit', ({ code, expected }) => {
      if (!expected) {
        shutdownRequested = true;
        log.error('Proxy', `Network worker stopped unexpectedly (code ${code})`);
        finish(1);
      }
    });
    dispose = deps.onShutdown(() => {
      shutdownRequested = true;
      finish(0);
    });

    let port: number;
    try {
      port = await host.start();
    } catch (error) {
      log.error('Proxy', (error as Error).message);
      return 1;
    }
    log.info('Proxy', `Listening on 127.0.0.1:${port}`);
    if (shutdownRequested) return await finished;
    try {
      const installed = installHelper(gameDir, options.helper);
      log.info('Helper', `${installed.status} at ${installed.target}${installed.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
    } catch (error) {
      log.error('Helper', (error as Error).message);
      return 1;
    }
    if (options.launch && !shutdownRequested) {
      let launchFailed = false;
      const onError = (error: Error) => {
        launchFailed = true;
        log.error('Game', `Could not open the launcher: ${error.message}`);
        finish(1);
      };
      try {
        const target = deps.launch(onError, options.launcher);
        if (launchFailed) return 1;
        if (target) {
          log.info('Game', `Opened ${describeLaunchTarget(target)}. Click Play; RealmTool routes the game automatically.`);
        } else {
          log.warn('Game', 'Could not find the RotMG Exalt Launcher or Steam. Start the game the way you normally do; RealmTool is ready.');
        }
      } catch (error) {
        onError(error as Error);
        return 1;
      }
    } else if (!options.launch) {
      log.info('Game', 'Start the game from your launcher; RealmTool is ready.');
    }
    return await finished;
  } finally {
    try {
      log.info('Proxy', 'Stopping…');
      plugins?.stop();
      await host.stop();
    } finally {
      dispose?.();
    }
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
      log.info('Helper', `${uninstallHelper(gameDir)} (${gameDir})`);
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
