// Adapted from realm-engine-client client/src/safety/__tests__/safetyLifecycle.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createFactory } from '../../protocol/schema.ts';
import { EscapeAttemptCoordinator } from '../EscapeAttemptCoordinator.ts';
import { SafetyEngine } from '../SafetyEngine.ts';
import { DEFAULT_SAFETY_SETTINGS, safetySettings, type SafetyDecision, type SafetySettingsInput } from '../SafetyTypes.ts';

const factory = createFactory();
// Lifecycle assertions inspect the coordinator separately from the compact public status.
const snapshot = (engine: SafetyEngine) => ({ ...engine.status(), attempt: engine.attempts.status });

/** Real engine/coordinator with independently controlled clock and write callbacks. */
function fixture(settings: SafetySettingsInput = {}) {
  let now = 1000, tick = 0;
  const io = { available: true, blocked: false, mode: 'accept' as 'accept' | 'reject' | 'throw' | 'sync-error' };
  const writes: { at: number; done: (error?: Error | null) => void }[] = [];
  const order: string[] = [];
  const decision = vi.fn((d: SafetyDecision, wrote: boolean) => { order.push(`decision:${d.origin}:${wrote}`); });
  const engine = new SafetyEngine(decision, {
    now: () => now, available: () => io.available, blocked: () => io.blocked,
    write: done => {
      writes.push({ at: now, done }); order.push('write');
      if (io.mode === 'throw') throw new Error('write threw');
      if (io.mode === 'sync-error') done(new Error('write failed synchronously'));
      return io.mode !== 'reject';
    },
  });
  engine.configure({ enabled: true, preHitPrediction: false, burstGuard: false, retryCount: 2, retryMs: 400, reactionMs: 400, ...settings }, now);
  engine.setCatalog({ projectiles: [[100, 0, { lifetimeMs: 10000, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] }]], tiles: [] });
  engine.connectionChanged(1);
  function emit(name: string, data: any = {}, fromClient = false, defined = true) {
    const p = factory.createByName(name); p.data = data; p.isDefined = defined;
    p.direction = fromClient ? 'client' : 'server';
    engine.observe(p, now);
  }
  function health(hp?: number) {
    emit('NEWTICK', { tickId: ++tick, statuses: [{ objectId: 1, data: [
      { id: 0, value: 1000 }, { id: 21, value: 0 }, { id: 29, value: 0 }, { id: 95, value: 0 },
      ...(hp === undefined ? [] : [{ id: 1, value: hp }]),
    ] }] });
  }
  function enter(map = 'Realm', hp = 600) {
    tick = 0; emit('MAPINFO', { name: map }); emit('CREATESUCCESS', { objectId: 1 });
    emit('UPDATE', { newObjs: [{ objectType: 100, status: { objectId: 2, data: [] } }] }); health(hp);
  }
  function hit(bullet = 1, damage = 400) {
    emit('ENEMYSHOOT', { ownerId: 2, bulletId: bullet, bulletType: 0, damage, numShots: 1 });
    emit('PLAYERHIT', { objectId: 2, bulletId: bullet }, true);
  }
  enter();
  return { engine, io, writes, order, decision, emit, enter, health, hit,
    now: () => now, advance: (ms: number) => { now += ms; engine.advance(now); },
    complete: (index = writes.length - 1, error?: Error) => writes[index].done(error),
    configure: (value: SafetySettingsInput) => engine.configure(value, now),
    manual: () => engine.request(now, 'manual nexus', true) };
}

it.each([undefined, false, true])('normalizes legacy instantNexus=%s to false without changing threshold or prediction settings', instantNexus => {
  expect(DEFAULT_SAFETY_SETTINGS).toMatchObject({ thresholdPct: 25 });
  expect(safetySettings({ instantNexus })).toEqual({ ...DEFAULT_SAFETY_SETTINGS });
  expect(safetySettings({ instantNexus, thresholdPct: 0 })).toEqual({
    ...DEFAULT_SAFETY_SETTINGS, thresholdPct: 0,
  });
  const f = fixture({ instantNexus });
  expect(f.engine.settings).not.toHaveProperty('instantNexus');
  f.configure({ instantNexus: true });
  expect(f.engine.settings).not.toHaveProperty('instantNexus');
  expect(snapshot(f.engine)).toMatchObject({ attempt: null, confirmedHp: 600, automaticEligible: true });
  expect(f.writes).toHaveLength(0);
});

