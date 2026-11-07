// Ported from realm-engine-client client/src/auto-drink/__tests__/AutoDrinkController.test.ts @ 88a66b2 (MIT, see NOTICE).
import { describe, expect, it } from 'vitest';
import { AutoDrinkController, type AutoDrinkUse } from '../AutoDrinkController.ts';
import { autoDrinkCatalog, autoDrinkSettings, type AutoDrinkItem, type AutoDrinkSettings } from '../AutoDrinkTypes.ts';

const hpItem: AutoDrinkItem = { type: 10, name: 'Health', hp: 100, mp: 0, healingDurationMs: 0, quickslot: true };
const mpItem: AutoDrinkItem = { type: 11, name: 'Magic', hp: 0, mp: 100, healingDurationMs: 0, quickslot: true };
const hotItem: AutoDrinkItem = { type: 12, name: 'Recovery', hp: 0, mp: 0, healingDurationMs: 5000, quickslot: true };
const gate = { available: true, backlog: false, escape: false };
const p = (name: string, data: Record<string, any> = {}, isDefined = true) => ({ name, data, isDefined });
const s = (id: number, value: number, stackCount?: number) => ({ id, value, ...(stackCount === undefined ? {} : { stackCount }) });
const slot = (slotId = 1_000_000, objectType = 10) => ({ objectId: 1, slotId, objectType });

function fixture(settings: Partial<AutoDrinkSettings> = {}, initial = [s(0, 1000), s(1, 400), s(3, 500), s(4, 100), s(116, 10, 3)], initialClock = 100) {
  let now = 0, tick = 0, accepted = true, wallOffset = 1_800_000_000_000;
  const sent: AutoDrinkUse[] = [];
  const sentAt: number[] = [];
  const controller = new AutoDrinkController({ now: () => now, wallNow: () => wallOffset + now,
    send: use => { sent.push(use); sentAt.push(now); return accepted; } });
  controller.configure({ enabled: true, ...settings }); controller.setCatalog([hpItem, mpItem, hotItem]);
  const server = (name: string, data: Record<string, any> = {}) => controller.observeServer(p(name, data));
  const clock = (time = Math.floor(now + 100)) => controller.observeOutgoing(p('PONG', { time }));
  const stats = (data: ReturnType<typeof s>[], tickId = ++tick) => server('NEWTICK', { tickId,
    statuses: [{ objectId: 1, position: { x: 1.5, y: 2.5 }, data }] });
  const spawn = (map = 'Realm') => {
    tick = 0; server('MAPINFO', { name: map }); server('CREATESUCCESS', { objectId: 1 });
    server('UPDATE', { newObjs: [{ status: { objectId: 1, position: { x: 1.5, y: 2.5 }, data: initial } }] });
  };
  spawn(); clock(initialClock);
  return { controller, sent, sentAt, server, stats, clock, spawn, evaluate: () => controller.evaluate(gate),
    now: () => now, at: (time: number) => { now = time; }, wallOffset: (offset: number) => { wallOffset = offset; },
    reject: () => { accepted = false; } };
}

describe('configuration contract', () => {
  it('defaults off, copies arrays, clamps finite ranges and preserves zero', () => {
    expect(autoDrinkSettings()).toEqual({ enabled: false, enableHp: true, hpThresholdPct: 50, enableMp: false,
      mpThresholdPct: 50, intervalMs: 400, inventoryFallback: false, healingOverTime: false,
      slotPriority: [0, 1, 2], excludedItems: [] });
    expect(autoDrinkSettings({ hpThresholdPct: 0, mpThresholdPct: 200, intervalMs: 1 })).toMatchObject({ hpThresholdPct: 0, mpThresholdPct: 95, intervalMs: 400 });
    expect(autoDrinkSettings({ intervalMs: 9000 }).intervalMs).toBe(5000);
    const priority = [2, 2, 0], excluded = [10];
    const result = autoDrinkSettings({ slotPriority: priority, excludedItems: excluded }); priority.push(1); excluded.push(11);
    expect(result.slotPriority).toEqual([2, 0, 1]); expect(result.excludedItems).toEqual([10]);
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite settings/catalog values: %s', value => {
    for (const key of ['hpThresholdPct', 'mpThresholdPct', 'intervalMs']) expect(() => autoDrinkSettings({ [key]: value })).toThrow();
    expect(() => autoDrinkCatalog([{ ...hpItem, hp: value }])).toThrow();
  });
  it('rejects malformed settings and duplicate/invalid metadata atomically', () => {
    expect(() => autoDrinkSettings({ slotPriority: [3] })).toThrow();
    expect(() => autoDrinkSettings({ excludedItems: [-1] })).toThrow();
    expect(() => autoDrinkSettings({ enabled: 'true' as any })).toThrow();
    expect(() => autoDrinkCatalog([hpItem, hpItem])).toThrow();
    expect(() => autoDrinkCatalog([{ ...hpItem, hp: 0 }])).toThrow();
    const f = fixture(); expect(() => f.controller.configure({ hpThresholdPct: NaN })).toThrow();
    f.evaluate(); expect(f.sent).toHaveLength(1);
  });
});

