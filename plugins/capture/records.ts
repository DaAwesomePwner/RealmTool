import type { ClientConnection } from '../../src/plugins/api.ts';
import type { Packet } from '../../src/protocol/Packet.ts';

export const PACKETS = ['MAPINFO', 'CREATESUCCESS', 'AOE', 'AOEACK', 'DAMAGE', 'NEWTICK', 'UPDATE', 'DEATH', 'RECONNECT', 'ESCAPE'] as const;
export interface Position { x: number; y: number }
export interface RecordLine {
  client: string; dir: string; type: string; t: number; iso: string;
  position?: Position; radius?: number; seq?: number;
  stats?: Record<string, number>;
  [key: string]: unknown;
}
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function position(v: any): Position | undefined {
  return numeric(v?.x) && numeric(v?.y) ? { x: v.x, y: v.y } : undefined;
}
export class Records {
  private clients = new Map<ClientConnection, { id: string; owner: number; stats: Record<string, number>; position?: Position; positionAt?: number }>();
  private sequence = 0;
  private nextClient = 0;
  id(client: ClientConnection): string | undefined { return this.clients.get(client)?.id; }
  disconnect(client: ClientConnection): string | undefined {
    const id = this.id(client); this.clients.delete(client); return id;
  }
  record(client: ClientConnection, packet: Packet, allDamage: boolean): RecordLine | undefined {
    const type = packet.name;
    if (!(PACKETS as readonly string[]).includes(type) || !packet.isDefined) return;
    const dir = ['AOEACK', 'ESCAPE'].includes(type) ? 'client' : 'server';
    if (packet.direction !== dir) return;
    let state = this.clients.get(client);
    if (!state) {
      state = { id: `c${++this.nextClient}`, owner: client.playerData.ownerObjectId, stats: {} };
      this.clients.set(client, state);
    }
    const now = performance.now();
    const d = packet.data;
    const fields: Record<string, unknown> = {};
    const numbers = (keys: string[]) => { for (const key of keys) if (numeric(d[key])) fields[key] = d[key]; };
    if (type === 'MAPINFO') {
      if (typeof d.name === 'string') fields.name = d.name;
      state.stats = {}; state.owner = 0; state.position = undefined; state.positionAt = undefined;
    } else if (type === 'CREATESUCCESS') {
      if (!numeric(d.objectId)) return;
      state.owner = d.objectId; state.stats = {}; state.position = undefined; state.positionAt = undefined; fields.objectId = d.objectId;
    } else if (type === 'AOE') {
      numbers(['radius', 'damage', 'effect', 'color']);
      if (numeric(d.effectDuration)) fields.duration = d.effectDuration;
      if (numeric(d.originType)) fields.origType = d.originType;
      fields.position = position(d.position); fields.seq = ++this.sequence;
    } else if (type === 'AOEACK') {
      numbers(['time']); fields.position = position(d.position);
    } else if (type === 'DAMAGE') {
      if (!allDamage && (!state.owner || d.targetId !== state.owner)) return;
      numbers(['targetId', 'damageAmount', 'objectId', 'bulletId']);
      if (Array.isArray(d.effects)) fields.effects = d.effects.filter(numeric);
    } else if (type === 'NEWTICK' || type === 'UPDATE') {
      const statuses = type === 'NEWTICK' ? d.statuses : d.newObjs?.map((o: any) => o?.status);
      const own = Array.isArray(statuses) ? statuses.find(s => state!.owner !== 0 && s?.objectId === state!.owner) : undefined;
      if (!own || !Array.isArray(own.data)) return;
      const next = { ...state.stats };
      if (type === 'UPDATE') { next['29'] = 0; next['95'] = 0; }
      for (const stat of own.data) if ([0, 1, 21, 29, 95].includes(stat?.id) && numeric(stat.value)) next[stat.id] = stat.value;
      const changed = !Object.keys(next).every(k => next[k] === state!.stats[k]);
      const pos = position(own.position);
      if (pos && (!state.position || Math.hypot(pos.x - state.position.x, pos.y - state.position.y) >= 0.1)
        && (state.positionAt === undefined || now - state.positionAt >= 100)) {
        fields.position = pos; state.position = pos; state.positionAt = now;
      }
      if (!changed && !fields.position) return;
      if (changed) { state.stats = next; fields.stats = { ...next }; }
    }
    return { client: state.id, dir, type, t: now, iso: new Date().toISOString(), ...fields };
  }
}
