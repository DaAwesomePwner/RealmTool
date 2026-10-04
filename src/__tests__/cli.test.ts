import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HELP, main, parseCli, resolveGameDir, runProxy, type CliOptions, type RunDeps } from '../cli.ts';
import { appDataDir, ProfileStore } from '../config/store.ts';
import { PLUGIN_API_VERSION, type PluginContext } from '../plugins/api.ts';
import { FakeProxy } from '../testing/pluginHarness.ts';
import { DEFAULT_HELPER_PATH } from '../game/helperInstaller.ts';
import { log } from '../util/log.ts';

describe('parseCli', () => {
  it('defaults to help', () => {
    expect(parseCli([]).command).toBe('help');
    expect(parseCli(['start', '--help']).command).toBe('help');
  });

  it('parses config-path and documents it in help', () => {
    expect(parseCli(['config-path']).command).toBe('config-path');
    expect(HELP).toContain('config-path        Print the settings profile location');
  });

  it('parses start options', () => {
    expect(parseCli(['start', '--game-dir', 'D:\\Exalt', '--no-launch', '--fallback', '54.86.47.176']))
      .toEqual({ command: 'start', gameDir: 'D:\\Exalt', helper: DEFAULT_HELPER_PATH, fallback: '54.86.47.176', launch: false });
    expect(parseCli(['start'])).toMatchObject({ launch: true, fallback: undefined });
  });

  it('rejects bad input with a clear message', () => {
    expect(() => parseCli(['launch'])).toThrow('Unknown command "launch"');
    expect(() => parseCli(['start', '--fallback', 'usw.example.com'])).toThrow('--fallback');
  });

  it('rejects custom ports and omits the option from help', () => {
    expect(() => parseCli(['start', '--port', '2051'])).toThrow("Unknown option '--port'");
    expect(HELP).not.toContain('--port');
  });

  it.each(['', '   '])('rejects an empty game directory (%j)', value => {
    expect(() => parseCli(['start', `--game-dir=${value}`])).toThrow('--game-dir must not be empty');
  });

  it('stores the normalized fallback address', () => {
    expect(parseCli(['start', '--fallback', ' 54.86.47.176 ']).fallback).toBe('54.86.47.176');
  });

  it('trims an explicit launcher path', () => {
    expect(parseCli(['start', '--launcher', ' D:\\Launcher.exe ']).launcher).toBe('D:\\Launcher.exe');
  });

  it.each(['', '   '])('rejects an empty launcher (%j)', value => {
    expect(() => parseCli(['start', `--launcher=${value}`])).toThrow('--launcher must not be empty');
  });

  it('rejects extra positional arguments', () => {
    expect(() => parseCli(['start', 'extra'])).toThrow('Unexpected argument "extra". Run "realmtool help".');
  });
});

class FakeHost extends FakeProxy {
  async start(): Promise<number> { return 2050; }
  async stop(): Promise<void> {}
}

