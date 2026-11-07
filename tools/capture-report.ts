import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Correlation, distance } from '../plugins/capture/correlation.ts';
import { PACKETS, type RecordLine } from '../plugins/capture/records.ts';

type Counts = { aoe: number; ack: number; inside: number; outside: number; unacked: number; missedInside: number; missedOutside: number; unknown: number };
const counts = (): Counts => ({ aoe: 0, ack: 0, inside: 0, outside: 0, unacked: 0, missedInside: 0, missedOutside: 0, unknown: 0 });
function verdict(c: Counts): string {
  const substantial = Math.max(3, c.aoe * 0.2), zero = c.aoe * 0.05;
  return c.outside >= substantial && c.unacked <= zero ? 'ACK-every-AoE likely'
    : c.outside <= zero && c.missedOutside >= substantial && c.missedInside <= zero && c.inside >= 3 ? 'ACK-only-hits likely' : 'inconclusive';
}
function summary(c: Counts): string {
  return `acked-inside=${c.inside} acked-outside=${c.outside} unacked=${c.unacked} unacked-inside=${c.missedInside} unacked-outside=${c.missedOutside} unacked-unknown=${c.unknown}`;
}
interface Model { c: Correlation; matches: Map<RecordLine, RecordLine> }
interface Client { models: Model[]; aoes: RecordLine[]; near: Map<RecordLine, boolean | undefined>; stats?: RecordLine; deltas: string[] }
/** Captures have no AOE identity in ACKs; compare spatial-first and FIFO hypotheses. */
export function report(records: Iterable<RecordLine>, window = 1500): string {
  if (!Number.isFinite(window) || window <= 0) throw new Error('ACK window must be positive');
  const clients = new Map<string, Client>();
  for (const r of records) {
    let s = clients.get(r.client);
    if (!s) {
      s = { models: [true, false].map(spatial => ({ c: new Correlation(window, spatial), matches: new Map() })), aoes: [], near: new Map(), deltas: [] };
      clients.set(r.client, s);
    }
    if (r.type === 'AOE') {
      s.aoes.push(r);
      const prior = s.models[0].c.position;
      s.near.set(r, prior && r.position && typeof r.radius === 'number' ? distance(prior, r.position) <= r.radius + 0.5 : undefined);
    }
    for (const m of s.models) { const match = m.c.add(r); if (match) m.matches.set(match, r); }
    if (['MAPINFO', 'CREATESUCCESS', 'RECONNECT', 'DEATH'].includes(r.type)) s.stats = undefined;
    if (r.stats) {
      const previous = s.stats;
      const hp = r.stats['1'], oldHp = previous?.stats?.['1'];
      s.deltas.push(`stats t=${r.t} masks29/95=${r.stats['29'] ?? 'unknown'}/${r.stats['95'] ?? 'unknown'} HP=${hp ?? 'unknown'} delta=${typeof hp === 'number' && typeof oldHp === 'number' ? hp - oldHp : 'unknown'} dt=${previous ? r.t - previous.t : 'unknown'}ms`);
      s.stats = r;
    }
  }
  const lines = [`Heuristic spatial-first (oldest containing radius+0.5, else FIFO) versus FIFO one-to-one ACK matching, window=${window}ms. Capture boundaries and suppressed ACKs can confound results.`,
    'DoT: Bleeding bit not verified in repository; showing condition masks and consecutive HP deltas for manual analysis (not damage attribution).'];
  const totals = [counts(), counts()];
  for (const [id, s] of clients) {
    const c = s.models[0].c;
    lines.push(`[${id}] AOE=${c.aoe} AOEACK=${c.ack} ack ratio=${c.aoe ? (c.ack / c.aoe).toFixed(3) : 'n/a'}`);
    s.models.forEach((model, index) => {
      const count = counts(), latencies: number[] = [];
      count.aoe = model.c.aoe; count.ack = model.c.ack;
      const label = index === 0 ? 'spatial-first' : 'FIFO';
      for (const r of s.aoes) {
        const ack = model.matches.get(r);
        if (!ack) {
          count.unacked++;
          const near = s.near.get(r);
          if (near === undefined) count.unknown++; else if (near) count.missedInside++; else count.missedOutside++;
          lines.push(`${label} AOE #${r.seq}: unacked within ${window}ms; prior position=${near === undefined ? 'unknown' : near ? 'inside' : 'outside'} radius+0.5 (capture/segment end may be censored)`);
          continue;
        }
        const dt = ack.t - r.t; latencies.push(dt);
        let geometry = 'distance/radius unknown';
        if (ack.position && r.position && typeof r.radius === 'number') {
          const d = distance(ack.position, r.position);
          if (d <= r.radius) count.inside++; else count.outside++;
          geometry = `distance=${d.toFixed(3)} radius=${r.radius} ${d <= r.radius ? 'inside' : 'outside'}`;
        }
        lines.push(`${label} AOE #${r.seq}: ACK after ${dt.toFixed(1)}ms; ${geometry}`);
      }
      lines.push(`${label}: ${summary(count)}`);
      latencies.sort((a, b) => a - b);
      const percentile = (p: number) => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1].toFixed(1) : 'n/a';
      lines.push(`${label} AOE→ACK p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms`, `${label} Verdict: ${verdict(count)}`);
      for (const key of Object.keys(count) as (keyof Counts)[]) totals[index][key] += count[key];
    });
    lines.push(...s.deltas);
  }
  totals.forEach((c, i) => lines.push(`Overall ${i === 0 ? 'spatial-first' : 'FIFO'}: AOE=${c.aoe} AOEACK=${c.ack} ${summary(c)}; Verdict: ${verdict(c)}`));
  return lines.join('\n');
}

/** Malformed lines (including a torn final write) are counted, never printed. */
export async function readCapture(file: string): Promise<{ records: RecordLine[]; invalid: number }> {
  const records: RecordLine[] = []; let invalid = 0;
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
      if (!r || typeof r.client !== 'string' || !(PACKETS as readonly string[]).includes(r.type) || !finite(r.t)
        || (r.position !== undefined && (!r.position || !finite(r.position.x) || !finite(r.position.y)))
        || (r.radius !== undefined && (!finite(r.radius) || r.radius < 0))
        || (r.stats !== undefined && (!r.stats || typeof r.stats !== 'object' || Array.isArray(r.stats) || !Object.values(r.stats).every(finite)))) {
        invalid++; continue;
      }
      records.push(r);
    } catch { invalid++; }
  }
  return { records, invalid };
}
export async function main(args: string[]): Promise<void> {
  const [file, flag, value, ...extra] = args;
  if (!file || extra.length || (flag !== undefined && flag !== '--window-ms') || (flag && !value))
    throw new Error('Usage: node tools/capture-report.ts <file.jsonl> [--window-ms 1500]');
  const { records, invalid } = await readCapture(file);
  console.log(`Skipped invalid/truncated lines: ${invalid}\n${report(records, value === undefined ? 1500 : Number(value))}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