it('enforces 399/400 ms exactly, serializes the quickslot contract and uses wall time only in status', () => {
  const f = fixture(); f.evaluate();
  expect(f.sent[0]).toEqual({ time: 100, slotObject: slot(), itemUsePos: { x: 1.5, y: 2.5 }, useType: 0, unknownInt: 0 });
  expect(f.controller.status()).toMatchObject({ pending: true, lastAttemptAt: 1_800_000_000_000, hp: 400, maxHp: 1000 });
  f.at(200); f.stats([s(116, 10, 2)]); expect(f.controller.status().pending).toBe(false);
  f.at(399); f.evaluate(); expect(f.sent).toHaveLength(1); expect(f.controller.status().cooldownRemainingMs).toBe(1);
  f.at(400); f.evaluate(); expect(f.sent).toHaveLength(2); expect(f.sent[1].time).toBe(500);
});

it('uses true server MaxHP stat0 directly (707), ignores boosts and disables positive-HP threshold at zero', () => {
  const f = fixture(); f.stats([s(0, 707), s(1, 354), s(46, 500), s(111, 100)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(1, 353)]); f.evaluate(); expect(f.sent).toHaveLength(1); expect(f.controller.status().maxHp).toBe(707);
  const off = fixture({ hpThresholdPct: 0 }); off.stats([s(1, 1)]); off.evaluate(); expect(off.sent).toHaveLength(0);
  off.stats([s(1, 0)]); off.evaluate(); expect(off.sent).toHaveLength(0);
});

it('shares the HP/MP limiter and gives HP priority over preferred MP stock', () => {
  const f = fixture({ enableMp: true, slotPriority: [1, 0, 2] }); f.stats([s(117, 11, 3)]); f.evaluate();
  expect(f.sent[0].slotObject).toEqual(slot());
  f.stats([s(116, 10, 2), s(1, 900)]); f.at(399); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(400); f.evaluate(); expect(f.sent[1].slotObject).toEqual(slot(1_000_001, 11));
});

it('does not treat party/pet HP recovery, repeated stock, INVRESULT or stale ticks as consumption ACKs', () => {
  const f = fixture(); f.evaluate();
  f.stats([s(1, 900), s(116, 10, 3)], 10);
  f.stats([s(116, 10, 2)], 9);
  f.server('INVRESULT', { unknownBool: true, fromSlot: slot() });
  f.at(400); f.evaluate(); expect(f.controller.status()).toMatchObject({ pending: true, hp: 900 }); expect(f.sent).toHaveLength(1);
  f.stats([s(116, 10, 2)], 11); f.evaluate(); expect(f.controller.status().pending).toBe(false); expect(f.sent).toHaveLength(1);
});

it('confirms each explicit decrease only once and never credits HP', () => {
  const f = fixture(); f.evaluate(); f.stats([s(116, 10, 2)]); f.at(400); f.evaluate();
  expect(f.sent).toHaveLength(2); f.stats([s(116, 10, 2)]); f.at(800); f.evaluate(); expect(f.sent).toHaveLength(2);
  expect(f.controller.status()).toMatchObject({ pending: true, hp: 400 });
  f.stats([s(116, 10, 1)]); f.evaluate(); expect(f.sent).toHaveLength(3);
  f.stats([s(116, -1, 0)]); f.at(1200); f.evaluate(); expect(f.sent).toHaveLength(3);
});

it('restock/replacement taints the reservation; timeout waits for a post-timeout change and bounded backoff', () => {
  const f = fixture(); f.evaluate(); f.stats([s(116, 10, 4)]); f.stats([s(116, 10, 3)]);
  expect(f.controller.status().pending).toBe(true);
  f.at(1500); f.clock(); f.stats([]); f.evaluate(); expect(f.controller.status().pending).toBe(false);
  f.at(2500); f.clock(); f.stats([s(116, 10, 3)]); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(3000); f.stats([s(116, 10, 2)]); f.evaluate(); expect(f.sent).toHaveLength(2);
});

it('retries only once across toggles and catalog reloads', () => {
  const f = fixture(); f.evaluate();
  for (let t = 1500; t <= 15000; t += 500) {
    f.at(t); f.clock(); f.stats([s(116, 10, 3)]); f.controller.configure({ enabled: false });
    f.controller.configure({ enabled: true }); f.controller.setCatalog([hpItem]); f.evaluate();
  }
  expect(f.sent).toHaveLength(2); expect(f.controller.status().reason).toBe('quickslot 1: drink not confirmed by server');
});

