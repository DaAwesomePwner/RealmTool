import type { Position, RecordLine } from './records.ts';
export const distance = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.y - b.y);
interface Pending { record: RecordLine; near?: boolean }
/** One ACK per AOE; spatial-first and FIFO are competing heuristics, not identity matches. */
export class Correlation {
  aoe = 0; ack = 0; unacked = 0; near = 0; unknown = 0; censored = 0;
  pending: Pending[] = [];
  position?: Position;
  window: number;
  spatial: boolean;
  lastActivity = -Infinity;
  constructor(window = 1500, spatial = true) { this.window = window; this.spatial = spatial; }
  expire(now: number): RecordLine[] {
    const expired: RecordLine[] = [];
    while (this.pending.length && now - this.pending[0].record.t > this.window) {
      const item = this.pending.shift()!;
      this.unacked++; if (item.near) this.near++; if (item.near === undefined) this.unknown++;
      expired.push(item.record);
    }
    return expired;
  }
  add(r: RecordLine): RecordLine | undefined {
    this.lastActivity = r.t;
    this.expire(r.t);
    if (['NEWTICK', 'UPDATE'].includes(r.type) && r.position) this.position = r.position;
    if (r.type === 'AOE') {
      this.aoe++;
      this.pending.push({ record: r, near: this.position && r.position && typeof r.radius === 'number'
        ? distance(this.position, r.position) <= r.radius + 0.5 : undefined });
    }
    if (r.type === 'AOEACK') {
      this.ack++; this.position = r.position;
      const inside = this.spatial && r.position ? this.pending.findIndex(p => p.record.position
        && typeof p.record.radius === 'number' && distance(r.position!, p.record.position) <= p.record.radius + 0.5) : -1;
      return this.pending.splice(inside < 0 ? 0 : inside, 1)[0]?.record;
    }
    if (['MAPINFO', 'CREATESUCCESS', 'RECONNECT', 'DEATH', 'ESCAPE'].includes(r.type)) {
      this.censored += this.pending.length; this.pending = []; this.position = undefined;
    }
  }
  summary(client: string, now: number): string {
    this.expire(now);
    return `[${client}] heuristic spatial-first: AOE=${this.aoe} AOEACK=${this.ack} no ACK within 1500ms=${this.unacked} near(radius+0.5)=${this.near} position unknown=${this.unknown} pending=${this.pending.length} unacked-outside=${this.unacked - this.near - this.unknown} boundary-censored=${this.censored}`;
  }
}
