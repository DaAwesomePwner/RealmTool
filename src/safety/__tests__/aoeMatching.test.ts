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
  [false, true, 180], [true, false, 70], [true, true, 180],
] as const)('ack-every-AoE preserves conservative charges (A=%s B=%s)', (a, b, damage) => {
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
  f.ack(); expect(f.damage()).toBe(90);
  f.ack(); expect(f.damage()).toBe(180);
  f.ack(); expect(f.damage()).toBe(270); // FIFO's third ACK still charged the final hit.
});

it.each([400, 800])('prunes before ACK at freshness max(1000, 2*%s), preserving the boundary', reactionMs => {
  const f = fixture(reactionMs), window = Math.max(1000, 2 * reactionMs);
  f.area(0, 300); f.time(window); f.ack();
  expect(f.damage()).toBe(300);
  f.area(0, 500); f.time(window + 1); f.ack();
  expect(f.damage()).toBe(800); // Late ACK retains the expired area's raw damage.
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 1');
});

it('prunes before capacity checks even when no advance or ACK arrives', () => {
  const f = fixture();
  for (let i = 0; i < 128; ++i) f.area(10);
  f.time(1001); f.area(0, 90); f.ack();
  expect(f.engine.predictor.fault).toBeNull();
  expect(f.damage()).toBe(200); // The old FIFO would assume 200 for its stale first area.
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 128');
});

it.each([null, {}, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '0', y: 0 }])(
  'an invalid ACK position %j never proves a miss and charges the largest fresh raw', position => {
    const f = fixture();
    f.area(10, 70); f.area(0, 90);
    f.ack(position); expect(f.damage()).toBe(90);
    f.ack(); expect(f.damage()).toBe(180);
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

it.each([
  [10, 900, 1], [900, 10, 1], [10, 900, 2], [900, 10, 2],
])('overlap charges the largest raw (%s then %s; %s ACKs)', (first, second, acks) => {
  const f = fixture(); f.area(0, first); f.area(.5, second);
  f.ack({ x: .2, y: 0 }); expect(f.damage()).toBe(900);
  if (acks === 2) {
    f.ack({ x: .2, y: 0 });
    expect(f.damage()).toBe(900 + second);
  }
});

it('late ACK matches expired damage before a fresh area can prove a miss', () => {
  const f = fixture(); f.area(0, 900); f.time(1001);
  f.area(10, 70); f.ack();
  expect(f.damage()).toBe(900);
  f.ack({ x: 10, y: 0 }); expect(f.damage()).toBe(970);
});

it('a fresh low-damage hit cannot undercut FIFO stale high damage', () => {
  const f = fixture(); f.area(0, 900); f.time(1001);
  f.area(0, 10); f.ack();
  expect(f.damage()).toBe(900);
});

it('retains the FIFO floor beyond the recent-expiry window until old cleanup', () => {
  const f = fixture(); f.area(0, 900); f.time(5000, true); f.ack();
  expect(f.damage()).toBe(900);
});

it('an invalid late ACK uses the largest recently expired raw', () => {
  const f = fixture(); f.area(0, 10); f.area(10, 900); f.time(1001);
  f.ack(null); expect(f.damage()).toBe(900);
});

it('expiry counts aggregate without hiding an important coverage note', () => {
  const f = fixture(); f.area(10); f.time(1001, true);
  f.area(10); f.time(1001, true);
  expect(f.engine.status().prediction?.coverage).toBe('expired-unacknowledged AoEs: 2');
  f.engine.predictor.noteCoverage('ambiguous DAMAGE occurrence; reported assumptions retained');
  f.area(10); f.time(1001, true);
  expect(f.engine.status().prediction?.coverage).toBe('ambiguous DAMAGE occurrence; reported assumptions retained');
});

it('reset and mode changes clear all AoE correspondence including FIFO and recent expiry', () => {
  for (const reset of [true, false]) {
    const f = fixture(); f.area(0, 900); f.time(1001, true);
    if (reset) f.send('MAPINFO', { name: 'Realm' });
    else {
      f.engine.configure({ preHitPrediction: false }, 2001);
      f.engine.configure({ preHitPrediction: true }, 2001);
    }
    f.ack(); expect(f.damage()).toBe(200);
  }
});

it('never charges less per ACK than the original FIFO across mixed deterministic sequences', () => {
  for (let seed = 1; seed <= 40; ++seed) {
    const f = fixture();
    let random = seed, now = 1000, cleanup = 0;
    let fifo: { x: number; raw: number; at: number }[] = [];
    const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
    for (let step = 0; step < 80; ++step) {
      if (next() % 3 !== 0) {
        const x = next() % 3, raw = next() % 1000;
        f.area(x, raw);
        if (fifo.length < 128) fifo.push({ x, raw, at: now });
      } else {
        const x = next() % 3, invalid = next() % 4 === 0;
        const area = fifo.shift();
        const floor = !area || now - area.at > 1000 ? Math.max(200, area?.raw ?? 0)
          : invalid || Math.abs(x - area.x) <= 1.5 ? area.raw : 0;
        const before = f.damage();
        f.ack(invalid ? null : { x, y: 0 });
        expect(f.damage() - before, `seed=${seed}, step=${step}`).toBeGreaterThanOrEqual(floor);
      }
      const elapsed = [0, 10, 1001, 5000, 11000][next() % 5];
      const advance = next() % 2 === 0;
      now += elapsed; f.time(elapsed, advance);
      if (advance && now - cleanup >= 1000) {
        cleanup = now; fifo = fifo.filter(area => now - area.at <= 10000);
      }
    }
  }
});

it.each([null, undefined])('invalid late position %s considers expired damage despite fresh areas', position => {
  const f = fixture(); f.area(10, 10); f.area(0, 900); f.time(1001);
  f.area(20, 70);
  f.send('AOEACK', { position }, true);
  expect(f.damage()).toBe(900);
});

it('a valid late ACK charges and consumes the largest overlapping expired area', () => {
  const f = fixture(); f.area(0, 10); f.area(.5, 900); f.time(1001);
  f.ack(); expect(f.damage()).toBe(900);
  // The remaining expired area costs 200, but FIFO's second ACK still costs 900.
  f.ack(); expect(f.damage()).toBe(1800);
});

it('missing position and unknown conditions charge the largest fresh raw', () => {
  const f = fixture();
  f.send('NEWTICK', { tickId: 1, statuses: [{ objectId: 1, data: [{ id: 29, value: NaN }] }] });
  f.area(10, 70); f.area(20, 900); f.send('AOEACK', {}, true);
  expect(f.damage()).toBe(900);
});
