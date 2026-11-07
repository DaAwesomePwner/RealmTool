import { expect, it } from 'vitest';
import { LatencySamples, LoopLagSampler } from '../latency.ts';
it('reports no samples, nearest-rank percentiles, bounded size and lifetime max', () => {
  const samples = new LatencySamples();
  expect(samples.snapshot()).toEqual({ count: 0, samples: 0, p50: null, p99: null, max: null });
  for (let n = 1; n <= 100; n++) samples.add(n);
  expect(samples.snapshot()).toEqual({ count: 100, samples: 100, p50: 50, p99: 99, max: 100 });
  for (let n = 0; n < 300; n++) samples.add(2);
  expect(samples.snapshot()).toEqual({ count: 400, samples: 256, p50: 2, p99: 2, max: 100 });
});
it('ignores one isolated spike per window even in consecutive windows', () => {
  const lag = new LoopLagSampler(0);
  let now = 0;
  for (let window = 0; window < 3; window++) {
    let report;
    while (!report) { now += now % 5000 === 0 ? 200 : 100; report = lag.sample(now); }
    expect(report).toMatchObject({ p99: 100, max: 100, degraded: false });
  }
});
it('requires several late ticks in two windows and recovers in a healthy window', () => {
  const lag = new LoopLagSampler(0);
  let now = 0;
  for (const degraded of [false, true]) {
    let report;
    while (!report) { now += 200; report = lag.sample(now); }
    expect(report).toEqual({ p99: 100, max: 100, degraded });
  }
  let report;
  while (!report) { now += 100; report = lag.sample(now); }
  expect(report).toEqual({ p99: 0, max: 0, degraded: false });
});
it('does not infer sustained lag from too few samples', () => {
  const lag = new LoopLagSampler(0);
  expect(lag.sample(5000)?.degraded).toBe(false);
  expect(lag.sample(10000)?.degraded).toBe(false);
});