it.each(['queued', 'written'] as const)('keeps monitoring during a %s manual request and supersedes it only for genuine danger', phase => {
  const f = fixture(); f.manual(); if (phase === 'written') f.complete();
  const manual = f.engine.attempts.status!;
  expect(f.engine.monitoringReady).toBe(true);
  expect(snapshot(f.engine)).toMatchObject({ enabled: true, automaticEligible: true, protectionState: 'monitoring',
    attempt: { origin: 'manual', phase } });
  f.hit(); expect(f.decision).toHaveBeenCalledTimes(1);
  f.health(200); f.emit('PLAYERHIT', { objectId: 2, bulletId: 1 }, true); f.advance(8);
  expect(f.decision.mock.calls.map(([d]) => d.origin)).toEqual(['manual', 'automatic']);
  expect(f.decision.mock.calls[1][0]).toMatchObject({ reason: 'server HP threshold', lowerHp: 200, confirmedHp: 200 });
  expect(f.engine.attempts.status!.id).not.toBe(manual.id);
  expect(f.writes).toHaveLength(phase === 'written' ? 2 : 1);
  if (phase === 'queued') {
    const automatic = f.engine.attempts.status;
    f.complete(0); // A superseded manual callback retires only its own slot.
    expect(f.engine.attempts.status).toMatchObject({ id: automatic!.id, phase: automatic!.phase, failure: automatic!.failure });
    expect(automatic).toMatchObject({ origin: 'automatic', phase: 'queued', failure: null, writeId: null, lastWriteAt: null });
    expect(f.decision.mock.calls[1][1]).toBe(true); // Accepted equivalent write, still physically manual.
    expect(f.engine.attempts.acceptedReceipt(automatic!.id)).toMatchObject({ accepted: true, origin: 'manual', shared: true });
    f.advance(8);
    expect(snapshot(f.engine)).toMatchObject({ protectionState: 'escaping', attempt: { phase: 'written', failure: null } });
    f.advance(384);
    expect(f.writes.map(w => w.at)).toEqual([1000, 1400]); // Normal retry interval, not a failure cooldown.
    expect(f.engine.attempts.status).toMatchObject({ origin: 'automatic', phase: 'queued', lastWriteAt: 1400 });
    expect(f.decision).toHaveBeenCalledTimes(2);
  }
});

it('writes before external decision callbacks for manual and automatic requests', () => {
  const f = fixture(); f.manual(); f.complete(); f.health(200);
  expect(f.order).toEqual(['write', 'decision:manual:true', 'write', 'decision:automatic:true']);
});

it('pending manual supersession retains the original write deadline and never appends another pending ESCAPE', () => {
  const f = fixture(); f.manual(); f.advance(700); f.health(200);
  expect(f.decision.mock.calls[1][1]).toBe(true);
  expect(f.engine.attempts.status).toMatchObject({ origin: 'automatic', phase: 'queued', failure: null, writeId: null });
  f.advance(99); expect(f.engine.phase).toBe('queued');
  f.advance(1); expect(f.engine.attempts.status?.failure).toBe('write-stalled');
  for (let i = 0; i < 100; ++i) { f.advance(100); f.health(); }
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(2);
});

it('a superseded manual write error is consumed by the current advance, not by a stale callback', () => {
  const f = fixture(); f.manual(); f.health(200);
  const before = f.engine.attempts.status;
  f.complete(0, new Error('manual write failed')); f.complete(0);
  expect(f.engine.attempts.status).toMatchObject({ id: before!.id, phase: before!.phase, failure: before!.failure });
  expect(f.engine.attempts.acceptedReceipt(before!.id)).toBeNull(); // Known error revokes escalation eligibility immediately.
  f.advance(8);
  expect(f.engine.attempts.status).toMatchObject({ origin: 'automatic', phase: 'failed', failure: 'write-error', writeId: null });
  expect(f.writes).toHaveLength(1);
});

it('coalesced manual completion cannot bypass backpressure for the automatic retry', () => {
  const f = fixture(); f.manual(); f.io.blocked = true; f.health(200);
  f.advance(8); expect(f.engine.attempts.status?.failure).toBeNull();
  f.complete(0); f.advance(8);
  expect(f.engine.attempts.status).toMatchObject({ phase: 'written', failure: null, writeId: null, lastWriteAt: null });
  f.advance(384);
  expect(f.engine.attempts.status?.failure).toBeNull();
  f.advance(800);
  expect(f.engine.attempts.status?.failure).toBe('backpressure');
  expect(f.writes).toHaveLength(1); expect(f.decision.mock.calls[1][1]).toBe(true);
});

it('zero retries permits genuine automatic escalation on an accepted equivalent manual write', () => {
  const f = fixture({ retryCount: 0 }); f.manual(); f.health(200); f.complete(0);
  const a = f.engine.attempts.status!;
  expect(f.engine.attempts.acceptedReceipt(a.id)).toMatchObject({ origin: 'manual', shared: true, accepted: true });
  f.advance(799); expect(f.engine.attempts.status).toMatchObject({ phase: 'written', writeId: null, lastWriteAt: null });
  f.advance(1); expect(f.engine.attempts.status?.failure).toBe('unconfirmed');
  expect(f.writes).toHaveLength(1); expect(f.decision.mock.calls[1][1]).toBe(true);
});

it('a timed-out but still accepted manual queue entry can support immediate genuine automatic escalation', () => {
  const f = fixture({ retryCount: 0 }); f.manual(); f.advance(1000);
  expect(f.engine.attempts.status?.failure).toBe('write-stalled');
  f.health(200);
  expect(f.decision.mock.calls.map(([d, accepted]) => [d.origin, accepted])).toEqual([['manual', true], ['automatic', true]]);
  expect(f.engine.attempts.acceptedReceipt(f.engine.attempts.status!.id)).toMatchObject({ accepted: true, origin: 'manual', shared: true });
  expect(f.writes).toHaveLength(1);
});

