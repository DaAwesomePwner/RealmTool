// Adapted from realm-engine-client client/src/proxy/__tests__/autoEscapeReportGuard.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createFactory } from '../../protocol/schema.ts';
import { EscapeAttemptCoordinator } from '../EscapeAttemptCoordinator.ts';
import { SafetyEngine } from '../SafetyEngine.ts';
import { safetySettings, type EscapeWriteReceipt, type SafetyDecision, type SafetySettings } from '../SafetyTypes.ts';
import { AutoEscapeReportGuard } from '../AutoEscapeReportGuard.ts';

const factory = createFactory();
/** Real decisions/receipts, with independently controlled enqueue and completion. */
function fixture(settings: Partial<SafetySettings> = {}) {
  let now = 1000, tick = 0, generation = 1;
  let guard = new AutoEscapeReportGuard(generation);
  const io = { available: true, mode: 'accept' as 'accept' | 'reject' | 'throw' | 'sync-error', observerThrows: false };
  const writes: ((error?: Error | null) => void)[] = [];
  const decisions: SafetyDecision[] = [], receipts: EscapeWriteReceipt[] = [];
  const events: { type: string; suppressed: boolean }[] = [];
  const record = (type: string) => events.push({ type, suppressed: guard.suppresses(true, 'MOVE') });
  const engine = new SafetyEngine((decision, accepted) => {
    if (accepted) guard.activate(decision, engine.attempts);
    decisions.push(decision); record('decision');
  }, {
    now: () => now, available: () => io.available, blocked: () => false,
    write: done => {
      writes.push(done); record('write');
      if (io.mode === 'throw') throw new Error('enqueue threw');
      if (io.mode === 'sync-error') done(new Error('enqueue failed'));
      return io.mode !== 'reject';
    },
  }, receipt => {
    guard.activate(receipt, engine.attempts);
    receipts.push(receipt); record('receipt');
    if (io.observerThrows) throw new Error('external receipt observer');
  });
  engine.connectionChanged(generation);
  engine.configure({ enabled: true, burstGuard: false, retryCount: 1, ...settings }, now);
  const emit = (name: string, data: Record<string, unknown> = {}, fromClient = false) => {
    const packet = factory.createByName(name);
    packet.direction = fromClient ? 'client' : 'server';
    packet.isDefined = true; packet.data = data; engine.observe(packet, now);
  };
  const health = (hp: number) => emit('NEWTICK', { tickId: ++tick, statuses: [{ objectId: 1, data: [
    { id: 0, value: 1000 }, { id: 1, value: hp }, { id: 29, value: 0 }, { id: 95, value: 0 },
  ] }] });
  const enter = (map = 'Realm') => {
    tick = 0; emit('MAPINFO', { name: map }); emit('CREATESUCCESS', { objectId: 1 }); health(600);
  };
  enter();
  return { engine, io, writes, decisions, receipts, events, emit, health, enter,
    get guard() { return guard; },
    manual: () => engine.request(now, 'manual nexus', true),
    complete: (index = writes.length - 1, error?: Error) => writes[index](error),
    advance: (ms: number) => { now += ms; engine.advance(now); },
    configure: (value: Partial<SafetySettings>) => engine.configure(value, now),
    replaceConnection: () => { guard = new AutoEscapeReportGuard(++generation); engine.connectionChanged(generation); },
  };
}

it('arms on automatic local acceptance before either telemetry hook, without waiting for completion', () => {
  const f = fixture();
  f.emit('PLAYERHIT', { objectId: 99, bulletId: 1 }, true); f.health(251);
  expect(f.writes).toHaveLength(0); expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
  f.health(250);
  expect(f.decisions[0]).toMatchObject({ origin: 'automatic', confirmedHp: 250, thresholdHp: 250,
    reason: 'server HP threshold', evidence: { preHitPrediction: false, pendingCount: 0 } });
  expect(f.receipts[0]).toMatchObject({ accepted: true, completedAt: null, failed: false });
  expect(f.events).toEqual([
    { type: 'write', suppressed: false }, { type: 'receipt', suppressed: true }, { type: 'decision', suppressed: true },
  ]);
});

it('suppresses exactly the four client reports, irrespective of server packet names', () => {
  const f = fixture(); f.health(250);
  for (const name of ['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE', 'MOVE']) {
    expect(f.guard.suppresses(true, name)).toBe(true);
    expect(f.guard.suppresses(false, name)).toBe(false);
  }
  for (const name of ['ESCAPE', 'HELLO', 'PONG', 'RECONNECT', 'PING', 'UPDATE', 'NEWTICK', 'UNKNOWN_255']) {
    expect(f.guard.suppresses(true, name)).toBe(false);
    expect(f.guard.suppresses(false, name)).toBe(false);
  }
});

