// Ported from realm-engine-client client/src/auto-drink/ClientGameClock.ts @ 88a66b2 (MIT, see NOTICE).
interface Sample { time: number; at: number }
const MAX_AGE_MS = 1500;
const JITTER_MS = 250;
const RESYNC_MS = 500;
const int32 = (time: unknown): time is number => typeof time === 'number'
  && Number.isInteger(time) && time >= 0 && time <= 0x7fffffff;

/** Accepted game samples only; consumption deadlines belong to the controller. */
export class ClientGameClock {
  private sample: Sample | null = null;
  // Keep a fixed reference across normal samples so small, cumulative drift
  // cannot make a stalled/slow stream look live indefinitely.
  private reference: Sample | null = null;
  private resync: { first: Sample; last: Sample } | null = null;
  private needsConfirmation = false;

  reset(newConnection = false): void {
    this.needsConfirmation = !newConnection && (this.needsConfirmation || this.sample !== null || this.resync !== null);
    this.sample = this.reference = this.resync = null;
  }

  observe(time: unknown, now: number): void {
    if (!int32(time) || !Number.isFinite(now) || now < 0) return;
    const next = { time, at: now }, previous = this.sample;
    if (previous) {
      if (now < previous.at || now - previous.at > MAX_AGE_MS) {
        this.reset(); // A fresh, coherent run may establish a lower clock after a stall.
      } else {
        if (time <= previous.time) return; // Duplicates/backwards never renew liveness.
        if (this.agrees(this.reference!, next)) {
          this.sample = next; this.resync = null;
          return;
        }
        // A discontinuity blocks extrapolation of the old epoch immediately.
        this.reset();
      }
    }
    if (!this.needsConfirmation) { this.accept(next); return; }
    const pending = this.resync;
    if (pending && now >= pending.last.at && now - pending.first.at <= MAX_AGE_MS) {
      if (time === pending.last.time) return;
      if (time > pending.last.time && this.agrees(pending.first, next)) {
        pending.last = next;
        // Require advancing samples spanning at least 500ms, within one 1500ms
        // window; one jump or a burst of queued packets cannot recalibrate us.
        if (now - pending.first.at >= RESYNC_MS) this.accept(next);
        return;
      }
    }
    this.resync = { first: next, last: next };
  }

  time(now: number): number | null {
    const sample = this.sample;
    if (!sample || this.resync || !Number.isFinite(now) || now < sample.at || now - sample.at > MAX_AGE_MS) return null;
    const time = Math.floor(sample.time + now - sample.at);
    return int32(time) ? time : null; // Never wrap or clamp into the protocol range.
  }

  private agrees(reference: Sample, next: Sample): boolean {
    return Math.abs(next.time - (reference.time + next.at - reference.at)) <= JITTER_MS;
  }
  private accept(sample: Sample): void {
    this.sample = this.reference = sample;
    this.resync = null; this.needsConfirmation = false;
  }
}
