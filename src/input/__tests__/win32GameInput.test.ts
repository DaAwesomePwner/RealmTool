import { afterEach, expect, it, vi } from 'vitest';
import { createWin32Source, win32GameInputError, win32GameInputSource, type Win32Bindings } from '../win32GameInput.ts';
import { setTcpOwnerSource } from '../../routing/tcpProcessIdentity.ts';
import { GAME_PORT } from '../../protocol/constants.ts';

function fake(windows: Array<{ pid: number; visible?: boolean }>) {
  const bindings: Win32Bindings = {
    FindWindowExW: vi.fn((_parent, previous, cls, title) => {
      expect(cls).toBe('UnityWndClass');
      expect(title).toBeNull();
      return windows[previous === null ? 0 : windows.indexOf(previous as typeof windows[number]) + 1] ?? null;
    }),
    GetWindowThreadProcessId: (handle, pid) => { pid[0] = (handle as typeof windows[number]).pid; return 1; },
    IsWindowVisible: handle => (handle as typeof windows[number]).visible === false ? 0 : 1,
    IsIconic: () => 1,
    GetClientRect: (_handle, rect) => { Object.assign(rect, { left: 0, top: 0, right: 800, bottom: 600 }); return 1; },
    ClientToScreen: (_handle, point) => { point.x += 100; point.y += 200; return 1; },
    GetCursorPos: point => { Object.assign(point, { x: 500, y: 600 }); return 1; },
    PostMessageW: vi.fn(() => 1),
  };
  return bindings;
}

afterEach(() => setTcpOwnerSource(undefined));

it('selects only the matching PID and translates its client rect to screen coordinates', () => {
  const windows = [{ pid: 10 }, { pid: 20 }];
  const source = createWin32Source(fake(windows));
  expect(source.findGameWindow(20)).toEqual({ handle: windows[1], minimized: true,
    client: { left: 100, top: 200, right: 900, bottom: 800 } });
  expect(source.findGameWindow(30)).toBeNull();
});

it('rejects multiple matching windows and ignores invisible windows', () => {
  expect(createWin32Source(fake([{ pid: 10 }, { pid: 10 }])).findGameWindow(10)).toBeNull();
  const windows = [{ pid: 10, visible: false }, { pid: 10 }];
  expect(createWin32Source(fake(windows)).findGameWindow(10)?.handle).toBe(windows[1]);
  expect(createWin32Source(fake([windows[0]])).findGameWindow(10)).toBeNull();
});

it('reads cursor and posts only to the supplied handle', () => {
  const bindings = fake([]), source = createWin32Source(bindings), handle = {};
  expect(source.cursor()).toEqual({ x: 500, y: 600 });
  expect(source.post(handle, 0x201, 1, 1)).toBe(true);
  expect(bindings.PostMessageW).toHaveBeenCalledExactlyOnceWith(handle, 0x201, 1, 1);
});

it.each(['FindWindowExW', 'GetWindowThreadProcessId', 'IsWindowVisible', 'IsIconic', 'GetClientRect', 'ClientToScreen'] as const)(
  'contains errors from %s', name => {
    const bindings = fake([{ pid: 10 }]);
    bindings[name] = () => { throw new Error('native failure'); };
    expect(createWin32Source(bindings).findGameWindow(10)).toBeNull();
  });

it.each(['GetWindowThreadProcessId', 'GetClientRect', 'ClientToScreen'] as const)(
  'rejects failed %s calls', name => {
    const bindings = fake([{ pid: 10 }]);
    bindings[name] = () => 0;
    expect(createWin32Source(bindings).findGameWindow(10)).toBeNull();
  });

it('contains cursor/post errors and false native results', () => {
  const bindings = fake([]), source = createWin32Source(bindings);
  bindings.GetCursorPos = () => 0;
  bindings.PostMessageW = () => 0;
  expect(source.cursor()).toBeNull();
  expect(source.post({}, 0, 0, 0)).toBe(false);
  bindings.GetCursorPos = bindings.PostMessageW = () => { throw new Error('native failure'); };
  expect(source.cursor()).toBeNull();
  expect(source.post({}, 0, 0, 0)).toBe(false);
});

it('identifies the session remote port against GAME_PORT', () => {
  setTcpOwnerSource({ tcpRows: () => [{ state: 5, localAddr: 0x0100007f, remoteAddr: 0x0100007f,
    localPort: 12345, remotePort: GAME_PORT, pid: 10 }], processCreationTime: () => 100n });
  const source = createWin32Source(fake([]));
  expect(source.identify(12345)).toEqual({ pid: 10, processStartTime: '100' });
  expect(source.identify(12346)).toBeNull();
});

it.skipIf(process.platform !== 'win32')('loads the real source without posting input', () => {
  const source = win32GameInputSource();
  expect(win32GameInputError()).toBeNull();
  expect(source).not.toBeNull();
  expect(source!.findGameWindow(process.pid)).toBeNull();
  const cursor = source!.cursor();
  if (cursor) {
    expect(Number.isFinite(cursor.x)).toBe(true);
    expect(Number.isFinite(cursor.y)).toBe(true);
  }
});
