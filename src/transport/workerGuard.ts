import { describeError } from '../util/describeError.ts';
import { MODULE_FAILURE_REPORT_MS, type ModuleHealthEvent, type WorkerEvent } from './messages.ts';
import type { WorkerModule } from './modules.ts';

/** Keep a failed worker callback from escaping its event-loop boundary. */
export function guardWorkerCall(post: (event: WorkerEvent) => void, label: string, run: () => void, id?: string): void {
  try { run(); }
  catch (error) { post({ type: 'diagnostic', id, message: `${label} failed: ${describeError(error)}` }); }
}

export function tickSessions(sessions: Iterable<{ id: string; tick(now: number): void }>, now: number,
  post: (event: WorkerEvent) => void): void {
  for (const session of sessions) guardWorkerCall(post, 'Session tick', () => session.tick(now), session.id);
}

/** Acknowledge every attempt; modules retain their previous config on rejection. */
export function configureWorkerModule(module: WorkerModule | undefined, moduleId: string, config: unknown,
  post: (event: WorkerEvent) => void): void {
  try {
    if (!module) throw new Error('Unknown worker module');
    module.configure?.(config);
  } catch (error) {
    const message = describeError(error);
    post({ type: 'moduleConfig', moduleId, ok: false, error: message });
    post({ type: 'diagnostic', message: `module ${moduleId} rejected its configuration: ${message}` });
    return;
  }
  post({ type: 'moduleConfig', moduleId, ok: true });
}

/** One tracker per session. Successful hooks never touch or allocate failure state. */
export class ModuleFailures {
  private readonly id: string;
  private readonly post: (event: WorkerEvent) => void;
  private readonly entries = new Map<string, Map<ModuleHealthEvent['hook'], {
    report: ModuleHealthEvent; reportedAt: number;
  }>>();

  constructor(id: string, post: (event: WorkerEvent) => void) {
    this.id = id;
    this.post = post;
  }

  record(moduleId: string, hook: ModuleHealthEvent['hook'], error: unknown, now: number): void {
    let hooks = this.entries.get(moduleId);
    if (!hooks) { hooks = new Map(); this.entries.set(moduleId, hooks); }
    let entry = hooks.get(hook);
    if (!entry) {
      entry = { report: { type: 'moduleHealth', id: this.id, moduleId, hook,
        failures: 0, since: now, lastError: '', at: now }, reportedAt: -Infinity };
      hooks.set(hook, entry);
    }
    const report = entry.report;
    if (!report.failures) report.since = now;
    report.failures++;
    report.lastError = describeError(error);
    report.at = now;
    if (now - entry.reportedAt >= MODULE_FAILURE_REPORT_MS) this.report(entry, now, true);
  }

  /** Flush trailing counts on ticks; closing flushes health only, preserving the diagnostic limit. */
  flush(now: number, closing = false): void {
    for (const hooks of this.entries.values()) for (const entry of hooks.values()) {
      if (entry.report.failures && (closing || now - entry.reportedAt >= MODULE_FAILURE_REPORT_MS)) {
        this.report(entry, now, !closing);
      }
    }
  }

  private report(entry: { report: ModuleHealthEvent; reportedAt: number }, now: number, diagnostic: boolean): void {
    const report = entry.report;
    this.post({ ...report });
    if (diagnostic) this.post({ type: 'diagnostic', id: this.id,
      message: `Worker module ${report.moduleId}.${report.hook} failed: ${report.lastError} (${report.failures} failures)` });
    report.failures = 0;
    entry.reportedAt = now;
  }
}
