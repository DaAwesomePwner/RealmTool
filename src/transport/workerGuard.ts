import { describeError } from '../util/describeError.ts';
import type { WorkerEvent } from './messages.ts';

/** Keep a failed worker callback from escaping its event-loop boundary. */
export function guardWorkerCall(post: (event: WorkerEvent) => void, label: string, run: () => void, id?: string): void {
  try { run(); }
  catch (error) { post({ type: 'diagnostic', id, message: `${label} failed: ${describeError(error)}` }); }
}

export function tickSessions(sessions: Iterable<{ id: string; tick(now: number): void }>, now: number,
  post: (event: WorkerEvent) => void): void {
  for (const session of sessions) guardWorkerCall(post, 'Session tick', () => session.tick(now), session.id);
}
