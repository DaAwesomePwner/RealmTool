import { expect, it } from 'vitest';
import { report } from '../capture-report.ts';
import type { RecordLine } from '../../plugins/capture/records.ts';
function fixture(model: 'all' | 'hits'): RecordLine[] {
  const rows: RecordLine[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ client: 'c1', dir: 'server', type: 'AOE', t: i * 2000, iso: '', seq: i + 1, position: { x: 0, y: 0 }, radius: 1 });
    if (model === 'all' || i % 2 === 0) rows.push({ client: 'c1', dir: 'client', type: 'AOEACK', t: i * 2000 + 100, iso: '', position: { x: i % 2 === 0 ? 0 : 10, y: 0 } });
  }
  return rows;
}
it('recognizes every-AOE including outside ACKs and latency percentiles', () => {
  const output = report(fixture('all'));
  expect(output).toContain('ACK-every-AoE likely'); expect(output).toContain('acked-inside=5 acked-outside=5 unacked=0');
  expect(output).toContain('ack ratio=1.000'); expect(output).toContain('p50=100.0ms p95=100.0ms');
});
it('recognizes only-hits and respects custom ACK window', () => {
  expect(report(fixture('hits'))).toContain('ACK-only-hits likely');
  expect(report(fixture('all'), 50)).toContain('Verdict: inconclusive');
});
it('does not reuse an ACK for overlapping AOEs or cross client boundaries', () => {
  const rows = fixture('all').slice(0, 2);
  rows.splice(1, 0, { ...rows[0], seq: 2, t: 1 });
  rows.push({ ...rows[0], client: 'c2' });
  expect(report(rows)).toContain('acked-inside=1 acked-outside=0 unacked=1');
  expect(report(rows)).toContain('[c2] AOE=1 AOEACK=0');
});
it('prints mask fallback with consecutive HP deltas and resets across maps', () => {
  const base = { client: 'c1', dir: 'server', type: 'NEWTICK', iso: '' };
  const output = report([{ ...base, t: 0, stats: { 1: 100, 29: 32768, 95: 0 } }, { ...base, t: 200, stats: { 1: 90, 29: 32768, 95: 0 } }]);
  expect(output).toContain('Bleeding bit not verified'); expect(output).toContain('masks29/95=32768/0 HP=90 delta=-10 dt=200ms');
});
