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
/** 100ms heartbeat. Require >=10 samples and >=3 late ticks in each of two 5s windows. */
export class LoopLagSampler {
  private expected: number;
  private since: number;
  private samples = new LatencySamples();
  private badWindows = 0;
  private lateTicks = 0;
  constructor(now: number) { this.expected = now + 100; this.since = now; }
  sample(now: number): LoopLag | null {
    const drift = Math.max(0, now - this.expected);
    this.samples.add(drift);
    if (drift > 50) this.lateTicks++;
    this.expected = now + 100;
    if (now - this.since < 5000) return null;
    const { p99, max, count } = this.samples.snapshot();
    this.samples = new LatencySamples(); this.since = now;
    this.badWindows = p99! > 50 && count >= 10 && this.lateTicks >= 3 ? this.badWindows + 1 : 0;
    this.lateTicks = 0;
    return { p99: p99!, max: max!, degraded: this.badWindows >= 2 };
  }
}


export interface EscapeLatencySummary extends LatencySummary { automaticWithoutSample: number }
/** One instance per proxy run; retries/manual requests are not automatic decisions. */
export class EscapeLatency extends LatencySamples {
  private automaticWithoutSample = 0;
  record(receivedAt: number | undefined, acceptedAt: number | undefined): void {
    if (receivedAt === undefined || acceptedAt === undefined || acceptedAt < receivedAt) this.automaticWithoutSample++;
    else this.add(acceptedAt - receivedAt);
  }
  override snapshot(): EscapeLatencySummary {
    return { ...super.snapshot(), automaticWithoutSample: this.automaticWithoutSample };
  }
  summary(): string {
    const s = this.snapshot();
    return `Auto Nexus run receive → write: ${s.count ? `n=${s.count}, p50=${s.p50!.toFixed(1)}ms, p99=${s.p99!.toFixed(1)}ms, max=${s.max!.toFixed(1)}ms` : 'no samples'}; automatic escapes without a sample=${s.automaticWithoutSample}`;
  }
}
