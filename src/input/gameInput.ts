import type { ProcessIdentity } from '../routing/tcpProcessIdentity.ts';

export interface ScreenRect { left: number; top: number; right: number; bottom: number }
export interface GameWindow { handle: unknown; minimized: boolean; client: ScreenRect }
export interface GameInputSource {
  identify(remotePort: number): ProcessIdentity | null;
  findGameWindow(pid: number): GameWindow | null;
  cursor(): { x: number; y: number } | null;
  post(handle: unknown, message: number, wParam: number, lParam: number): boolean;
}
export type PulseResult =
  | { ok: true; minimized: boolean }
  | { ok: false; reason: 'unavailable' | 'no-process' | 'process-changed' | 'no-window' | 'cursor-over-game-ui' | 'post-failed' };

export const PULSE_GAP_MS = 32;
const WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, MK_LBUTTON = 1;

/** Central half of the client area in both directions: the character and play field (P4-2). */
export function insideSafeBox(client: ScreenRect, cursor: { x: number; y: number }): boolean {
  const width = client.right - client.left, height = client.bottom - client.top;
  return cursor.x >= client.left + width / 4 && cursor.x <= client.right - width / 4
    && cursor.y >= client.top + height / 4 && cursor.y <= client.bottom - height / 4;
}

function insideClient(client: ScreenRect, cursor: { x: number; y: number }): boolean {
  return cursor.x >= client.left && cursor.x < client.right && cursor.y >= client.top && cursor.y < client.bottom;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function pulseGameWindow(window: GameWindow, source: GameInputSource,
  wait: (ms: number) => Promise<void> = sleep): Promise<PulseResult> {
  // The game aims at the real cursor (lParam is ignored), so only click where no UI can be hit.
  const cursor = source.cursor();
  if (!cursor || (insideClient(window.client, cursor) && !insideSafeBox(window.client, cursor))) {
    return { ok: false, reason: 'cursor-over-game-ui' };
  }
  if (!source.post(window.handle, WM_LBUTTONDOWN, MK_LBUTTON, 1)) return { ok: false, reason: 'post-failed' };
  await wait(PULSE_GAP_MS);
  // Always release what was pressed, whatever happened during the gap.
  if (!source.post(window.handle, WM_LBUTTONUP, 0, 1)) return { ok: false, reason: 'post-failed' };
  return { ok: true, minimized: window.minimized };
}