it('manual acceptance and manual retries alone never arm', () => {
  const f = fixture(); f.manual(); f.complete(); f.advance(400);
  expect(f.writes).toHaveLength(2);
  expect(f.receipts.every(r => r.origin === 'manual' && r.accepted)).toBe(true);
  expect(f.events.every(e => !e.suppressed)).toBe(true);
  f.emit('ESCAPE', {}, true); // Passive game/plugin traffic supplies no automatic decision.
  expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
});

it('only the actual automatic decision can activate from a shared accepted manual receipt', () => {
  const f = fixture(); f.manual();
  expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
  f.health(250);
  expect(f.writes).toHaveLength(1);
  expect(f.events).toEqual([
    { type: 'write', suppressed: false }, { type: 'receipt', suppressed: false },
    { type: 'decision', suppressed: false }, { type: 'decision', suppressed: true },
  ]);
  const receipt = f.engine.attempts.acceptedReceipt(f.decisions[1].attemptId)!;
  expect(receipt).toMatchObject({ origin: 'manual', shared: true, accepted: true, completedAt: null });
  const probe = new AutoEscapeReportGuard(1);
  expect(probe.activate(receipt, f.engine.attempts)).toBe(false);
  expect(probe.activate(f.decisions[0], f.engine.attempts)).toBe(false);
  expect(probe.suppresses(true, 'MOVE')).toBe(false);
  expect(probe.activate(f.decisions[1], f.engine.attempts)).toBe(true);
});

it.each(['reject', 'throw', 'sync-error'] as const)('%s initial enqueues cannot arm, including later callbacks', mode => {
  const f = fixture(); f.io.mode = mode; f.health(250);
  expect(f.engine.attempts.status?.phase).toBe('failed');
  expect(f.guard.activate(f.decisions[0], f.engine.attempts)).toBe(false);
  f.complete(); f.advance(400);
  expect(f.writes).toHaveLength(1);
  expect(f.events.every(e => !e.suppressed)).toBe(true);
});

it.each(['reject', 'throw', 'sync-error'] as const)('%s manual enqueues cannot lend acceptance to an automatic decision', mode => {
  const f = fixture(); f.io.mode = mode; f.manual(); f.health(250);
  expect(f.decisions.map(d => d.origin)).toEqual(['manual', 'automatic']);
  expect(f.guard.activate(f.decisions[1], f.engine.attempts)).toBe(false);
  expect(f.events.every(e => !e.suppressed)).toBe(true);
});

it('unavailability produces no accepted write or suppression', () => {
  const f = fixture(); f.io.available = false; f.health(250);
  const attempt = f.engine.attempts.begin('automatic', 1000, f.engine.settings)!;
  expect(f.engine.attempts.writeInitial(attempt.id)).toBe(false);
  expect(f.engine.attempts.status).toMatchObject({ phase: 'failed', failure: 'unavailable' });
  expect(f.engine.attempts.acceptedReceipt(attempt.id)).toBeNull();
  expect(f.writes).toHaveLength(0); expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
});

it('arms an OWN automatic retry inside its receipt observer, without a decision hook or another tick', () => {
  let now = 1000;
  const guard = new AutoEscapeReportGuard(1), settings = safetySettings({ enabled: true, retryCount: 1 });
  const writes: (() => void)[] = [], observed: boolean[] = [];
  const attempts = new EscapeAttemptCoordinator({ now: () => now, available: () => true, blocked: () => false,
    write: done => { writes.push(done); return true; },
  }, receipt => { guard.activate(receipt, attempts); observed.push(guard.suppresses(true, 'MOVE')); });
  attempts.replaceConnection(1);
  const manual = attempts.begin('manual', now, settings)!; attempts.writeInitial(manual.id);
  const automatic = attempts.begin('automatic', now, settings)!; attempts.writeInitial(automatic.id);
  expect(attempts.acceptedReceipt(automatic.id)).toMatchObject({ shared: true, origin: 'manual' });
  writes[0](); expect(observed).toEqual([false, false]);
  now += 400; attempts.advance(now);
  expect(writes).toHaveLength(2);
  expect(observed).toEqual([false, false, true]);
  expect(attempts.acceptedReceipt(automatic.id)).toMatchObject({ shared: false, origin: 'automatic', completedAt: null });
});

it('accepts Node write(false) backpressure as a local enqueue and arms before completion', () => {
  const callbacks: (() => void)[] = [], socketReturns: boolean[] = [];
  const stream = new Writable({ highWaterMark: 1, write(_data, _encoding, done) { callbacks.push(done); } });
  const guard = new AutoEscapeReportGuard(1);
  const attempts = new EscapeAttemptCoordinator({ now: () => 1000, available: () => !stream.destroyed,
    blocked: () => stream.writableNeedDrain,
    write: done => { socketReturns.push(stream.write(Buffer.alloc(5), done)); return true; },
  }, receipt => { guard.activate(receipt, attempts); });
  attempts.replaceConnection(1);
  try {
    const attempt = attempts.begin('automatic', 1000, safetySettings({ enabled: true }))!;
    expect(attempts.writeInitial(attempt.id)).toBe(true);
    expect(socketReturns).toEqual([false]);
    expect(attempts.acceptedReceipt(attempt.id)).toMatchObject({ accepted: true, completedAt: null });
    expect(guard.suppresses(true, 'MOVE')).toBe(true);
  } finally { callbacks.forEach(done => done()); stream.destroy(); }
});

