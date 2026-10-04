import type { Packet } from '../protocol/Packet.ts';

/** StatType NameStat in realm-engine-client client/src/constants/StatType.ts @ 88a66b2. */
export const NAME_STAT = 31;
export const IDENTITY_PACKETS: ReadonlySet<string> = new Set(['CREATESUCCESS', 'UPDATE', 'NEWTICK']);

interface StatusLike { objectId?: unknown; data?: unknown }

/** The local player's object id and name, learned from the server stream. */
export class PlayerIdentity {
  name = '';
  ownerObjectId = 0;

  observe(packet: Packet): void {
    if (!packet.isDefined) return;
    if (packet.name === 'CREATESUCCESS') {
      const objectId = Number(packet.data.objectId);
      this.ownerObjectId = Number.isInteger(objectId) && objectId > 0 ? objectId : 0;
      this.name = '';
      return;
    }
    if (!this.ownerObjectId) return;
    if (packet.name === 'UPDATE' && Array.isArray(packet.data.newObjs)) {
      for (const entity of packet.data.newObjs) this.status(entity?.status);
    } else if (packet.name === 'NEWTICK' && Array.isArray(packet.data.statuses)) {
      for (const status of packet.data.statuses) this.status(status);
    }
  }

  private status(status: StatusLike | null | undefined): void {
    if (!status || status.objectId !== this.ownerObjectId || !Array.isArray(status.data)) return;
    for (const stat of status.data) {
      if (stat?.id === NAME_STAT && typeof stat.value === 'string' && stat.value) this.name = stat.value;
    }
  }
}