it.each(['reject', 'throw', 'sync-error'] as const)('a %s manual writer cannot supply an accepted equivalent receipt', mode => {
  const f = fixture({ retryCount: 0 }); f.io.mode = mode; f.manual(); f.health(200);
  expect(f.decision.mock.calls.map(([, accepted]) => accepted)).toEqual([false, false]);
  expect(f.engine.attempts.acceptedReceipt(f.engine.attempts.status!.id)).toBeNull();
});

it('accepted receipts expire with their lifecycle and later own retries have distinct provenance', () => {
  const f = fixture(); f.manual(); f.health(200); const id = f.engine.attempts.status!.id;
  const shared = f.engine.attempts.acceptedReceipt(id)!;
  f.complete(0); f.advance(400);
  expect(f.engine.attempts.acceptedReceipt(id)).toMatchObject({ origin: 'automatic', shared: false, accepted: true });
  expect(f.engine.attempts.acceptedReceipt(id)!.writeId).not.toBe(shared.writeId);
  f.configure({ enabled: false }); f.configure({ enabled: true });
  expect(f.engine.attempts.acceptedReceipt(id)).toBeNull();
});

it('an observer failure cannot change accepted-write or protection state', () => {
  let complete!: (error?: Error | null) => void;
  const coordinator = new EscapeAttemptCoordinator({ now: () => 1000, available: () => true, blocked: () => false,
    write: done => { complete = done; return true; } }, () => { throw new Error('display observer failed'); });
  const a = coordinator.begin('automatic', 1000, { ...DEFAULT_SAFETY_SETTINGS, enabled: true })!;
  expect(coordinator.writeInitial(a.id)).toBe(true); complete();
  expect(coordinator.status?.phase).toBe('written');
  expect(coordinator.acceptedReceipt(a.id)).toMatchObject({ accepted: true, failed: false, completedAt: 1000 });
});

it('a cancelled manual lifecycle cannot lend its accepted pending write to a new automatic decision', () => {
  const f = fixture(); f.manual(); f.configure({ enabled: false }); f.configure({ enabled: true }); f.health(200);
  expect(f.decision.mock.calls.map(([d, accepted]) => [d.origin, accepted])).toEqual([['manual', true], ['automatic', false]]);
  expect(f.engine.attempts.acceptedReceipt(f.engine.attempts.status!.id)).toBeNull();
  expect(f.writes).toHaveLength(1);
});

it.each(['reset', 'disable', 'replacement'] as const)('%s retires a coalesced attempt before the old manual callback completes', action => {
  const f = fixture(); f.manual(); f.health(200);
  if (action === 'reset') f.enter('Vault');
  if (action === 'disable') f.configure({ enabled: false });
  if (action === 'replacement') { f.engine.connectionChanged(2); f.enter('Realm', 100); }
  const before = f.engine.attempts.status;
  f.complete(0, new Error('late manual callback')); f.advance(400);
  expect(f.engine.attempts.status).toEqual(before);
  expect(f.writes).toHaveLength(action === 'replacement' ? 2 : 1);
});

it('times a stalled retry from that write, not the original request', () => {
  const f = fixture(); f.health(200); f.advance(390); f.complete(); f.advance(10);
  expect(f.writes.map(w => w.at)).toEqual([1000, 1400]);
  expect(f.engine.attempts.status).toMatchObject({ requestedAt: 1000, lastWriteAt: 1400, phase: 'queued' });
  f.advance(401); expect(f.engine.phase).toBe('queued'); // Original request is >800ms old.
  f.advance(398); expect(f.engine.phase).toBe('queued');
  f.advance(1); expect(f.engine.attempts.status).toMatchObject({ phase: 'failed', failure: 'write-stalled' });
  for (let i = 0; i < 100; ++i) { f.advance(100); f.health(); }
  expect(f.writes).toHaveLength(2); expect(f.decision).toHaveBeenCalledTimes(1);
  expect(snapshot(f.engine)).toMatchObject({ protectionState: 'degraded', automaticEligible: false, confirmedHp: 200 });
});

it('gives the final retry its own confirmation window and never catches up with a write burst', () => {
  const f = fixture({ retryCount: 1 }); f.health(200); f.complete();
  f.advance(3000); // Delayed scheduling still writes just once.
  expect(f.writes.map(w => w.at)).toEqual([1000, 4000]); f.complete();
  f.advance(799); expect(f.engine.phase).toBe('written');
  f.advance(1); expect(f.engine.attempts.status).toMatchObject({ phase: 'failed', failure: 'unconfirmed' });
  expect(f.writes).toHaveLength(2);
});

