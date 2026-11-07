import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Correlation, distance } from '../plugins/capture/correlation.ts';
import type { RecordLine } from '../plugins/capture/records.ts';

/** Captures have no AOE identity in ACKs; all matches are explicitly heuristic. */
export function report(records: Iterable<RecordLine>, window = 1500): string {
  if (!Number.isFinite(window) || window <= 0) throw new Error('ACK window must be positive');
  const clients = new Map<string, { c: Correlation; aoes: RecordLine[]; matches: Map<RecordLine, RecordLine>; stats?: RecordLine; deltas: string[] }>();
  for (const r of records) {
    let s = clients.get(r.client);
    if (!s) { s = { c: new Correlation(window), aoes: [], matches: new Map(), deltas: [] }; clients.set(r.client, s); }
    const match = s.c.add(r);
    if (r.type === 'AOE') s.aoes.push(r);
    if (match) s.matches.set(match, r);
    if (['MAPINFO', 'CREATESUCCESS', 'RECONNECT', 'DEATH'].includes(r.type)) s.stats = undefined;
    if (r.stats) {
      const previous = s.stats;
      const hp = r.stats['1'], oldHp = previous?.stats?.['1'];
      s.deltas.push(`stats t=${r.t} masks29/95=${r.stats['29'] ?? 'unknown'}/${r.stats['95'] ?? 'unknown'} HP=${hp ?? 'unknown'} delta=${typeof hp === 'number' && typeof oldHp === 'number' ? hp - oldHp : 'unknown'} dt=${previous ? r.t - previous.t : 'unknown'}ms`);
      s.stats = r;
    }
  }
  const lines = [`Heuristic FIFO one-to-one ACK matching, window=${window}ms. Overlapping AoEs, capture boundaries and suppressed ACKs can confound results.`,
    'DoT: Bleeding bit not verified in repository; showing condition masks and consecutive HP deltas for manual analysis (not damage attribution).'];
  for (const [id, s] of clients) {
    let inside = 0, outside = 0;
    const latencies: number[] = [];
    lines.push(`[${id}] AOE=${s.c.aoe} AOEACK=${s.c.ack} ack ratio=${s.c.aoe ? (s.c.ack / s.c.aoe).toFixed(3) : 'n/a'}`);
    for (const r of s.aoes) {
      const ack = s.matches.get(r);
      if (!ack) { lines.push(`AOE #${r.seq}: unacked within ${window}ms (end-of-capture may be censored)`); continue; }
      const dt = ack.t - r.t; latencies.push(dt);
      let geometry = 'distance/radius unknown';
      if (ack.position && r.position && typeof r.radius === 'number') {
        const d = distance(ack.position, r.position);
        if (d <= r.radius) inside++; else outside++;
        geometry = `distance=${d.toFixed(3)} radius=${r.radius} ${d <= r.radius ? 'inside' : 'outside'}`;
      }
      lines.push(`AOE #${r.seq}: ACK after ${dt.toFixed(1)}ms; ${geometry}`);
    }
    const unacked = s.aoes.length - s.matches.size;
    lines.push(`acked-inside=${inside} acked-outside=${outside} unacked=${unacked}`);
    latencies.sort((a, b) => a - b);
    const percentile = (p: number) => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1].toFixed(1) : 'n/a';
    lines.push(`AOE→ACK p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms`);
    // Require at least three examples and 20% of AOEs for "substantial"; about zero is <=5%.
    const substantial = Math.max(3, s.c.aoe * 0.2), zero = s.c.aoe * 0.05;
    const verdict = outside >= substantial && unacked <= zero ? 'ACK-every-AoE likely'
      : outside <= zero && unacked >= substantial && inside >= 3 ? 'ACK-only-hits likely' : 'inconclusive';
    lines.push(`Verdict: ${verdict}`, ...s.deltas);
  }
  return lines.join('\n');
}

export async function main(args: string[]): Promise<void> {
  const [file, flag, value, ...extra] = args;
  if (!file || extra.length || (flag !== undefined && flag !== '--window-ms') || (flag && !value))
    throw new Error('Usage: node tools/capture-report.ts <file.jsonl> [--window-ms 1500]');
  const window = value === undefined ? 1500 : Number(value);
  const records: RecordLine[] = [];
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of input) {
    lineNumber++;
    if (!line.trim()) continue;
    let r: RecordLine;
    try { r = JSON.parse(line); } catch { throw new Error(`Invalid JSON at line ${lineNumber}`); }
    if (!r || typeof r.client !== 'string' || typeof r.type !== 'string' || !Number.isFinite(r.t))
      throw new Error(`Invalid record at line ${lineNumber}`);
    records.push(r);
  }
  console.log(report(records, window));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
