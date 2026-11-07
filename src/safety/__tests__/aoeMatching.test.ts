import { expect, it } from 'vitest';
import { createFactory } from '../../protocol/schema.ts';
import { SafetyEngine } from '../SafetyEngine.ts';

const factory = createFactory();
function fixture(reactionMs = 400) {
  let now = 1000, observation = 0;
  const engine = new SafetyEngine(() => {});
  engine.configure({ enabled: true, preHitPrediction: true, reactionMs }, now);
  const send = (name: string, data: Record<string, unknown>, client = false) => {
    const packet = factory.createByName(name);
    packet.isDefined = true; packet.direction = client ? 'client' : 'server'; packet.data = data;
    engine.observe(packet, now, ++observation);
  };
  send('MAPINFO', { name: 'Realm' });
  send('CREATESUCCESS', { objectId: 1 });
  send('UPDATE', { newObjs: [{ status: { objectId: 1,
    data: [{ id: 0, value: 1000 }, { id: 1, value: 1000 }] } }] });
  return { engine, send,
    area: (x: number, damage = 70) => send('AOE', { position: { x, y: 0 }, radius: 1, damage }),
    ack: (position: unknown = { x: 0, y: 0 }) => send('AOEACK', { time: now, position }, true),
    time: (ms: number, advance = false) => { now += ms; if (advance) engine.advance(now); },
    damage: () => engine.predictor.pendingDamage,
  };
}

it.each([
  [false, true, 90], [true, false, 70], [true, true, 160],
] as const)('ack-every-AoE charges exactly the hits (A=%s B=%s)', (a, b, damage) => {
  const f = fixture();
  f.area(a ? 0 : 10, 70); f.area(b ? 0 : 10, 90);
  f.ack(); f.ack();
  expect(f.damage()).toBe(damage);
});

it.each([false, true])('ack-only-hits skips misses (A hits=%s) and expires the remainder', a => {
  const f = fixture();
  f.area(a ? 0 : 10, 70); f.area(a ? 10 : 0, 90);
  f.ack();
  expect(f.damage()).toBe(a ? 70 : 90);
  f.time(1001, true);
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 1');
  // The miss no longer occupies one of the 128 correspondence slots.
  for (let i = 0; i < 128; ++i) f.area(10);
  expect(f.engine.predictor.fault).toBeNull();
  expect(f.damage()).toBe(a ? 70 : 90);
});

it('consumes the oldest containing area, including the half-unit margin', () => {
  const f = fixture();
  f.area(10, 300); f.area(1.5, 70); f.area(0, 90);
  f.ack(); expect(f.damage()).toBe(70);
  f.ack(); expect(f.damage()).toBe(160);
  f.ack(); expect(f.damage()).toBe(160);
});

it.each([400, 800])('prunes before ACK at freshness max(1000, 2*%s), preserving the boundary', reactionMs => {
  const f = fixture(reactionMs), window = Math.max(1000, 2 * reactionMs);
  f.area(0, 300); f.time(window); f.ack();
  expect(f.damage()).toBe(300);
  f.area(0, 500); f.time(window + 1); f.ack();
  expect(f.damage()).toBe(500); // Missing area assumes 200, not expired raw damage.
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 1');
});

it('prunes before capacity checks even when no advance or ACK arrives', () => {
  const f = fixture();
  for (let i = 0; i < 128; ++i) f.area(10);
  f.time(1001); f.area(0, 90); f.ack();
  expect(f.engine.predictor.fault).toBeNull();
  expect(f.damage()).toBe(90);
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 128');
});

it.each([null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '0', y: 0 }])(
  'an invalid ACK position %j never proves a miss and falls back to oldest', position => {
    const f = fixture();
    f.area(10, 70); f.area(0, 90);
    f.ack(position); expect(f.damage()).toBe(70);
    f.ack(); expect(f.damage()).toBe(160);
  },
);

it('a missing ACK position never proves a miss', () => {
  const f = fixture(); f.area(10, 70);
  f.send('AOEACK', {}, true);
  expect(f.damage()).toBe(70);
});

it.each([70, 300])('unknown conditions retain the max(200, raw=%s) assumption', raw => {
  const f = fixture();
  f.send('NEWTICK', { tickId: 1, statuses: [{ objectId: 1, data: [{ id: 29, value: NaN }] }] });
  f.area(10, raw); f.ack();
  expect(f.damage()).toBe(Math.max(200, raw));
});

it('missing correspondence assumes 200 damage', () => {
  const f = fixture(); f.ack();
  expect(f.damage()).toBe(200);
});