it('requires new, still-fresh liveness rather than rearming from timer-only stale danger', () => {
  const f = fixture({ retryCount: 0, reactionMs: 2000 }); f.health(200); f.complete();
  f.advance(2400); expect(f.engine.phase).toBe('failed');
  f.advance(3999); f.health(); expect(f.decision).toHaveBeenCalledTimes(1);
  f.io.blocked = true; f.advance(10000); f.io.blocked = false; f.advance(8);
  expect(f.decision).toHaveBeenCalledTimes(1); // The post-failure tick has itself aged out.
  f.health(); expect(f.decision).toHaveBeenCalledTimes(2);
});

it('a reset retains the physical slot until its own callback but cannot wedge the new epoch forever', () => {
  const f = fixture(); f.health(200); const old = f.engine.attempts.status!;
  f.enter('Snake Pit', 100); const failed = f.engine.attempts.status!;
  expect(failed).toMatchObject({ phase: 'failed', failure: 'backpressure' });
  expect(failed.epoch).toBeGreaterThan(old.epoch); expect(f.writes).toHaveLength(1);
  f.complete(0, new Error('old map')); expect(f.engine.attempts.status).toEqual(failed);
  f.advance(999); f.health(); f.advance(1);
  expect(f.writes).toHaveLength(2); expect(f.engine.phase).toBe('queued');
  f.complete(0); expect(f.engine.phase).toBe('queued');
  f.complete(1); expect(f.engine.phase).toBe('written');
});

it('connection replacement owns a fresh physical slot that old callbacks cannot retire', () => {
  const f = fixture(); f.health(200); const old = f.engine.attempts.status!;
  f.engine.connectionChanged(2); f.enter('Realm', 100);
  const current = f.engine.attempts.status!;
  expect(current).toMatchObject({ connectionGeneration: 2, phase: 'queued' });
  expect(current.id).not.toBe(old.id); expect(current.writeId).not.toBe(old.writeId);
  f.complete(0, new Error('old connection')); expect(f.engine.attempts.status).toEqual(current);
  f.advance(400); expect(f.writes).toHaveLength(2);
  f.complete(1); expect(f.engine.phase).toBe('written');
});

it.each([false, true])('an unreadable/empty MAPINFO (defined=%s) retires retries before map processing', defined => {
  const f = fixture(); f.health(200); const epoch = f.engine.epoch;
  f.emit('MAPINFO', {}, false, defined); f.complete(); f.advance(10000);
  expect(f.engine.epoch).toBeGreaterThan(epoch);
  expect(snapshot(f.engine)).toMatchObject({ map: '', confirmedHp: null, attempt: null, protectionState: 'waiting', automaticEligible: false });
  expect(f.writes).toHaveLength(1);
  f.emit('CREATESUCCESS', { objectId: 1 }); f.health(600);
  expect(f.engine.status()).toMatchObject({ mapUnreadable: true, degraded: 'map-unreadable', automaticEligible: true });
  f.health(200); expect(f.writes).toHaveLength(2);
});

it.each(['death', 'unreadable death', 'kill flag', 'reconnect', 'accepted reconnect', 'safe map'] as const)('%s retires writes/retries and remains inactive across toggles', terminal => {
  const f = fixture(); f.health(200);
  if (terminal === 'death') f.emit('DEATH', { killedBy: 'test' });
  if (terminal === 'unreadable death') f.emit('DEATH', {}, false, false);
  if (terminal === 'kill flag') f.emit('DAMAGE', { targetId: 1, kill: true });
  if (terminal === 'reconnect') f.emit('RECONNECT', { name: 'Dungeon', gameId: 123 });
  if (terminal === 'accepted reconnect') f.engine.confirmTransition(f.now());
  if (terminal === 'safe map') f.enter('Vault', 100);
  f.complete(0, new Error('late callback'));
  f.configure({ enabled: false }); f.configure({ enabled: true }); f.advance(10000); f.health(100);
  expect(f.engine.automaticEligible).toBe(false); expect(f.engine.monitoringReady).toBe(false);
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(1);
  if (terminal !== 'safe map') {
    f.enter('Realm', 100); f.advance(10000); f.manual();
    expect(f.decision).toHaveBeenCalledTimes(1); // Same TCP generation still terminal.
    f.engine.connectionChanged(2); f.enter('Realm', 100);
    expect(f.decision).toHaveBeenCalledTimes(2);
  }
});

it.each(['reject', 'throw', 'sync-error'] as const)('a %s writer cannot report an accepted escape or repeatedly retry it', mode => {
  const f = fixture(); f.io.mode = mode; f.health(200);
  expect(f.decision.mock.calls[0][1]).toBe(false);
  expect(f.engine.phase).toBe('failed'); f.advance(10000);
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(1);
});

it('upstream unavailability cannot manufacture an accepted manual or automatic write', () => {
  const f = fixture(); f.io.available = false; f.manual(); f.health(200); f.advance(10000);
  expect(f.decision.mock.calls.map(([d, wrote]) => [d.origin, wrote])).toEqual([['manual', false]]);
  expect(f.writes).toHaveLength(0); expect(snapshot(f.engine).automaticEligible).toBe(false);
  f.io.available = true; f.health();
  expect(f.decision.mock.calls[1][0]).toMatchObject({ origin: 'automatic', lowerHp: 200 });
  expect(f.decision.mock.calls[1][1]).toBe(true);
});

