import { expect, it } from 'vitest';
import { insideSafeBox, pulseGameWindow, type GameInputSource, type GameWindow } from '../gameInput.ts';

function fake(overrides: Partial<GameInputSource> = {}) {
  const posts: Array<[number, number, number]> = [];
  const source: GameInputSource = {
    identify: () => ({ pid: 10, processStartTime: '1' }),
    findGameWindow: () => window,
    cursor: () => ({ x: 5000, y: 5000 }),
    post: (_h, m, w, l) => { posts.push([m, w, l]); return true; },
    ...overrides,
  };
  return { source, posts };
}
const window: GameWindow = { handle: {}, minimized: false, client: { left: 0, top: 0, right: 3440, bottom: 1440 } };
const noWait = async () => {};

it('click pulse posts left down/up when the cursor is outside the game window', async () => {
  const { source, posts } = fake();
  expect(await pulseGameWindow(window, source, noWait)).toEqual({ ok: true, minimized: false });
  expect(posts).toEqual([[0x201, 1, 1], [0x202, 0, 1]]);
});

it('click pulse is skipped when the cursor is over game UI, and allowed in the central safe box', async () => {
  const edge = fake({ cursor: () => ({ x: 3400, y: 700 }) });
  expect(await pulseGameWindow(window, edge.source, noWait)).toEqual({ ok: false, reason: 'cursor-over-game-ui' });
  expect(edge.posts).toEqual([]);
  const center = fake({ cursor: () => ({ x: 1720, y: 720 }) });
  expect((await pulseGameWindow(window, center.source, noWait)).ok).toBe(true);
  expect(insideSafeBox(window.client, { x: 860, y: 360 })).toBe(true);    // exactly at 25%/25%
  expect(insideSafeBox(window.client, { x: 859, y: 360 })).toBe(false);
});

it('click pulse with an unknown cursor position is skipped', async () => {
  const { source, posts } = fake({ cursor: () => null });
  expect(await pulseGameWindow(window, source, noWait)).toEqual({ ok: false, reason: 'cursor-over-game-ui' });
  expect(posts).toEqual([]);
});

it('a failed down post sends nothing else; a failed up post still reports post-failed', async () => {
  const downFails = fake({ post: () => false });
  expect(await pulseGameWindow(window, downFails.source, noWait)).toEqual({ ok: false, reason: 'post-failed' });
  let n = 0;
  const upFails = fake({ post: () => ++n === 1 });
  expect(await pulseGameWindow(window, upFails.source, noWait)).toEqual({ ok: false, reason: 'post-failed' });
  expect(n).toBe(2);   // the up was attempted after a successful down
});

it('reports minimized windows but still pulses (P4-4)', async () => {
  const { source } = fake();
  expect(await pulseGameWindow({ ...window, minimized: true }, source, noWait)).toMatchObject({ ok: true, minimized: true });
});

it('waits PULSE_GAP_MS between down and up', async () => {
  const { source } = fake();
  const waits: number[] = [];
  await pulseGameWindow(window, source, async ms => { waits.push(ms); });
  expect(waits).toEqual([32]);
});

it('releases the same window after caller state changes during the gap', async () => {
  const { source, posts } = fake();
  const handles: unknown[] = [];
  const post = source.post;
  source.post = (handle, ...args) => { handles.push(handle); return post(handle, ...args); };
  let release!: () => void;
  const gap = new Promise<void>(resolve => { release = resolve; });
  const pulse = pulseGameWindow(window, source, () => gap);
  expect(posts).toEqual([[0x201, 1, 1]]);
  // A disconnected/disabled caller may no longer resolve a process or window.
  source.identify = () => null;
  source.findGameWindow = () => null;
  source.cursor = () => null;
  release();
  expect(await pulse).toEqual({ ok: true, minimized: false });
  expect(posts).toEqual([[0x201, 1, 1], [0x202, 0, 1]]);
  expect(handles).toEqual([window.handle, window.handle]);
});
