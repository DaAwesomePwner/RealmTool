/** Bounded recent-sample percentiles and lifetime maximum. */
export class LatencySamples {
  private values = new Float64Array(256);
  private count = 0;
  private maximum = 0;
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values[this.count++ % this.values.length] = ms;
    this.maximum = Math.max(this.maximum, ms);
  }
  snapshot(): LatencySummary {
    if (!this.count) return { count: 0, samples: 0, p50: null, p99: null, max: null };
    const values = this.values.slice(0, Math.min(this.count, this.values.length)).sort();
    return { count: this.count, samples: values.length, p50: values[Math.ceil(values.length * .5) - 1],
      p99: values[Math.ceil(values.length * .99) - 1], max: this.maximum };
  }
}
export interface LatencySummary { count: number; samples: number; p50: number | null; p99: number | null; max: number | null }
export interface LoopLag { p99: number; max: number; degraded: boolean }
/** 100ms heartbeat, five-second windows; two bad windows degrade, one good recovers. */
export class LoopLagSampler {
  private expected: number;
  private since: number;
  private samples = new LatencySamples();
  private badWindows = 0;
  constructor(now: number) { this.expected = now + 100; this.since = now; }
  sample(now: number): LoopLag | null {
    this.samples.add(Math.max(0, now - this.expected));
    this.expected = now + 100;
    if (now - this.since < 5000) return null;
    const { p99, max } = this.samples.snapshot();
    this.samples = new LatencySamples(); this.since = now;
    this.badWindows = p99! > 50 ? this.badWindows + 1 : 0;
    return { p99: p99!, max: max!, degraded: this.badWindows >= 2 };
  }
}