it.each(['MAPINFO', 'CREATESUCCESS', 'settings', 'toggle', 'write-error', 'unconfirmed', 'transition'] as const)(
  '%s cannot release suppression on the original generation', action => {
    const f = fixture({ retryCount: 0 }); f.health(250);
    const decision = f.decisions[0];
    if (action === 'MAPINFO') f.emit('MAPINFO', { name: 'Nexus' });
    if (action === 'CREATESUCCESS') f.emit('CREATESUCCESS', { objectId: 2 });
    if (action === 'settings') { f.configure({ notification: false }); f.configure({ thresholdPct: 0 }); }
    if (action === 'toggle') { f.configure({ enabled: false }); f.configure({ enabled: true }); }
    if (action === 'write-error') f.complete(0, new Error('late write error'));
    if (action === 'unconfirmed') { f.complete(); f.advance(800); }
    if (action === 'transition') f.engine.confirmTransition(1001);
    f.guard.activate(decision, f.engine.attempts); // A now-ineligible activation cannot clear an existing latch.
    expect(f.guard.suppresses(true, 'MOVE')).toBe(true);
    f.replaceConnection();
    expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
  });

it.each(['attemptId', 'connectionGeneration', 'epoch', 'lifecycleRevision'] as const)(
  'rejects a stale %s in both decisions and write notifications', field => {
    const f = fixture(); f.health(250);
    for (const trigger of [f.decisions[0], f.receipts[0]]) {
      const probe = new AutoEscapeReportGuard(1);
      expect(probe.activate({ ...trigger, [field]: trigger[field] + 1 }, f.engine.attempts)).toBe(false);
      expect(probe.suppresses(true, 'MOVE')).toBe(false);
    }
  });

it('rejects unaccepted, failed, shared or wrong-write notifications even beside a live accepted attempt', () => {
  const f = fixture(); f.health(250);
  for (const patch of [{ accepted: false }, { failed: true }, { shared: true }, { writeId: f.receipts[0].writeId + 1 }]) {
    const probe = new AutoEscapeReportGuard(1);
    expect(probe.activate({ ...f.receipts[0], ...patch }, f.engine.attempts)).toBe(false);
    expect(probe.suppresses(true, 'MOVE')).toBe(false);
  }
});

it('a retired same-generation callback cannot authorize the next map attempt', () => {
  const f = fixture(); f.health(250);
  const decision = f.decisions[0], receipt = f.receipts[0];
  f.enter('Snake Pit'); f.health(250); // Old pending write makes the new attempt fail.
  expect(f.engine.attempts.status?.failure).toBe('backpressure');
  f.complete();
  const probe = new AutoEscapeReportGuard(1);
  for (const trigger of [decision, receipt, f.receipts[f.receipts.length - 1], f.decisions[1]]) {
    expect(probe.activate(trigger, f.engine.attempts)).toBe(false);
  }
  expect(probe.suppresses(true, 'MOVE')).toBe(false);
  expect(f.guard.suppresses(true, 'MOVE')).toBe(true);
});

it('new generation releases the guard and old receipts/callbacks cannot arm it', () => {
  const f = fixture(); f.health(250);
  const decision = f.decisions[0], receipt = f.receipts[0];
  f.replaceConnection(); f.enter(); f.complete(0);
  expect(f.events[f.events.length - 1]).toEqual({ type: 'receipt', suppressed: false });
  expect(f.guard.activate(decision, f.engine.attempts)).toBe(false);
  expect(f.guard.activate(receipt, f.engine.attempts)).toBe(false);
  expect(f.guard.suppresses(true, 'MOVE')).toBe(false);
  f.health(250);
  expect(f.writes).toHaveLength(2); expect(f.guard.suppresses(true, 'MOVE')).toBe(true);
  const probe = new AutoEscapeReportGuard(2);
  expect(probe.activate(receipt, f.engine.attempts)).toBe(false);
  expect(probe.activate(f.receipts[f.receipts.length - 1], f.engine.attempts)).toBe(true);
});

it('an external receipt observer exception cannot prevent synchronous arming', () => {
  const f = fixture(); f.io.observerThrows = true; f.health(250);
  expect(f.engine.attempts.status).toMatchObject({ phase: 'queued', failure: null });
  expect(f.guard.suppresses(true, 'MOVE')).toBe(true);
});
