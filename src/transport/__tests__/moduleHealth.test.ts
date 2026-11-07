import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ModuleFailures, ModuleDiagnosticLimiter } from '../workerGuard.ts';
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
    'Worker module a.observe failed: first (1 failure)',
    'Worker module a.observe failed: last (2 failures)',
  ]);
  failures.record('a', 'tick', 'tick', 5001);
  failures.record('b', 'observe', 'other', 5001);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(4);
});

it('emits transitions using receipt time, renews recovery, and clears timers on stop', async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  const host = new ProxyHost({ schema: loadSchema() });
  try {
    const status = vi.fn();
    const reports = vi.fn();
    host.on('moduleStatus', status);
    host.on('moduleHealth', reports);
    expect(vi.getTimerCount()).toBe(0);
    const report = { type: 'moduleHealth' as const, id: 's', moduleId: 'a', hook: 'observe' as const,
      failures: 2, since: -900000, lastError: 'bad', at: 900000 };
    host['handle'](report);
    expect(status).toHaveBeenCalledExactlyOnceWith({ moduleId: 'a', state: 'failing', since: 10, lastError: 'bad' });
    expect(vi.getTimerCount()).toBe(1);
    clock.mockReturnValue(1010);
    vi.advanceTimersByTime(1000);
    host['handle']({ ...report, id: 's2', hook: 'tick', failures: 3 });
    expect(reports).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(1);
    expect(host.getModuleHealth('a')).toEqual({ status: 'failing', failingSince: 10, lastError: 'bad', lastFailureAt: 1010, totalFailures: 5 });
    clock.mockReturnValue(30010);
    vi.advanceTimersByTime(29000);
    expect(status).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(31010);
    vi.advanceTimersByTime(1000);
    expect(status).toHaveBeenLastCalledWith({ moduleId: 'a', state: 'healthy', since: 31010 });
    expect(host.getModuleHealth('a')).toMatchObject({ status: 'healthy', failingSince: null, totalFailures: 5 });
    expect(vi.getTimerCount()).toBe(0);
    host['handle'](report);
    expect(status).toHaveBeenLastCalledWith({ moduleId: 'a', state: 'failing', since: 31010, lastError: 'bad' });
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
    host['handle'](report); // A final worker report arriving during shutdown cannot rearm recovery.
    expect(vi.getTimerCount()).toBe(0);
    clock.mockReturnValue(100000);
    vi.advanceTimersByTime(MODULE_HEALTH_QUIET_MS);
    expect(status).toHaveBeenCalledTimes(3);
  } finally { await host.stop(); clock.mockRestore(); vi.useRealTimers(); }
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

it('caps diagnostics across reconnects while reporting every session immediately', () => {
  const events: WorkerEvent[] = [];
  const post = (event: WorkerEvent) => events.push(event);
  const limiter = new ModuleDiagnosticLimiter(post);
  const first = new ModuleFailures('first', post, limiter);
  const second = new ModuleFailures('second', post, limiter);
  first.record('a', 'observe', 'first', 0);
  second.record('a', 'observe', 'second', 1);
  first.record('a', 'observe', 'third', 2);
  first.flush(3, true);
  second.flush(3, true);
  expect(events.filter(e => e.type === 'moduleHealth')).toHaveLength(3);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(1);
  limiter.flush(4999);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(1);
  limiter.flush(5000);
  expect(events.filter(e => e.type === 'diagnostic').at(-1)).toMatchObject({
    message: 'Worker module a.observe failed: third (2 failures)',
  });
  limiter.flush(10000);
  expect(events.filter(e => e.type === 'diagnostic')).toHaveLength(2);
});

it('keeps a recovery timer until the last failing module recovers', async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const host = new ProxyHost({ schema: loadSchema() });
  try {
    const states: string[] = [];
    host.on('moduleStatus', event => states.push(event.moduleId + ':' + event.state));
    const report = { type: 'moduleHealth' as const, id: 's', moduleId: 'a', hook: 'observe' as const,
      failures: 1, since: 999999, lastError: 'bad', at: 999999 };
    host['handle'](report);
    clock.mockReturnValue(1000);
    vi.advanceTimersByTime(1000);
    host['handle']({ ...report, moduleId: 'b' });
    clock.mockReturnValue(30000);
    vi.advanceTimersByTime(29000);
    expect(states).toEqual(['a:failing', 'b:failing', 'a:healthy']);
    expect(vi.getTimerCount()).toBe(1);
    clock.mockReturnValue(31000);
    vi.advanceTimersByTime(1000);
    expect(states.at(-1)).toBe('b:healthy');
    expect(vi.getTimerCount()).toBe(0);
  } finally { await host.stop(); clock.mockRestore(); vi.useRealTimers(); }
});

it('does not iterate health or diagnostic entries on idle ticks', () => {
  const post = vi.fn();
  const limiter = new ModuleDiagnosticLimiter(post);
  const failures = new ModuleFailures('s', post, limiter);
  const healthEntries = vi.spyOn(failures['entries'], 'values');
  const diagnosticEntries = vi.spyOn(limiter['entries'], 'values');
  failures.flush(0);
  limiter.flush(0);
  failures.record('a', 'observe', 'bad', 0);
  failures.flush(5000);
  limiter.flush(5000);
  expect(healthEntries).not.toHaveBeenCalled();
  expect(diagnosticEntries).not.toHaveBeenCalled();
});
