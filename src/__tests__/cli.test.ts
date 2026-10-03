import { describe, expect, it } from 'vitest';
import { parseCli } from '../cli.ts';
import { DEFAULT_HELPER_PATH } from '../game/helperInstaller.ts';

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
});