it('enqueues one initial emergency ESCAPE behind ordinary backlog before notification, without accumulating more', () => {
  const f = fixture(); f.io.blocked = true; f.health(200);
  expect(f.order).toEqual(['write', 'decision:automatic:true']);
  expect(f.engine.attempts.status).toMatchObject({ phase: 'queued', failure: null, lastWriteAt: 1000 });
  f.advance(400); f.health(); f.manual();
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(1);
  // A pending ESCAPE remains a hard gate even if the ordinary backlog clears.
  f.io.blocked = false; f.advance(400);
  expect(f.engine.attempts.status?.failure).toBe('write-stalled');
  for (let i = 0; i < 100; ++i) { f.advance(100); f.health(); }
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(1);
  f.complete(); f.advance(8);
  expect(f.writes).toHaveLength(2); expect(snapshot(f.engine).confirmedHp).toBe(200);
});

it('strict automatic request guards use server HP even for direct uncertainty and backlog callers', () => {
  const f = fixture(); f.io.blocked = true;
  f.engine.uncertain(f.now(), 'damage ledger capacity'); f.engine.request(f.now(), 'backlog');
  f.hit(); f.advance(10000);
  expect(f.writes).toHaveLength(0); expect(f.decision).not.toHaveBeenCalled();
  expect(snapshot(f.engine)).toMatchObject({ automaticEligible: true, confirmedHp: 600 });
  f.io.available = false; f.health(200); f.io.available = true;
  f.engine.uncertain(f.now(), 'unreadable NEWTICK');
  expect(f.writes).toHaveLength(1);
  expect(f.decision.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 200, lowerHp: 200,
    evidence: { trigger: 'unreadable NEWTICK', pendingCount: 0 } });
});

it('blocks retries and recovery on ordinary backlog after accepting the initial emergency write', () => {
  const f = fixture(); f.io.blocked = true; f.health(200);
  expect(f.order).toEqual(['write', 'decision:automatic:true']);
  f.complete(); f.advance(400);
  expect(f.engine.attempts.status?.failure).toBeNull();
  f.advance(800);
  expect(f.engine.attempts.status?.failure).toBe('backpressure');
  for (let i = 0; i < 100; ++i) { f.advance(100); f.health(); }
  expect(f.writes).toHaveLength(1); expect(f.decision).toHaveBeenCalledTimes(1);
  f.io.blocked = false; f.advance(8);
  expect(f.writes).toHaveLength(2); expect(snapshot(f.engine).confirmedHp).toBe(200);
});

it('accepts the worker transport contract when an underlying Node write returns false for backpressure', () => {
  const callbacks: ((error?: Error | null) => void)[] = [];
  const stream = new Writable({ highWaterMark: 1, write(_data, _encoding, done) { callbacks.push(done); } });
  const socketReturns: boolean[] = [];
  const coordinator = new EscapeAttemptCoordinator({
    now: () => 1000, available: () => !stream.destroyed,
    blocked: () => stream.writableNeedDrain || stream.writableLength > 0,
    // Model the existing worker adapter: Node's return value is NOT rejection.
    write: done => { socketReturns.push(stream.write(Buffer.alloc(5), done)); return true; },
  });
  try {
    expect(stream.write(Buffer.from('MOVE'))).toBe(false); // Ordinary outstanding traffic.
    const attempt = coordinator.begin('automatic', 1000, { ...DEFAULT_SAFETY_SETTINGS, enabled: true })!;
    expect(coordinator.writeInitial(attempt.id)).toBe(true);
    expect(socketReturns).toEqual([false]);
    expect(coordinator.status).toMatchObject({ phase: 'queued', failure: null });
    for (let now = 1400; now <= 10000; now += 400) coordinator.advance(now);
    expect(coordinator.status?.failure).toBe('write-stalled');
    expect(stream.writableLength).toBe(9); // MOVE + exactly one ESCAPE, even after timeout.
    expect(socketReturns).toEqual([false]);
  } finally {
    let done: typeof callbacks[number] | undefined;
    while ((done = callbacks.shift())) done();
    stream.destroy();
  }
});

it('a completed local write with continuing socket backpressure must not enqueue a retry', () => {
  const f = fixture(); f.health(200); f.complete(); f.io.blocked = true; f.advance(400);
  expect(f.writes).toHaveLength(1); expect(f.engine.attempts.status?.failure).toBeNull();
});

it.each([undefined, new Error('late error')])('a callback after timeout cannot revive the failed attempt (%s)', error => {
  const f = fixture(); f.health(200); f.advance(800);
  const failed = f.engine.attempts.status; f.complete(0, error);
  const { writeReceipt: _receipt, ...failedState } = failed!;
  expect(f.engine.attempts.status).toMatchObject(failedState);
  expect(f.engine.attempts.acceptedReceipt(failed!.id)).toBeNull();
  expect(f.engine.attempts.status!.writeReceipt).toMatchObject({ completedAt: f.now(), failed: !!error });
  f.advance(999); f.health(); expect(f.writes).toHaveLength(1); f.advance(1);
  expect(f.writes).toHaveLength(2); expect(snapshot(f.engine).confirmedHp).toBe(200);
});


