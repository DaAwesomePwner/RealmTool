// Ported from realm-engine-client client/src/safety/EscapeAttemptCoordinator.ts @ 88a66b2 (MIT, see NOTICE).
import type { EscapeAttemptStatus, EscapeWriteReceipt, SafetySettings } from './SafetyTypes.ts';

/** write() returns acceptance, NOT the socket.write() backpressure boolean. */
export interface EscapeTransport {
  now(): number;
  available(): boolean;
  blocked(): boolean;
  write(done: (error?: Error | null) => void): boolean;
}
interface Attempt extends EscapeAttemptStatus {
  retries: number;
  retryMs: number;
  reactionMs: number;
  /** Equivalent same-lifecycle request; physical origin remains manual. */
  sharedWrite: Write | null;
  ownWrite: Write | null;
}
interface Write { id: number; attempt: Attempt; at: number; accepted: boolean; completedAt: number | null; error: Error | null }

/**
 * Timer-free owner of logical attempts and the physical ESCAPE write slot.
 * One initial ESCAPE may enqueue behind ordinary traffic when no ESCAPE is
 * pending. Backpressure gates retries/recovery, not the first emergency write.
 * Only successful local writes may be retried (at most retryCount, one per tick).
 * Each write gets retryMs + reactionMs to await a server transition after the
 * final write; a pending callback gets 2 * reactionMs before being unconfirmed.
 *
 * Recovery policy: max(1000, 2 * reactionMs) ms cooldown (1000..4000 with
 * normalized settings), then require a server health/tick observation NEWER
 * than failure and no older than max(1500, 3 * reactionMs), plus a writable
 * transport. A timer alone cannot restart a failed attempt. The damage ledger
 * is deliberately outside this class and is never reset by failure/recovery.
 */
export class EscapeAttemptCoordinator {
  private generation = 0;
  private epoch = 0;
  private revision = 0;
  private attemptSequence = 0;
  private writeSequence = 0;
  private current: Attempt | null = null;
  private pending: Write | null = null;
  private recovery: { failedAt: number; until: number; freshnessMs: number } | null = null;

  private readonly transport?: EscapeTransport;
  private readonly observeWrite?: (receipt: EscapeWriteReceipt) => void;
  constructor(transport?: EscapeTransport, observeWrite?: (receipt: EscapeWriteReceipt) => void) {
    this.transport = transport; this.observeWrite = observeWrite;
  }

  get available(): boolean { return this.transport?.available() ?? true; }
  get status(): EscapeAttemptStatus | null {
    if (!this.current) return null;
    const { retries: _retries, retryMs: _retryMs, reactionMs: _reactionMs, sharedWrite, ownWrite, ...status } = this.current;
    const write = ownWrite ?? sharedWrite;
    return { ...status, writeReceipt: write ? this.receipt(write, write.attempt !== this.current) : null };
  }

  private receipt(write: Write, shared = false): EscapeWriteReceipt {
    return { writeId: write.id, attemptId: write.attempt.id, origin: write.attempt.origin,
      connectionGeneration: write.attempt.connectionGeneration, epoch: write.attempt.epoch,
      lifecycleRevision: write.attempt.lifecycleRevision, enqueuedAt: write.at,
      accepted: write.accepted, completedAt: write.completedAt, failed: write.error !== null, shared };
  }
  acceptedReceipt(attemptId: number): EscapeWriteReceipt | null {
    const a = this.current, write = a?.ownWrite ?? a?.sharedWrite;
    if (!a || a.id !== attemptId || a.phase === 'failed' || !write?.accepted || write.error
      || a.connectionGeneration !== this.generation || a.epoch !== this.epoch || a.lifecycleRevision !== this.revision
      || write.attempt.connectionGeneration !== this.generation || write.attempt.epoch !== this.epoch
      || write.attempt.lifecycleRevision !== this.revision) return null;
    return this.receipt(write, write.attempt !== a);
  }
  private notify(write: Write): void {
    // Display-only observers cannot turn an accepted ESCAPE into a failed write.
    try { this.observeWrite?.(this.receipt(write)); } catch { /* protection proceeds */ }
  }

  replaceConnection(generation: number): void {
    this.generation = generation;
    this.invalidate(); this.pending = null; this.recovery = null;
  }
  reset(epoch: number): void {
    this.epoch = epoch; this.invalidate(); this.recovery = null;
    // A map reset cannot unsend buffered bytes. Its callback may release only
    // this old physical slot, never change the new epoch's logical attempt.
  }
  cancel(now: number): void {
    if (this.current?.origin === 'automatic' && this.current.phase !== 'failed') this.cooldown(this.current, now);
    this.invalidate();
  }
  private invalidate(): void { ++this.revision; this.current = null; }

  automaticEligible(now: number, serverAt: number | null): boolean {
    if (this.current?.origin === 'automatic' && this.current.phase !== 'failed') return false;
    if (!this.recovery) return true; // A manual request never masks automatic danger.
    return now >= this.recovery.until && serverAt !== null && serverAt > this.recovery.failedAt
      && now - serverAt <= this.recovery.freshnessMs && !this.pending
      && this.available && !(this.transport?.blocked() ?? false);
  }
  recoveryState(now: number): 'cooldown' | 'degraded' | null {
    return this.recovery ? (now < this.recovery.until ? 'cooldown' : 'degraded') : null;
  }

