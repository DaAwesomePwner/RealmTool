import { expect, it } from 'vitest';
import { createFactory } from '../../protocol/schema.ts';
import { SafetyEngine } from '../SafetyEngine.ts';

function fixture() {
  const factory = createFactory(), engine = new SafetyEngine(() => {});
  let now = 1000, observation = 0, tick = 0;
  engine.configure({ enabled: true, preHitPrediction: true }, now);
  const send = (name: string, data: Record<string, unknown>, client = false) => {
    const packet = factory.createByName(name);
    packet.isDefined = true; packet.direction = client ? 'client' : 'server'; packet.data = data;
    engine.observe(packet, now, ++observation);
    return observation;
  };
  send('MAPINFO', { name: 'Realm' }); send('CREATESUCCESS', { objectId: 1 });
  send('UPDATE', { newObjs: [{ status: { objectId: 1,
    data: [{ id: 0, value: 1000 }, { id: 1, value: 1000 }] } }] });
  return { engine, send,
    area: (x: number, damage: number) => send('AOE', { position: { x, y: 0 }, radius: 1, damage }),
    ack: () => send('AOEACK', { position: { x: 0, y: 0 } }, true),
    advance: (ms: number) => { now += ms; engine.advance(now); },
    tick: (hp?: number) => send('NEWTICK', { tickId: ++tick, serverLastRttMs: 80,
      statuses: [{ objectId: 1, data: hp === undefined ? [] : [{ id: 1, value: hp }] }] }),
    deliver: (id: number) => engine.reportDelivered(id, now, true),
    damage: () => engine.predictor.pendingDamage,
  };
}

it.each([
  { semantics: 'every AoE', positions: [10, 0, 0], raw: [300, 70, 90], old: [0, 70, 90], fresh: [90, 90, 0] },
  { semantics: 'only hits', positions: [10, 0, 0], raw: [300, 70, 90], old: [0, 70], fresh: [90, 90] },
  { semantics: 'every late AoE', positions: [0, 0], raw: [10, 900], old: [200, 900], fresh: [900, 200], late: true },
  { semantics: 'only late hits', positions: [10, 0], raw: [10, 900], old: [200], fresh: [900], late: true },
])('cumulative charge equals max(OLD, NEW) after every ACK: $semantics', row => {
  const f = fixture();
  row.positions.forEach((x, i) => f.area(x, row.raw[i]));
  if (row.late) f.advance(1001);
  let old = 0, fresh = 0;
  row.old.forEach((charge, i) => {
    old += charge; fresh += row.fresh[i]; f.ack();
    expect(f.damage()).toBe(Math.max(old, fresh));
    expect(f.damage()).toBeGreaterThanOrEqual(old);
  });
});

it('does not double count a hit when FIFO and matching consume different areas', () => {
  const f = fixture(); f.area(10, 70); f.area(0, 90);
  const first = f.ack(); expect(f.damage()).toBe(90);
  const second = f.ack(); expect(f.damage()).toBe(90);
  const impacts = f.engine.predictor.evidence(1000).impacts;
  expect(impacts.map(impact => impact.amount)).toEqual([90, 0]);
  expect(new Set(impacts.map(impact => impact.id)).size).toBe(2);
  f.deliver(first); f.deliver(second);
  expect(f.engine.predictor.evidence(1000).impacts.every(impact => impact.writtenAt === 1000)).toBe(true);
});

it('keeps the cap through partial settlement and retires zero impacts normally', () => {
  const f = fixture(); f.tick(); f.advance(200); f.tick(); f.advance(200); f.tick();
  f.area(10, 70); f.area(0, 90);
  const first = f.ack(); f.deliver(first);
  f.advance(200); f.tick(950); // Partial credit, still inside grace.
  expect(f.damage()).toBe(40);
  const second = f.ack(); f.deliver(second);
  expect(f.damage()).toBe(40); // FIFO catch-up adds zero, not another 90.
  f.advance(200); f.tick(); f.advance(200); f.tick();
  expect(f.engine.predictor.pendingCount).toBe(1); // Zero ACK still inside its own grace.
  expect(f.damage()).toBe(0);
  f.advance(200); f.tick();
  expect(f.engine.predictor.pendingCount).toBe(0);
  f.area(0, 80); f.ack();
  expect(f.damage()).toBe(80);
});

it.each(['clearDebt', 'mode', 'epoch', 'settled'] as const)(
  'starts a fresh accounting window after %s, even with unconsumed areas', reset => {
    const f = fixture(); f.tick(); f.advance(200); f.tick(); f.advance(200); f.tick();
    f.area(10, 70); f.area(0, 90); const ack = f.ack();
    if (reset === 'clearDebt') f.engine.predictor.clearDebt();
    if (reset === 'mode') {
      f.engine.configure({ preHitPrediction: false }, 1400);
      f.engine.configure({ preHitPrediction: true }, 1400);
    }
    if (reset === 'epoch') {
      f.send('MAPINFO', { name: 'Realm' });
      f.send('CREATESUCCESS', { objectId: 1 });
      f.send('UPDATE', { newObjs: [{ status: { objectId: 1,
        data: [{ id: 0, value: 1000 }, { id: 1, value: 1000 }] } }] });
    }
    if (reset === 'settled') {
      f.deliver(ack);
      for (let i = 0; i < 3; ++i) { f.advance(200); f.tick(); }
      expect(f.engine.predictor.pendingCount).toBe(0);
    }
    f.area(0, 80); f.ack();
    // A leftover FIFO hit contributes 90 in clearDebt/settled; a cleared queue contributes 80.
    expect(f.damage()).toBe(reset === 'mode' || reset === 'epoch' ? 80 : 90);
  },
);

it('ageing or retiring unacknowledged areas does not erase totals with live impacts', () => {
  const f = fixture();
  const miss = f.area(10, 70); f.area(0, 90); f.ack();
  f.engine.retireArea(miss);
  f.advance(11001); // Correspondence ages out, but held impacts cannot retire.
  f.ack(); // Both models now assume 200: OLD=200, NEW=290.
  expect(f.damage()).toBe(290);
  expect(f.engine.predictor.pendingCount).toBe(2);
});

it('caps OLD-leading then NEW-catching-up ACKs without summing their maxima', () => {
  const f = fixture(); f.area(0, 900); f.advance(1001); f.area(0, 10);
  f.ack(); expect(f.damage()).toBe(900); // OLD=900, NEW=10.
  f.ack(); expect(f.damage()).toBe(910); // OLD=910, NEW=910.
  expect(f.engine.predictor.evidence(2001).impacts.map(impact => impact.amount)).toEqual([900, 10]);
});

it('overlap remains capped to max(OLD=160, NEW=180), not the sum of both', () => {
  const f = fixture(); f.area(0, 70); f.area(0, 90);
  f.ack(); expect(f.damage()).toBe(90); // OLD=70, NEW=90.
  f.ack(); expect(f.damage()).toBe(180); // Largest-containing-raw NEW is intentionally conservative.
});