it('default retry policy is one initial write plus four retries 400 ms apart', () => {
  const f = fixture({ ...DEFAULT_SAFETY_SETTINGS, enabled: true });
  f.health(200); f.complete();
  for (let retry = 0; retry < 4; ++retry) {
    f.advance(399); expect(f.writes).toHaveLength(retry + 1);
    f.advance(1); f.complete();
  }
  expect(f.writes.map(w => w.at)).toEqual([1000, 1400, 1800, 2200, 2600]);
  f.advance(5000); f.advance(5000); expect(f.writes).toHaveLength(5);
  const delayed = fixture({ ...DEFAULT_SAFETY_SETTINGS, enabled: true });
  delayed.health(200); delayed.complete(); delayed.advance(5000);
  expect(delayed.writes.map(w => w.at)).toEqual([1000, 6000]);
});

it('ordinary setting changes preserve automatic failure cooldown and require fresh liveness for recovery', () => {
  const f = fixture({ retryCount: 0 }); f.health(200); f.complete(); f.advance(800);
  const failed = f.engine.attempts.status!;
  f.configure({ notification: false }); f.configure({ thresholdPct: 30 });
  expect(f.engine.attempts.status).toEqual(failed);
  expect(f.engine.status().protectionState).toBe('cooldown');
  f.advance(999); f.health(); expect(f.decision).toHaveBeenCalledTimes(1);
  f.advance(1); expect(f.decision).toHaveBeenCalledTimes(2);
  expect(f.decision.mock.calls[1][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 200, lowerHp: 200 });
});

it('checks automatic danger before a due manual retry can claim the physical slot', () => {
  const f = fixture(); f.manual(); f.complete();
  f.io.available = false; f.health(200); f.io.available = true;
  f.advance(400);
  expect(f.writes.map(w => w.at)).toEqual([1000, 1400]);
  expect(f.decision.mock.calls.map(([d]) => d.origin)).toEqual(['manual', 'automatic']);
  expect(f.engine.attempts.status).toMatchObject({ origin: 'automatic', phase: 'queued' });
  expect(f.engine.attempts.acceptedReceipt(f.engine.attempts.status!.id)).toMatchObject({ origin: 'automatic', shared: false });
  expect(f.engine.status()).toMatchObject({ attemptOrigin: 'automatic', attemptPhase: 'queued' });
});

it('an actual unresolved hit can supersede a manual request exactly once', () => {
  const f = fixture({ preHitPrediction: true }); f.manual(); f.complete();
  f.emit('PLAYERHIT', { objectId: 99, bulletId: 99 }, true);
  f.emit('PLAYERHIT', { objectId: 99, bulletId: 99 }, true); f.advance(8);
  expect(f.decision.mock.calls.map(([d]) => [d.origin, d.reason])).toEqual([
    ['manual', 'manual nexus'], ['automatic', 'predicted HP crosses threshold'],
  ]);
  f.manual(); expect(f.decision).toHaveBeenCalledTimes(2);
});