it('retains same-connection cooldown across MAPINFO, CREATESUCCESS, toggles and catalog reload', () => {
  const f = fixture(); f.evaluate(); f.at(100); f.spawn('Snake Pit'); f.controller.configure({ enabled: false });
  f.controller.setCatalog([hpItem]); f.controller.configure({ enabled: true }); f.at(399); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(400); f.evaluate(); expect(f.sent).toHaveLength(1); // No old-map clock reuse.
  f.clock(); f.at(900); f.clock(); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(2);
  expect(f.controller.status().epoch).toBe(4);
});

it('cannot shorten an already-established deadline and never catches up in bursts', () => {
  const f = fixture({ intervalMs: 5000 }); f.evaluate(); f.stats([s(116, 10, 2)]); f.controller.configure({ intervalMs: 400 });
  f.at(400); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(10000); f.clock(); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(10500); f.clock(); f.stats([]); f.evaluate(); f.evaluate(); f.evaluate(); expect(f.sent).toHaveLength(2);
});

it.each(['USEITEM', 'INVENTORYSWAP', 'INVDROP'])('observes accepted final %s and waits for changed stock without blocking manual input', name => {
  const f = fixture();
  const outgoing = p(name, name === 'INVENTORYSWAP' ? { slotObject1: slot(5), slotObject2: slot() } : { slotObject: slot() });
  expect(f.controller.blocksInjectedSwap(outgoing)).toBe(false); f.controller.observeOutgoing(outgoing);
  f.at(500); f.stats([s(116, 10, 3)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(116, 10, 2)]); f.evaluate(); expect(f.sent).toHaveLength(1);
});

it('manual quickslot uses share the limiter even outside our catalog; conflicting use makes an auto ACK ambiguous', () => {
  const f = fixture(); f.controller.observeOutgoing(p('USEITEM', { time: 100, slotObject: slot(1_000_001, 999) }));
  f.at(399); f.evaluate(); expect(f.sent).toHaveLength(0); f.at(400); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.controller.observeOutgoing(p('USEITEM', { slotObject: slot() })); f.stats([s(116, 10, 2)]);
  expect(f.controller.status().pending).toBe(true);
});

it('does not postpone drinking for repeated ability-slot uses, including catalog collisions', () => {
  const f = fixture();
  for (let t = 0; t < 400; t += 50) {
    f.at(t); f.controller.observeOutgoing(p('USEITEM', { time: 0x7fffffff, slotObject: slot(1, 10) }));
  }
  f.evaluate(); expect(f.sent).toHaveLength(1);
  expect(f.controller.status().cooldownRemainingMs).toBe(400);
});

it('recovers from unknown stock only on a real change, including an initially unknown manual slot', () => {
  const f = fixture(); f.evaluate(); f.stats([s(116, 10)]);
  f.at(1500); f.clock(); f.stats([]); f.evaluate();
  f.at(2500); f.clock(); f.stats([s(116, 10, 3)]); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.stats([s(116, 10)]); f.stats([s(116, 10, 2)]); f.evaluate(); expect(f.sent).toHaveLength(2);
  const unknown = fixture({}, [s(0, 1000), s(1, 400), s(116, 10)]);
  unknown.controller.observeOutgoing(p('USEITEM', { slotObject: slot() }));
  unknown.at(400); unknown.stats([s(116, 10, 2)]); unknown.evaluate(); expect(unknown.sent).toHaveLength(1);
});

it('starts the full cooldown at actual acceptance, not before a slow writer', () => {
  let now = 0;
  const controller = new AutoDrinkController({ now: () => now, wallNow: () => now, send: () => { now += 30; return true; } });
  controller.configure({ enabled: true }); controller.setCatalog([hpItem]);
  controller.observeServer(p('MAPINFO', { name: 'Realm' }));
  controller.observeServer(p('CREATESUCCESS', { objectId: 1 }));
  controller.observeServer(p('UPDATE', { newObjs: [{ status: { objectId: 1, position: { x: 1, y: 1 },
    data: [s(0, 1000), s(1, 400), s(116, 10, 3)] } }] }));
  controller.observeOutgoing(p('PONG', { time: 100 })); controller.evaluate(gate);
  expect(controller.status().cooldownRemainingMs).toBe(400);
  controller.observeServer(p('NEWTICK', { tickId: 1, statuses: [{ objectId: 1, position: { x: 1, y: 1 }, data: [s(116, 10, 2)] }] }));
  now = 429; controller.evaluate(gate); expect(controller.status().pending).toBe(false);
  now = 430; controller.evaluate(gate); expect(controller.status().pending).toBe(true);
});

