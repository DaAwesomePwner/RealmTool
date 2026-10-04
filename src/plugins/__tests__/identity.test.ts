import { describe, expect, it } from 'vitest';
import { createPacket } from '../../protocol/Packet.ts';
import { IDENTITY_PACKETS, NAME_STAT, PlayerIdentity } from '../identity.ts';

const packet = (name: string, data: Record<string, unknown>) => {
  const p = createPacket(1, name, 'server');
  p.isDefined = true;
  p.data = data;
  return p;
};
const status = (objectId: number, stats: { id: number; value: unknown }[]) =>
  ({ objectId, position: { x: 0, y: 0 }, data: stats.map(s => ({ ...s, stackCount: 0 })) });

describe('PlayerIdentity', () => {
  it('learns the owner object from CREATESUCCESS and the name from its own status only', () => {
    const id = new PlayerIdentity();
    id.observe(packet('CREATESUCCESS', { objectId: 77, charId: 1, stats: '' }));
    expect(id).toMatchObject({ ownerObjectId: 77, name: '' });
    id.observe(packet('UPDATE', { newObjs: [
      { objectType: 1, status: status(12, [{ id: NAME_STAT, value: 'Someone' }]) },
      { objectType: 2, status: status(77, [{ id: 0, value: 500 }, { id: NAME_STAT, value: 'Me' }]) },
    ] }));
    expect(id.name).toBe('Me');
    id.observe(packet('NEWTICK', { statuses: [status(77, [{ id: NAME_STAT, value: 'MeRenamed' }])] }));
    expect(id.name).toBe('MeRenamed');
  });

  it('ignores names before CREATESUCCESS, bad shapes and empty names, and resets on a new CREATESUCCESS', () => {
    const id = new PlayerIdentity();
    id.observe(packet('NEWTICK', { statuses: [status(0, [{ id: NAME_STAT, value: 'Ghost' }])] }));
    expect(id.name).toBe('');
    id.observe(packet('CREATESUCCESS', { objectId: 5 }));
    id.observe(packet('UPDATE', { newObjs: [null, { status: null }, { status: status(5, [{ id: NAME_STAT, value: '' }]) }] }));
    expect(id.name).toBe('');
    id.observe(packet('NEWTICK', { statuses: [status(5, [{ id: NAME_STAT, value: 'Me' }])] }));
    id.observe(packet('CREATESUCCESS', { objectId: 9 }));
    expect(id).toMatchObject({ ownerObjectId: 9, name: '' });
  });

  it('lists the packets it needs', () => {
    expect([...IDENTITY_PACKETS].sort()).toEqual(['CREATESUCCESS', 'NEWTICK', 'UPDATE']);
  });
});
