import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCli, runProxy, type CliOptions, type RunDeps } from '../cli.ts';
import { DEFAULT_HELPER_PATH } from '../game/helperInstaller.ts';
import { log } from '../util/log.ts';

describe('parseCli', () => {
  it('defaults to help', () => {
    expect(parseCli([]).command).toBe('help');
    expect(parseCli(['start', '--help']).command).toBe('help');
  });

  it('parses start options', () => {
    expect(parseCli(['start', '--game-dir', 'D:\\Exalt', '--no-launch', '--fallback', '54.86.47.176', '--port', '2051']))
      .toEqual({ command: 'start', gameDir: 'D:\\Exalt', helper: DEFAULT_HELPER_PATH, fallback: '54.86.47.176', launch: false, port: 2051 });
    expect(parseCli(['start'])).toMatchObject({ launch: true, port: 2050, fallback: undefined });
  });

  it('rejects bad input with a clear message', () => {
    expect(() => parseCli(['launch'])).toThrow('Unknown command "launch"');
    expect(() => parseCli(['start', '--port', '99999'])).toThrow('--port');
    expect(() => parseCli(['start', '--fallback', 'usw.example.com'])).toThrow('--fallback');
  });

  it('rejects port zero', () => {
    expect(() => parseCli(['start', '--port', '0'])).toThrow('--port must be 1-65535, got 0');
  });

  it.each(['', '   '])('rejects an empty game directory (%j)', value => {
    expect(() => parseCli(['start', `--game-dir=${value}`])).toThrow('--game-dir must not be empty');
  });

  it('stores the normalized fallback address', () => {
    expect(parseCli(['start', '--fallback', ' 54.86.47.176 ']).fallback).toBe('54.86.47.176');
  });

  it('rejects extra positional arguments', () => {
    expect(() => parseCli(['start', 'extra'])).toThrow('Unexpected argument "extra". Run "realmtool help".');
  });
});

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

  beforeEach(() => {
    root = mkdtempSync(join(tempBase, 'realmtool-cli-'));
    gameDir = join(root, 'game');
    mkdirSync(gameDir);
    const helper = join(root, 'helper.dll');
    writeFileSync(helper, 'RealmTool-Helper/1');
    // Keep stale-target cleanup confined to this fixture as well.
    for (const name of ['TMP', 'TEMP', 'TMPDIR']) vi.stubEnv(name, root);
    writeFileSync(join(root, 'realmtool_target_123.txt'), '54.86.47.176');
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    options = { command: 'start', helper, launch: true, port: 2050 };
    dispose = vi.fn();
    start = vi.fn(async () => {
      expect(deps.onShutdown).toHaveBeenCalledOnce();
      return 2050;
    });
    stop = vi.fn(async () => {});
    const host: ReturnType<RunDeps['createHost']> = {
      on: vi.fn<ReturnType<RunDeps['createHost']>['on']>().mockReturnThis(),
      start,
      stop,
    };
    deps = {
      createHost: vi.fn(() => {
        expect(readFileSync(join(gameDir, 'winhttp.dll'), 'utf8')).toBe('RealmTool-Helper/1');
        expect(existsSync(join(root, 'realmtool_target_123.txt'))).toBe(false);
        return host;
      }),
      launch: vi.fn(() => { queueMicrotask(() => shutdown()); return 123; }),
      onShutdown: vi.fn(handler => { shutdown = handler; return dispose; }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dirname(root) !== tempBase || !basename(root).startsWith('realmtool-cli-')) {
      throw new Error('Unexpected temporary fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('returns zero on shutdown and stops the host once', async () => {
    expect(await runProxy(options, gameDir, deps)).toBe(0);
    expect(start).toHaveBeenCalledOnce();
    expect(deps.launch).toHaveBeenCalledWith(gameDir, expect.any(Function));
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the host when launch throws synchronously', async () => {
    deps.launch = vi.fn(() => { throw new Error('spawn failed'); });
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Game', 'Could not start RotMG Exalt.exe: spawn failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the host when launch reports an asynchronous error', async () => {
    deps.launch = vi.fn((_gameDir, onError) => {
      setImmediate(() => onError(new Error('async spawn failed')));
      return undefined;
    });
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Game', 'Could not start RotMG Exalt.exe: async spawn failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the host without launching when start rejects', async () => {
    start.mockRejectedValue(new Error('listen failed'));
    expect(await runProxy(options, gameDir, deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith('Proxy', 'listen failed');
    expect(deps.launch).not.toHaveBeenCalled();
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