it.each([NaN, Infinity, -Infinity])('blocks nonfinite actual clocks and keeps status finite (%s)', now => {
  const f = fixture(); f.at(now); f.evaluate(); expect(f.sent).toHaveLength(0);
  expect(Number.isFinite(f.controller.status().cooldownRemainingMs)).toBe(true);
});

it('arbitrates only injected swaps touching the automatic reservation, not other slots or manual consumes', () => {
  const f = fixture(); f.evaluate();
  expect(f.controller.blocksInjectedSwap(p('INVENTORYSWAP', { slotObject1: slot(), slotObject2: slot(6) }))).toBe(true);
  expect(f.controller.blocksInjectedSwap(p('INVENTORYSWAP', { slotObject1: slot(6), slotObject2: slot(7) }))).toBe(false);
  expect(f.controller.blocksInjectedSwap(p('USEITEM', { slotObject: slot() }))).toBe(false);
  f.at(1500); f.evaluate(); expect(f.controller.blocksInjectedSwap(p('INVENTORYSWAP', { slotObject1: slot() }))).toBe(false);
});

it.each([
  [29, 1 << 4, 'sick'], [95, 0x20000000, 'drought'], [29, 1 << 20, 'paused'], [29, 1, 'dead'],
])('blocks condition stat %s mask %s (%s)', (id, value, reason) => {
  const f = fixture(); f.stats([s(id as number, value as number)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  expect(f.controller.status().reason).toBe(reason);
});

it.each(['Nexus', 'Vault', '', 'Pet Yard'])('does not consume in safe/unknown map %s', map => {
  const f = fixture(); f.spawn(map); f.evaluate(); expect(f.sent).toHaveLength(0);
});

it('blocks unknown/dead state, malformed updates, stale streams, absent clock and backlog', () => {
  const f = fixture(); f.stats([s(1, NaN)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(1, 0)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(1, 400)]); f.controller.evaluate({ ...gate, backlog: true }); expect(f.sent).toHaveLength(0);
  f.controller.evaluate({ ...gate, available: false }); expect(f.sent).toHaveLength(0);
  f.at(1501); f.evaluate(); expect(f.controller.status().reason).toBe('stale server stream');
  f.stats([]); f.evaluate(); expect(f.controller.status().reason).toBe('client clock unavailable');
  f.clock(); f.controller.observeServer(p('NEWTICK', {}, false)); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.at(2001); f.clock(); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(1);
});

it.each(['MOVE', 'PONG', 'PLAYERSHOOT'])('requires a finite initialized %s client clock, never epoch milliseconds', name => {
  const f = fixture(); f.controller.connectionChanged(); f.spawn();
  const outgoing = (time: number) => p(name, name === 'MOVE' ? { records: [{ time, x: 1, y: 1 }] } : { time });
  for (const time of [Date.now(), NaN, Infinity, -1, 0.5, 0x80000000]) {
    f.controller.observeOutgoing(outgoing(time)); f.evaluate(); expect(f.sent).toHaveLength(0);
  }
  f.controller.observeOutgoing(p(name, { time: 100, records: {} }, false));
  if (name === 'MOVE') f.controller.observeOutgoing(p(name, { records: {} }));
  f.controller.observeOutgoing(outgoing(0)); f.evaluate(); expect(f.sent[0].time).toBe(0);
});

it.each(['MOVE', 'PONG', 'PLAYERSHOOT'])('waits for a confirmed delayed %s clock to catch the consumption floor without inventing time', name => {
  const f = fixture({}, undefined, 1000);
  const clock = (time: number) => f.controller.observeOutgoing(p(name, name === 'MOVE'
    ? { records: [{ time, x: 1, y: 1 }] } : { time }));
  f.at(700); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1700]);
  f.at(800); f.stats([s(116, 10, 2)]);
  f.at(1000); clock(1100);
  f.at(1099); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(1100); f.evaluate(); expect(f.sent).toHaveLength(1); // 1700 then 1200 is forbidden.
  f.at(1500); clock(1600); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(1);
  expect(f.controller.status()).toMatchObject({ reason: 'shared consume protocol cooldown', cooldownRemainingMs: 500 });
  f.at(1999); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(2000); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1700, 2100]);
  expect(f.sent[1].time - f.sent[0].time).toBe(400);
});

it('keeps 100 regularly advancing MOVE samples ready through realistic receive jitter without false clock expiry', () => {
  const f = fixture({}, undefined, 1000); f.stats([s(1, 900)]);
  const delays = [22, 15, 25, 49, 42, 64, 48, 53, 61, 91, 83];
  for (let i = 1; i <= 100; ++i) {
    const now = i * 200 + delays[(i - 1) % delays.length];
    f.at(now); f.stats([]);
    f.controller.observeOutgoing(p('MOVE', { records: [{ time: 1000 + i * 200, x: 1, y: 1 }] }));
    f.evaluate(); expect(f.controller.status().state, `sample ${i}`).toBe('ready');
    f.at(now + 150); f.evaluate(); expect(f.controller.status().state, `between samples ${i}`).toBe('ready');
  }
  expect(f.sent).toHaveLength(0);
});