describe('runProxy', () => {
  const tempBase = tmpdir();
  let root: string;
  let gameDir: string;
  let options: CliOptions;
  let shutdown: () => void;
  let deps: RunDeps;
  let start: ReturnType<typeof vi.fn<() => Promise<number>>>;
  let stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let dispose: ReturnType<typeof vi.fn<() => void>>;
  let host: FakeHost;
  let removeSink: () => void;

  beforeEach(() => {
    root = mkdtempSync(join(tempBase, 'realmtool-cli-'));
    gameDir = join(root, 'game');
    mkdirSync(gameDir);
    const helper = join(root, 'helper.dll');
    writeFileSync(helper, 'RealmTool-Helper/1');
    // Keep stale-target cleanup confined to this fixture as well.
    for (const name of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(name, root);
    writeFileSync(join(root, 'realmtool_target_123.txt'), '54.86.47.176');
    log.setConsole(false);
    removeSink = log.addSink(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    options = { command: 'start', helper, launch: true };
    dispose = vi.fn();
    start = vi.fn(async () => {
      expect(deps.onShutdown).toHaveBeenCalledOnce();
      expect(existsSync(join(gameDir, 'winhttp.dll'))).toBe(false);
      return 2050;
    });
    stop = vi.fn(async () => {});
    host = Object.assign(new FakeHost(), { start, stop });
    deps = {
      plugins: [],
      profileDir: () => join(root, 'config'),
      createHost: vi.fn(hostOptions => {
        expect(hostOptions.listenPort).toBe(2050);
        expect(existsSync(join(gameDir, 'winhttp.dll'))).toBe(false);
        expect(existsSync(join(root, 'realmtool_target_123.txt'))).toBe(false);
        // EventEmitter's fluent methods retain ProxyHost's return type in Pick.
        return host as unknown as ReturnType<RunDeps['createHost']>;
      }),
      launch: vi.fn(() => {
        expect(start).toHaveBeenCalledOnce();
        expect(readFileSync(join(gameDir, 'winhttp.dll'), 'utf8')).toBe('RealmTool-Helper/1');
        queueMicrotask(() => shutdown());
        return { kind: 'deca' as const, exe: 'launcher.exe' };
      }),
      nativeModuleError: vi.fn(() => null),
      onShutdown: vi.fn(handler => { shutdown = handler; return dispose; }),
    };
  });

  afterEach(() => {
    removeSink();
    log.setConsole(true);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dirname(root) !== tempBase || !basename(root).startsWith('realmtool-cli-')) {
      throw new Error('Unexpected temporary fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  });

  function registerTestPlugin(cleanup: () => void = () => {}): () => PluginContext {
    let context!: PluginContext;
    deps.plugins = [{
      id: 'cli-test', name: 'CLI Test', apiVersion: PLUGIN_API_VERSION, capabilities: ['packets'],
      register(ctx) {
        context = ctx;
        ctx.hookPacket('TEXT', () => {});
        ctx.registerSetting('message', { label: 'Message', type: 'text', value: 'default' });
        ctx.registerCleanup(cleanup);
      },
    }];
    return () => context;
  }

  it('prints config-path without requiring a game directory or creating a profile', async () => {
    vi.stubEnv('APPDATA', root);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = new ProfileStore({ dir: appDataDir() }).path;
    expect(await main(['config-path', '--game-dir', join(root, 'missing-game')])).toBe(0);
    expect(output).toHaveBeenCalledExactlyOnceWith(path);
    expect(existsSync(path)).toBe(false);
    expect(deps.createHost).not.toHaveBeenCalled();
  });

  it('sets TEXT verdict interest before start resolves', async () => {
    registerTestPlugin();
    const setInterest = vi.spyOn(host, 'setInterest');
    start.mockImplementation(async () => {
      expect(setInterest).toHaveBeenCalledOnce();
      expect(host.interest.verdict?.server).toContain('TEXT');
      return 2050;
    });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(log.info).toHaveBeenCalledWith('Plugins', 'Loaded cli-test');
    expect(existsSync(new ProfileStore({ dir: deps.profileDir() }).path)).toBe(false);
  });

  it('flushes a setting changed during the run on normal shutdown', async () => {
    const context = registerTestPlugin();
    const path = new ProfileStore({ dir: deps.profileDir() }).path;
    deps.launch = vi.fn(() => {
      expect(context().updateSetting('message', 'saved on shutdown')).toBe(true);
      expect(existsSync(path)).toBe(false);
      shutdown();
      return null;
    });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).plugins['cli-test'].settings.message)
      .toBe('saved on shutdown');
  });

  it('runs plugin cleanup before stopping the proxy host', async () => {
    const calls: string[] = [];
    registerTestPlugin(() => { calls.push('plugin cleanup'); });
    stop.mockImplementation(async () => { calls.push('host stop'); });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(calls).toEqual(['plugin cleanup', 'host stop']);
  });

  it('returns zero on shutdown and stops the host once', async () => {
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(deps.launch).toHaveBeenCalledWith(expect.any(Function), undefined);
    expect(log.info).toHaveBeenCalledWith('Game', 'Opened RotMG Exalt Launcher (launcher.exe). Click Play; RealmTool routes the game automatically.');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('refuses to start when the native module cannot load and no fallback is set', async () => {
    deps.nativeModuleError = vi.fn(() => "TCP owner lookup unavailable (koffi/Win32 load failed): Cannot find module 'koffi'");
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('RealmTool', expect.stringMatching(
      /^RealmTool can't load its native module \(koffi\): run "npm install" in .+ and try again$/));
    const message = vi.mocked(log.error).mock.calls[0][1];
    expect(existsSync(join(message.match(/in (.+) and try again/)![1], 'package.json'))).toBe(true);
    expect(deps.createHost).not.toHaveBeenCalled();
    expect(deps.launch).not.toHaveBeenCalled();
    expect(existsSync(join(gameDir, 'winhttp.dll'))).toBe(false);
  });

  it('starts with a warning when the native module cannot load but --fallback is set', async () => {
    deps.nativeModuleError = vi.fn(() => 'TCP owner lookup unavailable');
    options.fallback = '54.86.47.176';
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(log.warn).toHaveBeenCalledWith('Routing', expect.stringContaining('fallback server 54.86.47.176'));
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(deps.createHost).mock.calls[0][0].fallbackDestination).toEqual({ host: '54.86.47.176', port: 2050 });
    expect(deps.launch).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('resolves a relative game directory to an absolute path', () => {
    writeFileSync(join(gameDir, 'RotMG Exalt.exe'), 'fixture');
    const resolved = resolveGameDir({ ...options, gameDir: relative(process.cwd(), gameDir) });
    expect(resolved).toBe(gameDir);
    expect(isAbsolute(resolved!)).toBe(true);
  });

  it('stops the listening host and reports an install failure', async () => {
    options.helper = join(root, 'missing-helper.dll');
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(start).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith('Helper', expect.stringContaining('Helper DLL not found'));
    expect(deps.launch).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns one and cleans up when the worker exits unexpectedly', async () => {
    deps.launch = vi.fn(() => {
      setImmediate(() => host.emit('exit', { code: 7, expected: false }));
      return { kind: 'deca' as const, exe: 'launcher.exe' };
    });
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Proxy', 'Network worker stopped unexpectedly (code 7)');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the host when launch throws synchronously', async () => {
    deps.launch = vi.fn(() => { throw new Error('spawn failed'); });
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Game', 'Could not open the launcher: spawn failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the host when launch reports an asynchronous error', async () => {
    deps.launch = vi.fn(onError => {
      setImmediate(() => onError(new Error('async spawn failed')));
      return { kind: 'deca' as const, exe: 'launcher.exe' };
    });
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Game', 'Could not open the launcher: async spawn failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('logs only failure when launch calls onError synchronously and returns a target', async () => {
    vi.mocked(log.info).mockRestore();
    vi.mocked(log.warn).mockRestore();
    vi.mocked(log.error).mockRestore();
    log.setConsole(false);
    const sink = vi.fn();
    const removeSink = log.addSink(sink);
    try {
      deps.launch = vi.fn(onError => {
        onError(new Error('sync spawn failed'));
        return { kind: 'deca' as const, exe: 'launcher.exe' };
      });
      expect(await runProxy(options, gameDir, deps)).toBe(1);
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        level: 'error', module: 'Game', message: 'Could not open the launcher: sync spawn failed',
      }));
      expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Opened ') }));
      expect(stop).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      removeSink();
      log.setConsole(true);
    }
  });

  it('stops the host without launching when start rejects', async () => {
    start.mockRejectedValue(new Error('listen failed'));
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Proxy', 'listen failed');
    expect(existsSync(join(gameDir, 'winhttp.dll'))).toBe(false);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('passes the explicit launcher override to launch', async () => {
    options.launcher = 'D:\\Launcher.exe';
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(deps.launch).toHaveBeenCalledWith(expect.any(Function), options.launcher);
  });

  it('keeps running until shutdown when no launcher is found', async () => {
    deps.launch = vi.fn(() => {
      setImmediate(() => {
        expect(stop).not.toHaveBeenCalled();
        shutdown();
      });
      return null;
    });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(log.warn).toHaveBeenCalledWith('Game', 'Could not find the RotMG Exalt Launcher or Steam. Start the game the way you normally do; RealmTool is ready.');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not launch with --no-launch', async () => {
    options.launch = parseCli(['start', '--no-launch']).launch;
    start.mockImplementation(async () => { setImmediate(() => shutdown()); return 2050; });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('Game', 'Start the game from your launcher; RealmTool is ready.');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('handles shutdown during startup without launching', async () => {
    start.mockImplementation(async () => { shutdown(); return 2050; });
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(deps.launch).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes shutdown handlers even when stop rejects', async () => {
    stop.mockRejectedValue(new Error('stop failed'));
    await expect(runProxy(options, gameDir, deps)).rejects.toThrow('stop failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