  begin(origin: Attempt['origin'], now: number, settings: SafetySettings): EscapeAttemptStatus | null {
    // Automatic eligibility is checked by the engine, with its live evidence.
    // Manual commands cannot supersede an automatic attempt or spam an active
    // manual lifecycle. A genuine automatic decision CAN supersede a manual one.
    if (origin === 'manual' && this.current && this.current.phase !== 'failed') return null;
    if (origin === 'automatic') this.recovery = null;
    const pending = this.pending;
    // A callback timeout did not unsend an accepted manual ESCAPE. Even a
    // degraded manual attempt can supply this same-lifecycle physical receipt.
    const sharedWrite = origin === 'automatic' && pending?.attempt.origin === 'manual' && pending.accepted && !pending.error
      && pending.attempt.connectionGeneration === this.generation && pending.attempt.epoch === this.epoch
      && pending.attempt.lifecycleRevision === this.revision ? pending : null;
    const attempt: Attempt = { id: ++this.attemptSequence, origin,
      connectionGeneration: this.generation, epoch: this.epoch, lifecycleRevision: this.revision,
      phase: 'requested', requestedAt: now, lastWriteAt: null, writeId: null, failure: null,
      retries: settings.enabled ? settings.retryCount : 0, retryMs: settings.retryMs, reactionMs: settings.reactionMs, sharedWrite, ownWrite: null };
    this.current = attempt;
    return this.status;
  }

  writeInitial(id: number): boolean {
    const a = this.current;
    if (!a || a.id !== id || a.phase !== 'requested') return false;
    if (a.sharedWrite) {
      // ESCAPE is already submitted on this lifecycle. Wait on that receipt,
      // not a failure cooldown, and never append a second pending ESCAPE.
      // queued/written describe that equivalent request; writeId/lastWriteAt
      // stay null until an OWN automatic retry is submitted. Acceptance of this
      // equivalent ESCAPE plus a GENUINE automatic decision may authorize report
      // suppression. Manual origin alone never does; rejected/throwing writes cannot.
      a.phase = 'queued'; return this.available && this.acceptedReceipt(a.id) !== null;
    }
    return this.write(a, true);
  }
  private write(a: Attempt, initial = false): boolean {
    if (!this.transport) return false;
    const now = this.transport.now(); // Actual write start, independent of decision/previous write time.
    if (!this.available) { this.fail(a, now, 'unavailable'); return false; }
    if (this.pending || (!initial && this.transport.blocked())) { this.fail(a, now, 'backpressure'); return false; }
    const write: Write = { id: ++this.writeSequence, attempt: a, at: now, accepted: false, completedAt: null, error: null };
    a.sharedWrite = null; a.ownWrite = write;
    this.pending = write; a.writeId = write.id; a.lastWriteAt = now; a.phase = 'queued';
    const complete = (error?: Error | null) => {
      if (write.completedAt !== null) return;
      if (this.pending === write) this.pending = null; // May retire only its own slot.
      write.completedAt = this.transport!.now(); write.error ??= error ?? null;
      if (this.current === a && a.connectionGeneration === this.generation
        && a.epoch === this.epoch && a.lifecycleRevision === this.revision && a.phase === 'queued') {
        if (error) this.fail(a, write.completedAt, 'write-error');
        else a.phase = 'written';
      }
      this.notify(write); // Retired completion is telemetry, never a new lifecycle mutation.
    };
    try {
      if (!this.transport.write(complete)) {
        if (this.pending === write) this.pending = null; // Explicitly not accepted.
        this.fail(a, now, 'unavailable'); return false;
      }
    } catch (error) {
      // A throwing writer provides no proof that the bytes were unsent. Keep
      // the slot until callback/connection replacement, just like a timeout.
      write.error = error instanceof Error ? error : new Error('ESCAPE writer threw');
      this.fail(a, now, 'write-error'); this.notify(write); return false;
    }
    write.accepted = write.error === null;
    this.notify(write);
    return this.current === a && a.failure === null && write.accepted;
  }

  advance(now: number): void {
    const a = this.current;
    if (!a || !this.transport || a.phase === 'failed') return;
    if (a.sharedWrite && a.phase === 'queued') {
      const shared = a.sharedWrite;
      // The old callback updates only its OWN receipt. This current-lifecycle
      // advance consumes it, preserving stale-callback ownership isolation.
      if (shared.completedAt === null) {
        if (now - shared.at >= 2 * shared.attempt.reactionMs) this.fail(a, now, 'write-stalled');
        return; // Sharing never restarts the already-submitted write's timeout.
      }
      if (shared.error) { this.fail(a, shared.completedAt, 'write-error'); return; }
      a.phase = 'written';
    }
    if (this.pending?.attempt === a) {
      if (now - this.pending.at >= 2 * a.reactionMs) this.fail(a, now, 'write-stalled');
      return; // Timeout is NOT evidence that the write was unsent.
    }
    const lastWriteAt = a.lastWriteAt ?? a.sharedWrite?.at;
    if (a.phase !== 'written' || lastWriteAt == null) return;
    if (a.retries > 0 && now >= lastWriteAt + a.retryMs) {
      --a.retries; this.write(a);
    } else if (a.retries === 0 && now >= lastWriteAt + a.retryMs + a.reactionMs) {
      this.fail(a, now, 'unconfirmed');
    }
  }
  private cooldown(a: Attempt, now: number): void {
    this.recovery = { failedAt: now, until: now + Math.max(1000, 2 * a.reactionMs),
      freshnessMs: Math.max(1500, 3 * a.reactionMs) };
  }
  private fail(a: Attempt, now: number, failure: NonNullable<Attempt['failure']>): void {
    if (this.current !== a || a.phase === 'failed') return;
    a.phase = 'failed'; a.failure = failure; a.retries = 0;
    if (a.origin === 'automatic') this.cooldown(a, now);
  }
}