it('enforces actual AND protocol intervals on every jittered automatic write, including manual HP/MP consumption', () => {
  const f = fixture({ enableMp: true }, undefined, 1000);
  const delays = [22, 15, 25, 49, 42, 64, 48, 53, 61, 91, 83];
  let previous: { at: number; time: number } | null = null;
  for (let i = 1; i <= 100; ++i) {
    const now = i * 200 + delays[i % delays.length], time = 1000 + i * 200;
    f.at(now); f.stats([s(116, 10, 200 - f.sent.length)]); f.clock(time);
    if (i === 15 || i === 55) {
      const manualTime = time + 180;
      f.controller.observeOutgoing(p('USEITEM', { time: manualTime, slotObject: slot(1_000_001, i === 15 ? 10 : 11) }));
      previous = { at: now, time: manualTime };
    }
    f.controller.observeOutgoing(p('USEITEM', { time: 0x7fffffff, slotObject: slot(1, 10) }));
    const count = f.sent.length; f.evaluate();
    if (f.sent.length !== count) {
      const emitted = f.sent[count];
      expect(emitted.time).toBe(time); // Latest raw calibration, never a clamped future timestamp.
      if (previous) {
        expect(f.sentAt[count] - previous.at).toBeGreaterThanOrEqual(400);
        expect(emitted.time - previous.time).toBeGreaterThanOrEqual(400);
      }
      previous = { at: f.sentAt[count], time: emitted.time };
    }
  }
  expect(f.sent.length).toBeGreaterThan(30);
  expect(f.controller.status().hp).toBe(400);
});

it.each([0, 1000])('does not refresh from repeated zero/duplicate/backward/malformed samples; expires after 1500ms (initial=%s)', initial => {
  const f = fixture({}, undefined, initial); f.stats([s(1, 900)]);
  for (const now of [200, 600, 1000, 1500]) {
    f.at(now); f.stats([]);
    for (const time of [initial, 0, initial - 1, NaN, Infinity, 0x80000000]) f.clock(time);
    f.evaluate(); expect(f.controller.status().state).toBe('ready');
  }
  f.at(1501); f.stats([]); f.evaluate();
  expect(f.controller.status().reason).toBe('client clock unavailable');
  expect(f.sent).toHaveLength(0);
});

it('does not shrink integer USEITEM spacing to 399ms after fractional downward recalibration', () => {
  const f = fixture({}, undefined, 1000);
  f.at(700); f.evaluate(); f.at(800); f.stats([s(116, 10, 2)]);
  f.at(1000.8); f.clock(2000); // Extrapolation is 2000.8, not floor(2000.8).
  f.at(1100); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1700]);
  expect(f.controller.status().cooldownRemainingMs).toBe(1);
  f.at(1100.8); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1700, 2100]);
});

it.each([250, 251])('bounds normal jitter and confirms larger discontinuities (behind=%s)', behind => {
  const f = fixture({}, undefined, 1000);
  f.at(1000); f.clock(2000 - behind); f.evaluate();
  if (behind === 250) expect(f.sent.map(use => use.time)).toEqual([1750]);
  else {
    expect(f.sent).toHaveLength(0);
    expect(f.controller.status().reason).toBe('client clock unavailable');
    f.at(1500); f.clock(2500 - behind); f.stats([]); f.evaluate();
    expect(f.sent.map(use => use.time)).toEqual([2249]);
  }
});

it('rejects isolated jumps and cumulatively stalled clocks, then recovers a lower coherent epoch without a high-water lock', () => {
  const f = fixture({}, undefined, 1000); f.stats([s(1, 900)]);
  f.at(100); f.clock(1_000_000); f.evaluate();
  expect(f.controller.status().reason).toBe('client clock unavailable');
  f.at(600); f.clock(1_000_000); f.evaluate();
  expect(f.controller.status().reason).toBe('client clock unavailable');
  f.at(700); f.clock(1000); f.at(1200); f.clock(1500); f.stats([]); f.evaluate();
  expect(f.controller.status().state).toBe('ready');
  for (let i = 1; i <= 10; ++i) {
    f.at(1200 + i * 200); f.clock(1500 + i * 10); f.stats([]); f.evaluate();
    if (i >= 2) expect(f.controller.status().reason).toBe('client clock unavailable');
  }
  f.at(5000); f.clock(100); f.stats([]); f.evaluate();
  expect(f.controller.status().reason).toBe('client clock unavailable');
  f.at(5500); f.clock(600); f.stats([]); f.evaluate(); expect(f.controller.status().state).toBe('ready');
  f.stats([s(1, 400)]); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([600]);
});

