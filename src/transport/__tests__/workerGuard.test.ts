import { expect, it, vi } from 'vitest';
import { describeError } from '../../util/describeError.ts';
import { guardWorkerCall, tickSessions } from '../workerGuard.ts';
import type { WorkerEvent } from '../messages.ts';

it.each([null, undefined, 'failure', new Error('failure')])(
  'keeps later sessions ticking after a session throws %s', error => {
    const events: WorkerEvent[] = [];
    const tick = vi.fn();
    expect(() => tickSessions([{ id: 'broken', tick() { throw error; } }, { id: 'healthy', tick }], 42,
      event => events.push(event))).not.toThrow();
    expect(tick).toHaveBeenCalledExactlyOnceWith(42);
    expect(events).toEqual([{ type: 'diagnostic', id: 'broken', message: expect.stringContaining('Session tick failed:') }]);
  });

it('contains a failed message callback and accepts the next callback', () => {
  const post = vi.fn();
  const next = vi.fn();
  expect(() => guardWorkerCall(post, 'Worker command module', () => { throw undefined; }, 's')).not.toThrow();
  guardWorkerCall(post, 'Worker command module', next, 's');
  expect(next).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledExactlyOnceWith({ type: 'diagnostic', id: 's', message: 'Worker command module failed: undefined' });
});

it('formats objects whose string conversion or Error message getter throws', () => {
  expect(describeError({ toString() { throw null; } })).toContain('could not describe');
  expect(describeError(Object.defineProperty(new Error(), 'message', { get() { throw undefined; } }))).toContain('could not describe');
});
