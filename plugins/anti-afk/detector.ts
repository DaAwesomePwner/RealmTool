// Adapted from realm-engine-client client/src/util/antiAfk.ts @ 88a66b2 (MIT, see NOTICE).
import type { ClientConnection } from '../../src/plugins/api.ts';

export const MAX_MOVE_GAP_MS = 10_000;
interface Observation { x: number; y: number; seenAt: number; idleSince: number }

/** Read-only inactivity detection; packet timestamps are not clocks. */
export class InactivityDetector {
  private sessions = new WeakMap<ClientConnection, Observation>();
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  clear(): void { this.sessions = new WeakMap(); }
  reset(client: ClientConnection): void { this.sessions.delete(client); }
  active(client: ClientConnection): void {
    const observation = this.sessions.get(client);
    if (observation) observation.idleSince = this.now();
  }
  idleMs(client: ClientConnection): number | null {
    const observation = this.sessions.get(client);
    return observation ? this.now() - observation.idleSince : null;
  }
  observeMove(client: ClientConnection, records: unknown, idleMs: number): boolean {
    let position: { x: number; y: number } | undefined;
    if (client.connected && Array.isArray(records)) {
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i];
        if (record && !Array.isArray(record) && Number.isFinite(record.x) && Number.isFinite(record.y)) {
          position = { x: record.x, y: record.y }; break;
        }
      }
    }
    if (!position) { this.reset(client); return false; }
    const now = this.now(), previous = this.sessions.get(client);
    if (!previous || now - previous.seenAt > MAX_MOVE_GAP_MS
      || position.x !== previous.x || position.y !== previous.y) {
      this.sessions.set(client, { ...position, seenAt: now, idleSince: now }); return false;
    }
    previous.seenAt = now;
    if (now - previous.idleSince <= idleMs) return false;
    previous.idleSince = now; // Consume even a skipped pulse; never queue or retry.
    return true;
  }
}