it('requires bounded resynchronization after pause and ignores samples received while paused', () => {
  const f = fixture({}, undefined, 1000);
  f.stats([s(29, 1 << 20)]);
  f.at(200); f.clock(50); f.at(700); f.clock(550); f.evaluate();
  expect(f.controller.status().reason).toBe('paused');
  f.stats([s(29, 0)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.clock(550); f.at(1199); f.clock(1049); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.at(1200); f.clock(1050); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1050]);
});

it('retains valid manual consumption protocol floors across map/config/toggles, never lowering them for invalid or backward manual time', () => {
  const f = fixture();
  f.controller.observeOutgoing(p('USEITEM', { time: 1000, slotObject: slot(4, 11) }));
  for (const time of [999, NaN, -1, 0x80000000]) {
    f.controller.observeOutgoing(p('USEITEM', { time, slotObject: slot(1_000_001, 11) }));
  }
  f.controller.configure({ intervalMs: 800, enabled: false });
  f.controller.configure({ intervalMs: 400, enabled: true }); f.controller.setCatalog([hpItem, mpItem]);
  f.at(100); f.spawn('Snake Pit'); f.clock(100);
  f.at(600); f.clock(600); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.at(800); f.evaluate(); expect(f.controller.status().reason).toBe('shared consume protocol cooldown');
  f.at(1799); f.clock(1799); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.at(1800); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1800]);
  f.controller.connectionChanged(); f.spawn(); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.clock(0); f.evaluate(); expect(f.sent.map(use => use.time)).toEqual([1800, 0]);
});

it('fails closed at int32 overflow without wrapping or clamping automatic or manual protocol deadlines', () => {
  const f = fixture({}, undefined, 0x7fffffff - 400); f.evaluate();
  f.stats([s(116, 10, 2)]); f.at(400); f.evaluate();
  expect(f.sent.map(use => use.time)).toEqual([0x7fffffff - 400, 0x7fffffff]);
  f.stats([s(116, 10, 1)]); f.at(800); f.evaluate(); expect(f.sent).toHaveLength(2);
  expect(f.controller.status().reason).toBe('client clock unavailable');
  // A lower, confirmed epoch still cannot evade an accepted consumption floor.
  f.at(2000); f.clock(100); f.at(2500); f.clock(600); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(2);
  expect(f.controller.status().reason).toBe('shared consume protocol cooldown');
  const manual = fixture({}, undefined, 0x7fffffff - 1000);
  manual.controller.observeOutgoing(p('USEITEM', { time: 0x7fffffff, slotObject: slot(1_000_001, 11) }));
  manual.at(400); manual.evaluate(); expect(manual.sent).toHaveLength(0);
  manual.at(1001); manual.evaluate(); expect(manual.sent).toHaveLength(0);
});

it('refreshes normally advancing game clocks independently of wall-clock jumps and preserves actual cooldown', () => {
  const f = fixture({}, undefined, 1000); f.evaluate();
  f.at(100); f.stats([s(116, 10, 2)]);
  f.wallOffset(0); f.at(399); f.clock(1399); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(400); f.evaluate(); expect(f.sent[1].time).toBe(1400);
  expect(f.controller.status().lastAttemptAt).toBe(400);
  f.at(500); f.stats([s(116, 10, 1)]);
  f.wallOffset(2_000_000_000_000); f.at(700); f.clock(1900); f.evaluate(); expect(f.sent).toHaveLength(2);
  f.at(800); f.evaluate(); expect(f.sent[2].time).toBe(2000);
  expect(f.controller.status().lastAttemptAt).toBe(2_000_000_000_800);
  f.at(1900); f.clock(3100); f.stats([s(116, 10, 0)]);
  f.at(2000); f.stats([s(116, 10, 1)]); f.evaluate();
  expect(f.sent.map(use => use.time)).toEqual([1000, 1400, 2000, 3200]);
});

it('ignores other players, health in unrelated packets and missing/uninitialized quantities', () => {
  const f = fixture({}, [s(0, 1000), s(1, 900), s(116, 10)]);
  f.server('NEWTICK', { tickId: 1, statuses: [{ objectId: 2, data: [s(1, 10), s(116, 10, 9)] }] });
  f.server('DAMAGE', { targetId: 1, damageAmount: 800 }); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(1, 400)], 2); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(116, 10, 0)], 3); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(116, 10, 1)], 4); f.evaluate(); expect(f.sent).toHaveLength(1);
});

it('honors exclusions, priority and quickslot eligibility', () => {
  const f = fixture({ slotPriority: [2, 1, 0], excludedItems: [10] }); f.stats([s(118, 12, 1)]);
  f.evaluate(); expect(f.sent).toHaveLength(0);
  f.controller.configure({ excludedItems: [], healingOverTime: true }); f.evaluate(); expect(f.sent[0].slotObject.slotId).toBe(1_000_002);
  const g = fixture(); g.controller.setCatalog([{ ...hpItem, quickslot: false }]); g.evaluate(); expect(g.sent).toHaveLength(0);
});

