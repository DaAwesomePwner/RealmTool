import { createRequire } from 'node:module';
import { GAME_PORT } from '../protocol/constants.ts';
import { readTcpProcessIdentity } from '../routing/tcpProcessIdentity.ts';
import type { GameInputSource, ScreenRect } from './gameInput.ts';

interface Point { x: number; y: number }

/** Raw user32 functions, injectable without loading native libraries. */
export interface Win32Bindings {
  FindWindowExW(parent: unknown, after: unknown, cls: string, title: string | null): unknown;
  GetWindowThreadProcessId(handle: unknown, pid: number[]): number;
  IsWindowVisible(handle: unknown): number;
  IsIconic(handle: unknown): number;
  GetClientRect(handle: unknown, rect: ScreenRect): number;
  ClientToScreen(handle: unknown, point: Point): number;
  GetCursorPos(point: Point): number;
  PostMessageW(handle: unknown, message: number, wParam: number, lParam: number): number;
}

export function createWin32Source(bindings: Win32Bindings): GameInputSource {
  return {
    identify(remotePort) {
      try { return readTcpProcessIdentity(remotePort, GAME_PORT); } catch { return null; }
    },
    findGameWindow(pid) {
      try {
        let previous: unknown = null;
        let match: unknown = null;
        while (true) {
          const handle = bindings.FindWindowExW(null, previous, 'UnityWndClass', null);
          if (!handle) break;
          previous = handle;
          const owner = [0];
          if (!bindings.GetWindowThreadProcessId(handle, owner)) return null;
          if (owner[0] !== pid || !bindings.IsWindowVisible(handle)) continue;
          if (match) return null;
          match = handle;
        }
        if (!match) return null;
        const rect = { left: 0, top: 0, right: 0, bottom: 0 };
        const origin = { x: 0, y: 0 };
        if (!bindings.GetClientRect(match, rect) || !bindings.ClientToScreen(match, origin)) return null;
        return { handle: match, minimized: !!bindings.IsIconic(match), client: {
          left: rect.left + origin.x, top: rect.top + origin.y,
          right: rect.right + origin.x, bottom: rect.bottom + origin.y,
        } };
      } catch { return null; }
    },
    cursor() {
      try {
        const point = { x: 0, y: 0 };
        return bindings.GetCursorPos(point) ? point : null;
      } catch { return null; }
    },
    post(handle, message, wParam, lParam) {
      try { return !!bindings.PostMessageW(handle, message, wParam, lParam); } catch { return false; }
    },
  };
}

let cachedSource: GameInputSource | null | undefined;
let loadError: string | null = null;

/** Lazily loads user32; a failed load remains unavailable for this process. */
export function win32GameInputSource(): GameInputSource | null {
  if (cachedSource !== undefined) return cachedSource;
  cachedSource = null;
  if (process.platform !== 'win32') {
    loadError = `Game-window input needs Windows (running on ${process.platform})`;
    return null;
  }
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const user32 = koffi.load('user32.dll');
    // Anonymous structs avoid global type-name collisions with other koffi users.
    const rect = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    const point = koffi.struct({ x: 'int32_t', y: 'int32_t' });
    cachedSource = createWin32Source({
      FindWindowExW: user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
      IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hwnd)'),
      IsIconic: user32.func('int __stdcall IsIconic(void *hwnd)'),
      GetClientRect: user32.func('__stdcall', 'GetClientRect', 'int', ['void *', koffi.out(koffi.pointer(rect))]),
      ClientToScreen: user32.func('__stdcall', 'ClientToScreen', 'int', ['void *', koffi.inout(koffi.pointer(point))]),
      GetCursorPos: user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(point))]),
      PostMessageW: user32.func('int __stdcall PostMessageW(void *hwnd, uint32_t msg, uintptr_t w, intptr_t l)'),
    });
  } catch (error) {
    loadError = `Game-window input unavailable (koffi/Win32 load failed): ${error instanceof Error ? error.message : String(error)}`;
    cachedSource = null;
  }
  return cachedSource;
}

export function win32GameInputError(): string | null {
  if (win32GameInputSource()) return null;
  return loadError ?? 'Game-window input unavailable';
}