it('a projectile spawn adds no loss while manual retries continue normally', () => {
  const f = fixture({ preHitPrediction: true }); f.manual(); f.complete();
  f.emit('ENEMYSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 900 });
  f.advance(400);
  expect(f.decision).toHaveBeenCalledTimes(1);
  expect(f.writes).toHaveLength(2);
  expect(snapshot(f.engine).attempt).toMatchObject({ origin: 'manual', phase: 'queued' });
});

it('recovers bounded exhaustion after cooldown and fresh liveness with the original HP debt retained', () => {
  const f = fixture({ preHitPrediction: true }); f.hit(); f.complete();
  f.advance(400); f.complete(); f.advance(400); f.complete();
  expect(f.writes).toHaveLength(3); f.advance(800);
  expect(snapshot(f.engine)).toMatchObject({ phase: 'failed', protectionState: 'cooldown', lowerHp: 200, prediction: { pendingCount: 1 } });
  f.advance(999); f.health(); expect(f.decision).toHaveBeenCalledTimes(1);
  f.advance(1);
  expect(f.decision).toHaveBeenCalledTimes(2);
  expect(snapshot(f.engine)).toMatchObject({ protectionState: 'escaping', automaticEligible: false, attempt: { phase: 'queued' } });
  expect(f.decision.mock.calls[1][0]).toMatchObject({ confirmedHp: 600, lowerHp: 200,
    evidence: { pendingCount: 1, pendingDamage: 400 } });
  expect(f.writes.map(w => w.at)).toEqual([1000, 1400, 1800, 3600]);
});

it('toggle cancellation preserves HP debt, retires retries, and cannot bypass the automatic cooldown', () => {
  const f = fixture({ preHitPrediction: true }); f.hit(1, 100); f.configure({ enabled: false }); f.configure({ enabled: true });
  expect(snapshot(f.engine)).toMatchObject({ lowerHp: 500, prediction: { pendingCount: 1 } });
  f.hit(2, 300); const old = snapshot(f.engine).attempt!;
  f.configure({ enabled: false }); f.complete(0); f.advance(400);
  expect(f.writes).toHaveLength(1); expect(snapshot(f.engine).protectionState).toBe('disabled');
  f.configure({ enabled: true }); f.health(); f.advance(599);
  expect(f.decision).toHaveBeenCalledTimes(1); f.advance(1);
  const current = snapshot(f.engine).attempt!;
  expect(current).toMatchObject({ phase: 'queued', epoch: old.epoch, connectionGeneration: old.connectionGeneration });
  expect(current.lifecycleRevision).toBeGreaterThan(old.lifecycleRevision);
  expect(current.writeId).not.toBe(old.writeId);
  f.complete(0, new Error('late duplicate callback'));
  expect(snapshot(f.engine).attempt).toEqual(current);
  f.advance(400); expect(f.writes).toHaveLength(2); // Old callback did not clear the new pending slot.
  expect(snapshot(f.engine)).toMatchObject({ confirmedHp: 600, lowerHp: 200, prediction: { pendingCount: 2 } });
});

it.each(['queued', 'written'] as const)('mode changes preserve a %s accepted escape and its scheduled retries', phase => {
  const f = fixture({ preHitPrediction: true, instantNexus: true }); f.hit();
  if (phase === 'written') f.complete();
  const before = snapshot(f.engine).attempt!, receipt = f.engine.attempts.acceptedReceipt(before.id);
  f.configure({ preHitPrediction: false });
  expect(snapshot(f.engine)).toMatchObject({ confirmedHp: 600, lowerHp: 600, prediction: null, attempt: before });
  expect(f.engine.attempts.acceptedReceipt(before.id)).toEqual(receipt);
  expect(f.engine.settings).not.toHaveProperty('instantNexus');
  f.configure({ preHitPrediction: true, instantNexus: true }); f.configure({ preHitPrediction: false });
  expect(f.engine.settings).not.toHaveProperty('instantNexus');
  expect(snapshot(f.engine).attempt).toEqual(before);
  if (phase === 'queued') f.complete();
  f.advance(400);
  expect(f.writes.map(w => w.at)).toEqual([1000, 1400]);
  expect(snapshot(f.engine).attempt).toMatchObject({ id: before.id, lifecycleRevision: before.lifecycleRevision, phase: 'queued' });
  expect(f.decision).toHaveBeenCalledTimes(1);
});

it('mode changes preserve automatic failure cooldown and require fresh liveness for recovery', () => {
  const f = fixture({ retryCount: 0 }); f.health(200); f.complete(); f.advance(800);
  const failed = snapshot(f.engine).attempt!;
  f.configure({ preHitPrediction: true }); f.configure({ preHitPrediction: false });
  expect(snapshot(f.engine).attempt).toEqual(failed);
  expect(snapshot(f.engine).protectionState).toBe('cooldown');
  f.advance(999); f.health(); expect(f.decision).toHaveBeenCalledTimes(1);
  f.advance(1); expect(f.decision).toHaveBeenCalledTimes(2);
  expect(f.decision.mock.calls[1][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 200, lowerHp: 200 });
});

it.each(['dead', 'transition'] as const)('mode changes preserve the %s terminal latch and connection generation', phase => {
  const f = fixture();
  if (phase === 'dead') f.emit('DAMAGE', { targetId: 1, kill: true, damageAmount: 1 });
  else f.engine.confirmTransition(f.now());
  const epoch = f.engine.epoch;
  f.configure({ preHitPrediction: true }); f.configure({ preHitPrediction: false });
  f.health(0); f.manual(); f.advance(10000);
  expect(snapshot(f.engine)).toMatchObject({ phase, epoch, automaticEligible: false });
  expect(f.decision).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  f.engine.connectionChanged(2); f.enter('Realm', 200);
  expect(snapshot(f.engine).attempt).toMatchObject({ connectionGeneration: 2, origin: 'automatic' });
});

it.each(['', '   '])('an empty map %j still allows threshold escapes', map => {
  const f = fixture(); f.enter(map, 200);
  expect(f.writes).toHaveLength(1);
});

it('retains unreadable map evidence through character creation and protects the player', () => {
  const f = fixture(); f.emit('MAPINFO', {}, false, false);
  f.emit('CREATESUCCESS', { objectId: 1 }); f.health(600);
  expect(f.engine.status()).toMatchObject({ mapUnreadable: true, degraded: 'map-unreadable', protectionState: 'monitoring-degraded' });
  f.health(200); expect(f.writes).toHaveLength(1);
});

it('detects a total HP stall without escaping and recovers on a fresh tick', () => {
  const f = fixture();
  f.advance(3000); expect(f.engine.status().degraded).toBeNull();
  f.advance(1);
  expect(f.engine.status()).toMatchObject({ degraded: 'server-hp-stale', protectionState: 'monitoring-degraded', automaticEligible: true });
  expect(f.writes).toHaveLength(0);
  f.health(); expect(f.engine.status().degraded).toBeNull();
});

it.each(['NEWTICK', 'UPDATE'])('flags unreadable %s until a fresh player tick', name => {
  const f = fixture(); f.emit(name, {}, false, false);
  expect(f.engine.status().degraded).toBe('hp-stream-unreadable');
  f.emit('UPDATE', { newObjs: [{ status: { objectId: 2, data: [] } }] });
  expect(f.engine.status().degraded).toBe('hp-stream-unreadable');
  f.emit('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 1, value: 600 }] } }] });
  expect(f.engine.status().degraded).toBeNull();
});

it.each(['disabled', 'safe', 'disconnected', 'waiting', 'dead'])('does not warn about stalls while %s', state => {
  const f = fixture();
  if (state === 'disabled') f.configure({ enabled: false });
  if (state === 'safe') f.enter('Nexus');
  if (state === 'disconnected') f.io.available = false;
  if (state === 'waiting') f.emit('MAPINFO', { name: 'Realm' });
  if (state === 'dead') f.emit('DEATH');
  f.advance(3001); expect(f.engine.status().degraded).toBeNull();
});

it('reports HP degradation ahead of unreadable-map evidence, then restores the map reason', () => {
  const f = fixture(); f.emit('MAPINFO', {}, false, false);
  f.emit('CREATESUCCESS', { objectId: 1 }); f.health(600);
  expect(f.engine.status().degraded).toBe('map-unreadable');
  f.advance(3001);
  expect(f.engine.status()).toMatchObject({ mapUnreadable: true, degraded: 'server-hp-stale' });
  f.emit('UPDATE', {}, false, false);
  expect(f.engine.status().degraded).toBe('hp-stream-unreadable');
  f.health(600);
  expect(f.engine.status().degraded).toBe('map-unreadable');
});

it('keeps escaping and cooldown visible alongside HP watchdog reasons', () => {
  const f = fixture(); f.health(200);
  f.emit('UPDATE', {}, false, false);
  expect(f.engine.status()).toMatchObject({ protectionState: 'escaping', degraded: 'hp-stream-unreadable' });
  f.advance(800);
  expect(f.engine.status()).toMatchObject({ protectionState: 'cooldown', degraded: 'hp-stream-unreadable' });
  f.advance(10000);
  expect(f.engine.status()).toMatchObject({ protectionState: 'degraded', degraded: 'hp-stream-unreadable' });
});

it.each([false, true])('keeps unreadable HP degraded through HP-less ticks until an explicit anchor (prediction=%s)', preHitPrediction => {
  const f = fixture({ preHitPrediction }); f.health(600);
  f.emit('NEWTICK', {}, false, false);
  for (let i = 0; i < 17; ++i) {
    f.advance(1000); f.health();
    expect(f.engine.status()).toMatchObject({ confirmedHp: 600, degraded: 'hp-stream-unreadable' });
  }
  f.emit('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 0, value: 1000 }] } }] });
  expect(f.engine.status().degraded).toBe('hp-stream-unreadable');
  f.health(NaN);
  expect(f.engine.status().degraded).toBe('hp-stream-unreadable');
  expect(f.writes).toHaveLength(0);
  f.health(550);
  expect(f.engine.status()).toMatchObject({ confirmedHp: 550, degraded: null, protectionState: 'monitoring' });
});

it('defers blocked retries without spending them or bursting after unblock', () => {
  const f = fixture(); f.health(200); f.complete(); f.io.blocked = true;
  f.advance(400); f.advance(300);
  expect(f.engine.attempts.status).toMatchObject({ phase: 'written', failure: null });
  expect(f.engine.attempts.recoveryState(f.now())).toBeNull();
  f.io.blocked = false; f.advance(1); f.complete();
  f.advance(0); f.advance(399);
  expect(f.writes.map(w => w.at)).toEqual([1000, 1701]);
  f.advance(1); f.complete();
  expect(f.writes.map(w => w.at)).toEqual([1000, 1701, 2101]);
  f.advance(800);
  expect(f.engine.attempts.status?.failure).toBe('unconfirmed');
});

it('fails a persistently blocked retry at its bounded deadline and starts cooldown', () => {
  const f = fixture(); f.health(200); f.complete(); f.io.blocked = true;
  f.advance(400); f.advance(799);
  expect(f.engine.attempts.status?.failure).toBeNull();
  f.advance(1);
  expect(f.engine.attempts.status?.failure).toBe('backpressure');
  expect(f.engine.attempts.recoveryState(f.now())).toBe('cooldown');
  expect(f.writes).toHaveLength(1);
});

it.each(['generation', 'epoch', 'revision'])('retires a deferred retry on superseded %s', kind => {
  const f = fixture(); f.health(200); f.complete(); f.io.blocked = true; f.advance(400);
  if (kind === 'generation') f.engine.connectionChanged(2);
  if (kind === 'epoch') f.emit('MAPINFO', { name: 'Realm' });
  if (kind === 'revision') f.configure({ enabled: false });
  f.io.blocked = false; f.advance(400);
  expect(f.writes).toHaveLength(1);
});
