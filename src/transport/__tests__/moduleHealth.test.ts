import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ModuleFailures } from '../workerGuard.ts';
import { ProxyHost } from '../host.ts';
import { loadSchema } from '../../protocol/schema.ts';
import { MODULE_HEALTH_QUIET_MS, type WorkerEvent } from '../messages.ts';

it('reports the first failure and flushes accumulated counts after five seconds', () => {
  const events: WorkerEvent[] = [];
  const failures = new ModuleFailures('s', e => events.push(e));
  failures.record('a', 'observe', new Error('first'), 0);
  failures.record('a', 'observe', 'middle', 4000);
  failures.record('a', 'observe', 'last', 4999);
  failures.flush(4999);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(1);
  failures.flush(5000);
  expect(events.filter(e => e.type === 'moduleHealth')).toEqual([
    { type: 'moduleHealth', id: 's', moduleId: 'a', hook: 'observe', failures: 1, since: 0, lastError: 'first', at: 0 },
    { type: 'moduleHealth', id: 's', moduleId: 'a', hook: 'observe', failures: 2, since: 4000, lastError: 'last', at: 4999 },
  ]);
  expect(events.filter(e => e.type === 'diagnostic').map(e => e.message)).toEqual([
    'Worker module a.observe failed: first (1 failures)',
    'Worker module a.observe failed: last (2 failures)',
  ]);
  failures.record('a', 'tick', 'tick', 5001);
  failures.record('b', 'observe', 'other', 5001);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(4);
});

it('aggregates module health across hooks and sessions, and recovers after quiet', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  try {
    const host = new ProxyHost({ schema: loadSchema() });
    const listener = vi.fn();
    host.on('moduleHealth', listener);
    const report = { type: 'moduleHealth' as const, id: 's', moduleId: 'a', hook: 'observe' as const,
      failures: 2, since: 0, lastError: 'bad', at: 10 };
    host['handle'](report);
    host['handle']({ ...report, id: 's2', hook: 'tick', failures: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(host.getModuleHealth('a')).toEqual({ status: 'failing', failingSince: 0, lastError: 'bad', lastFailureAt: 10, totalFailures: 5 });
    clock.mockReturnValue(10 + MODULE_HEALTH_QUIET_MS);
    expect(host.getModuleHealth('a')).toMatchObject({ status: 'healthy', failingSince: null, totalFailures: 5 });
    expect(host.getModuleHealth('unknown')).toBeUndefined();
    host['handle']({ ...report, since: 40000, at: 40000, failures: 1 });
    expect(host.getModuleHealth('a')).toMatchObject({ failingSince: 40000, totalFailures: 6 });
  } finally { clock.mockRestore(); }
});

it('keeps counts independent across sessions and flushes final health without another diagnostic', () => {
  const events: WorkerEvent[] = [];
  const first = new ModuleFailures('first', e => events.push(e));
  const second = new ModuleFailures('second', e => events.push(e));
  first.record('a', 'observe', 'bad', 0);
  second.record('a', 'observe', 'bad', 1);
  first.record('a', 'observe', 'bad', 2);
  first.record('a', 'observe', 'last', 3);
  first.flush(4, true);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(2);
  expect(events.filter(e => e.type === 'moduleHealth').at(-1)).toMatchObject({
    id: 'first', failures: 2, since: 2, at: 3, lastError: 'last',
  });
  first.flush(5000);
  expect(events.filter(e => e.type === 'moduleHealth')).toHaveLength(3);
});