it('inventory/backpack fallback is opt-in, skips equipment and respects unlock capacity', () => {
  const f = fixture({}, [s(0, 1000), s(1, 400), s(8, 10), s(12, 10), s(131, 10)]);
  f.evaluate(); expect(f.sent).toHaveLength(0); f.controller.configure({ inventoryFallback: true }); f.evaluate();
  expect(f.sent[0]).toMatchObject({ slotObject: slot(4), useType: 1 });
  f.stats([s(12, -1)]); f.at(400); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.stats([s(130, 8)]); f.evaluate(); expect(f.sent[1]).toMatchObject({ slotObject: slot(12), useType: 1 });
  f.stats([s(131, -1), s(139, 10)]); f.at(800); f.evaluate(); expect(f.sent).toHaveLength(2);
  f.stats([s(130, 16)]); f.evaluate(); expect(f.sent[2].slotObject.slotId).toBe(20);
});

it('HOT is opt-in, does not stack while Healing/own duration is active and does not predict recovery', () => {
  const f = fixture({}, [s(0, 1000), s(1, 400), s(116, 12, 3)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.controller.configure({ healingOverTime: true }); f.stats([s(29, 1 << 17)]); f.evaluate(); expect(f.sent).toHaveLength(0);
  f.stats([s(29, 0)]); f.evaluate(); f.stats([s(116, 12, 2)]); f.at(400); f.evaluate(); expect(f.sent).toHaveLength(1);
  expect(f.controller.status().hp).toBe(400);
  f.at(5000); f.clock(); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(1);
  f.at(5500); f.clock(); f.stats([]); f.evaluate(); expect(f.sent).toHaveLength(2);
});

it.each(['manual', 'automatic', 'wire', 'reconnect'])('latches %s escape across map/config reset until a new TCP connection', origin => {
  const f = fixture();
  if (origin === 'wire') f.controller.observeOutgoing(p('ESCAPE'));
  else if (origin === 'reconnect') f.server('RECONNECT'); else f.controller.escape();
  f.spawn('Snake Pit'); f.controller.configure({ enabled: false }); f.controller.configure({ enabled: true }); f.evaluate();
  expect(f.sent).toHaveLength(0); expect(f.controller.status().reason).toBe('escape lifecycle');
  f.controller.connectionChanged(); f.spawn(); f.clock(); f.evaluate(); expect(f.sent).toHaveLength(1);
});

it.each(['DEATH', 'DAMAGE', 'disconnect'])('retires %s and does not resurrect on same-connection MAPINFO', name => {
  const f = fixture();
  if (name === 'disconnect') f.controller.disconnect(); else f.server(name, { targetId: 1, kill: true });
  f.spawn(); f.evaluate(); expect(f.sent).toHaveLength(0);
});

it('a rejected write backs off and requires fresh stock without a burst', () => {
  const f = fixture(); f.reject(); f.evaluate(); f.at(1000); f.stats([]); f.evaluate();
  expect(f.sent).toHaveLength(1); expect(f.controller.status().pending).toBe(false);
});

// Keep both authoritative streams fresh while advancing the injected monotonic clock.
function advance(f: ReturnType<typeof fixture>, to: number) {
  for (let t = f.now() + 500; t < to; t += 500) {
    f.at(t); f.clock(); f.stats([]);
  }
  f.at(to); f.clock(); f.stats([]); f.evaluate();
}

it('retries after four seconds, confirms the retry and resumes normal consumption', () => {
  const f = fixture(); f.evaluate(); advance(f, 1500);
  advance(f, 5499); expect(f.sent).toHaveLength(1);
  advance(f, 5500); expect(f.sent).toHaveLength(2);
  f.stats([s(116, 10, 2)]); advance(f, 5900); expect(f.sent).toHaveLength(3);
  advance(f, 7400); advance(f, 11400); expect(f.sent).toHaveLength(4);
});

it('waits after two unconfirmed attempts and releases on a new stock revision', () => {
  const f = fixture(); f.evaluate(); advance(f, 1500); advance(f, 5500);
  advance(f, 7000);
  expect(f.controller.status().reason).toBe('quickslot 1: drink not confirmed by server');
  advance(f, 12000);
  expect(f.sent).toHaveLength(2);
  expect(f.controller.status().reason).toBe('quickslot 1: drink not confirmed by server');
  f.stats([s(116, 10, 4)]); f.evaluate(); expect(f.sent).toHaveLength(3);
  advance(f, 13500); advance(f, 17500); expect(f.sent).toHaveLength(4);
});

it.each(['pending', 'delayed'])('manual use cancels the retry path while %s', phase => {
  const f = fixture(); f.evaluate();
  if (phase === 'delayed') advance(f, 1500);
  f.controller.observeOutgoing(p('USEITEM', { slotObject: slot() }));
  advance(f, 2000); advance(f, 10000);
  expect(f.sent).toHaveLength(1);
  expect(f.controller.status().reason).toBe('awaiting fresh stock');
});

it.each(['map', 'escape', 'connection'])('clears retry bookkeeping on %s', lifecycle => {
  const f = fixture(); f.evaluate(); advance(f, 1500); advance(f, 5500); advance(f, 7000);
  if (lifecycle === 'escape') {
    f.controller.escape(); expect(f.controller.status().pending).toBe(false);
    advance(f, 8000); expect(f.sent).toHaveLength(2);
    f.controller.connectionChanged();
  } else if (lifecycle === 'connection') f.controller.connectionChanged();
  f.spawn(); f.clock(); f.at(8500); f.clock(); f.stats([]); f.evaluate();
  expect(f.sent).toHaveLength(3);
  advance(f, 10000); advance(f, 14000); expect(f.sent).toHaveLength(4);
});

it('retry respects shared cooldown and consumption blockReason', () => {
  const f = fixture({ intervalMs: 5000 }); f.evaluate(); advance(f, 1500);
  f.at(5000); f.controller.observeOutgoing(p('USEITEM', { time: 5100, slotObject: slot(1_000_001, 11) }));
  advance(f, 5500); expect(f.sent).toHaveLength(1);
  advance(f, 9999); expect(f.sent).toHaveLength(1);
  f.at(10000); f.clock(); f.stats([]);
  f.controller.evaluate({ ...gate, consumptionBlockReason: 'automation disabled' });
  expect(f.controller.status().reason).toBe('automation disabled'); expect(f.sent).toHaveLength(1);
  f.evaluate(); expect(f.sent).toHaveLength(2);
});

it('rejected writes get one delayed retry, then wait for stock', () => {
  const f = fixture(); f.reject(); f.evaluate();
  advance(f, 3999); expect(f.sent).toHaveLength(1);
  advance(f, 4000); expect(f.sent).toHaveLength(2);
  advance(f, 10000); expect(f.sent).toHaveLength(2);
  expect(f.controller.status().reason).toBe('quickslot 1: drink write rejected twice');
});

it.each(['excluded', 'quickslot', 'healing', 'hot duration', 'sick', 'protocol'])('retry still honors %s eligibility', rule => {
  const hot = rule === 'healing' || rule === 'hot duration';
  const f = fixture({ healingOverTime: hot }); f.evaluate(); advance(f, 1500);
  if (rule === 'excluded') f.controller.configure({ excludedItems: [10] });
  if (rule === 'quickslot') f.controller.setCatalog([{ ...hpItem, quickslot: false }]);
  if (hot) f.controller.setCatalog([{ ...hpItem, healingDurationMs: 10000 }]);
  if (rule === 'healing') f.stats([s(29, 1 << 17)]);
  if (rule === 'hot duration') f.controller.observeOutgoing(p('USEITEM', { slotObject: slot(1_000_001) }));
  if (rule === 'sick') f.stats([s(29, 1 << 4)]);
  if (rule === 'protocol') f.controller.observeOutgoing(p('USEITEM', { time: 10000, slotObject: slot(1_000_001) }));
  advance(f, 5500); expect(f.sent).toHaveLength(1);
  if (rule === 'excluded') f.controller.configure({ excludedItems: [] });
  if (rule === 'quickslot') f.controller.setCatalog([hpItem]);
  if (rule === 'healing' || rule === 'sick') f.stats([s(29, 0)]);
  if (rule === 'hot duration') advance(f, 11500);
  else if (rule === 'protocol') advance(f, 10300);
  else f.evaluate();
  expect(f.sent).toHaveLength(2);
});

it('escape retires an outstanding retry reservation immediately', () => {
  const f = fixture(); f.evaluate(); advance(f, 1500); advance(f, 5500);
  expect(f.controller.status().pending).toBe(true);
  f.controller.escape(); expect(f.controller.status().pending).toBe(false);
  advance(f, 12000); expect(f.sent).toHaveLength(2);
});

it('escape alone clears an exhausted episode and keeps consumption latched off', () => {
  const f = fixture(); f.reject(); f.evaluate(); advance(f, 4000);
  expect(f.controller.status().exhaustedSlots).toHaveLength(1);
  f.controller.escape();
  expect(f.controller.status().exhaustedSlots).toEqual([]);
  expect(f.controller.status().pending).toBe(false);
  advance(f, 12000);
  expect(f.controller.status().exhaustedSlots).toEqual([]);
  expect(f.controller.status().reason).toBe('escape lifecycle');
  expect(f.sent).toHaveLength(2);
});
