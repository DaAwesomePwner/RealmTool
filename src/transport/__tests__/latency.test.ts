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
it('requires two consecutive bad windows and recovers after a good window', () => {
  const lag = new LoopLagSampler(0);
  expect(lag.sample(5000)).toEqual({ p99: 4900, max: 4900, degraded: false });
  expect(lag.sample(10000)?.degraded).toBe(true);
  for (let now = 10100; now < 15000; now += 100) expect(lag.sample(now)).toBeNull();
  expect(lag.sample(15000)).toEqual({ p99: 0, max: 0, degraded: false });
  expect(lag.sample(20000)?.degraded).toBe(false);
});
