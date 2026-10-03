import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findExaltDirs, isExaltDir } from './game/exaltFinder.ts';
import { DEFAULT_HELPER_PATH, installHelper, uninstallHelper } from './game/helperInstaller.ts';
import { launchExalt } from './game/launcher.ts';
import { GAME_PORT } from './protocol/constants.ts';
import { loadSchema } from './protocol/schema.ts';
import { createTargetResolver, parseTargetFile, removeStaleTargetFiles } from './routing/targetResolver.ts';
import { ProxyHost, type ProxyHostOptions } from './transport/host.ts';
import { log } from './util/log.ts';

const COMMANDS = ['start', 'find-game', 'install-helper', 'uninstall-helper', 'help'] as const;
type Command = typeof COMMANDS[number];

export interface CliOptions {
  command: Command;
  gameDir?: string;
  helper: string;
  fallback?: string;
  launch: boolean;
  port: number;
}

export const HELP = `Usage: realmtool <command> [options]

Commands:
  start              Install the helper, launch Exalt and run the proxy (Ctrl+C to stop)
  find-game          List detected Exalt install folders
  install-helper     Copy the helper DLL into the game folder
  uninstall-helper   Remove the helper DLL and restore any backed-up winhttp.dll

Options:
  --game-dir <dir>   Exalt "Production" folder (default: auto-detect)
  --helper <file>    Helper DLL to install (default: native/helper/bin/winhttp.dll)
  --fallback <ip>    Server to use when the helper recorded none
  --no-launch        start: don't launch the game
  --port <n>         Listen port (default ${GAME_PORT})
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
      'no-launch': { type: 'boolean', default: false },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (positionals.length > 1) throw new Error(`Unexpected argument "${positionals[1]}". Run "realmtool help".`);
  const requested = values.help ? 'help' : (positionals[0] ?? 'help');
  if (!(COMMANDS as readonly string[]).includes(requested)) throw new Error(`Unknown command "${requested}". Run "realmtool help".`);
  const port = values.port === undefined ? GAME_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be 1-65535, got ${values.port}`);
  if (values['game-dir'] !== undefined && !values['game-dir'].trim()) throw new Error('--game-dir must not be empty');
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
    port,
  };
}

function resolveGameDir(options: CliOptions): string | null {
  if (options.gameDir) return isExaltDir(options.gameDir) ? options.gameDir : null;
  return findExaltDirs()[0] ?? null;
}

export interface RunDeps {
  createHost(options: ProxyHostOptions): Pick<ProxyHost, 'on' | 'start' | 'stop'>;
  launch(gameDir: string, onError: (error: Error) => void): number | undefined;
  /** Resolves when the user asks to stop (SIGINT/SIGTERM). Returns a disposer that removes the handlers. */
  onShutdown(handler: () => void): () => void;
}

const defaultRunDeps: RunDeps = {
  createHost: options => new ProxyHost(options),
  launch: (gameDir, onError) => launchExalt(gameDir, [], onError),
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
  const installed = installHelper(gameDir, options.helper);
  log.info('Helper', `${installed.status} at ${installed.target}${installed.backedUp ? ' (previous winhttp.dll backed up)' : ''}`);
  const stale = removeStaleTargetFiles();
  if (stale) log.info('Helper', `Removed ${stale} stale target file(s)`);

  const host = deps.createHost({
    schema: loadSchema(),
    listenPort: options.port,
    fallbackDestination: options.fallback ? { host: options.fallback, port: GAME_PORT } : null,
    resolveTarget: createTargetResolver({ proxyPort: options.port }),
  });
  let dispose: (() => void) | undefined;
  try {
    host.on('session', ({ id, remotePort }) => log.info('Proxy', `Game connected (${id.slice(0, 8)}, port ${remotePort})`));
    host.on('routed', ({ id, host: server, port, restored }) =>
      log.info('Proxy', `${id.slice(0, 8)} → ${server}:${port}${restored ? ' (transfer)' : ''}`));
    host.on('closed', ({ id, by }) => log.info('Proxy', `${id.slice(0, 8)} closed by ${by}`));
    host.on('diagnostic', ({ id, message }) => log.warn('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));
    host.on('fault', ({ id, message }) => log.error('Proxy', `${id ? `${id.slice(0, 8)}: ` : ''}${message}`));

    let shutdownRequested = false;
    let finish!: (code: number) => void;
    const finished = new Promise<number>(resolve => { finish = resolve; });
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
    if (options.launch && !shutdownRequested) {
      const onError = (error: Error) => {
        log.error('Game', `Could not start RotMG Exalt.exe: ${error.message}`);
        finish(1);
      };
      try {
        const pid = deps.launch(gameDir, onError);
        log.info('Game', `Launched Exalt${pid ? ` (pid ${pid})` : ''}`);
      } catch (error) {
        onError(error as Error);
        return 1;
      }
    }
    return await finished;
  } finally {
    try {
      log.info('Proxy', 'Stopping…');
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
