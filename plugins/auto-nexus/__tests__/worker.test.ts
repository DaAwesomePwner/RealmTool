import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoNexusModule } from '../worker.ts';
import { Session, type SessionEnv } from '../../../src/transport/session.ts';
import { SessionAutomation } from '../../../src/transport/automation.ts';
import { Interest } from '../../../src/transport/interest.ts';
import { DEFAULTS, type WorkerEvent } from '../../../src/transport/messages.ts';
import type { WorkerModule, WorkerSessionContext } from '../../../src/transport/modules.ts';
import { Router } from '../../../src/routing/router.ts';
import { createFactory } from '../../../src/protocol/schema.ts';
import { frame, helloBytes, reconnectBytes } from '../../../src/testing/wire.ts';
import { connectGame, FakeServer, until } from '../../../src/testing/net.ts';
import { safetySettings } from '../../../src/safety/SafetyTypes.ts';
import type { SafetyCatalogFile } from '../../../src/safety/SafetyCatalog.ts';
import { SafetyEngine } from '../../../src/safety/SafetyEngine.ts';
import { log } from '../../../src/util/log.ts';

const factory = createFactory();
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => { log.setConsole(false); cleanups.push(log.addSink(() => {})); });
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); log.setConsole(true); });
const catalog: SafetyCatalogFile = { schemaVersion: 1, gameBuild: 'a'.repeat(32),
  source: { objectsSha256: 'b'.repeat(64), tilesSha256: 'c'.repeat(64) },
  projectiles: [[100, 0, 10000, 0, 0, []]], tiles: [] };
const config = (over = {}, file: SafetyCatalogFile | null = catalog) => ({ settings: safetySettings({ enabled: true, ...over }),
  catalog: file, catalogState: file ? { state: 'ready' as const, gameBuild: file.gameBuild, projectiles: file.projectiles.length, tiles: file.tiles.length }
    : { state: 'fallback' as const, reason: 'catalog not loaded' } });
function packet(name: string, data: Record<string, unknown> = {}) {
  const p = factory.createByName(name); Object.assign(p.data, data); return p;
}
const bytes = (name: string, data: Record<string, unknown> = {}) => factory.serialize(packet(name, data));
const hpData = (hp: number | undefined, tickId: number, maxHp = 707) => ({ tickId, tickTime: 200, serverRealTimeMs: 0, serverLastRttMs: 0,
  statuses: [{ objectId: 1, pos: { x: 0, y: 0 }, data: [{ id: 0, value: maxHp }, ...(hp === undefined ? [] : [{ id: 1, value: hp }])] }] });

/** Same encrypted Session/fake game/server harness as src/transport/__tests__/session.test.ts. */
async function harness(over = {}, options: { catalog?: SafetyCatalogFile | null; clientVerdict?: string[]; serverVerdict?: string[] } = {}) {
  autoNexusModule.configure!(config(over, options.catalog));
  let now = 1000;
  const events: WorkerEvent[] = [];
  const order: string[] = [];
  let context!: WorkerSessionContext;
  const tap: WorkerModule = { id: 'test-tap', priority: 100, written: ['ESCAPE'], createSession: ctx => {
    context = ctx; return { written: (_p, _kind, _now, _id, origin) => { order.push(`write:${origin}`); } };
  } };
  const env: SessionEnv = { factory, router: new Router(), interest: new Interest({ observe: { server: ['NEWTICK'], client: ['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE', 'MOVE', 'PLAYERTEXT'] }, verdict: { server: ['RECONNECT', ...options.serverVerdict ?? []], client: options.clientVerdict ?? [] } }),
    modules: [autoNexusModule, tap], post: event => { events.push(event); if (event.type === 'packet') order.push(`packet:${factory.getPacketName(event.data[4], event.fromClient ? 'client' : 'server')}`); },
    now: () => now, fallbackDestination: null, targetTimeoutMs: 1000, helloTimeoutMs: DEFAULTS.helloTimeoutMs, maxPendingBytes: DEFAULTS.maxPendingBytes, onClosed: () => {} };
  const sessions: Session[] = [];
  const listener = net.createServer(socket => sessions.push(new Session(`s${sessions.length}`, socket, env)));
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as net.AddressInfo).port;
  env.router = new Router({ loopbackPort: port });
  cleanups.push(() => new Promise<void>(resolve => { for (const s of sessions) s.close(); listener.close(() => resolve()); }));
  const server = new FakeServer(); await server.listen(); cleanups.push(() => server.close());
  const game = await connectGame(port); cleanups.push(() => game.destroy());
  game.send(helloBytes(factory, Buffer.alloc(0)));
  await until(() => sessions.length === 1, 'accepted game'); const session = sessions[0];
  session.setTarget({ host: '127.0.0.1', port: server.port });
  await until(() => (server.peers[0]?.frames.length ?? 0) >= 1, 'HELLO');
  const upstream = server.peers[0];
  const escapes = () => upstream.frames.filter(f => f[4] === factory.getPacketId('ESCAPE'));
  const held = () => events.filter((e): e is Extract<WorkerEvent, { type: 'packet' }> => e.type === 'packet' && factory.getPacketName(e.data[4], 'server') === 'RECONNECT');
  const send = async (name: string, data: Record<string, unknown>) => {
    const before = game.frames.length; upstream.send(bytes(name, data)); await until(() => game.frames.length > before, name);
  };
  await send('MAPINFO', { name: 'Realm' }); await send('CREATESUCCESS', { objectId: 1, charId: 1 });
  const packets = (name: string) => events.filter((e): e is Extract<WorkerEvent, { type: 'packet' }> =>
    e.type === 'packet' && factory.getPacketName(e.data[4], e.fromClient ? 'client' : 'server') === name);
  const sample = () => {
    now += 200; session.tick(now);
    return events.filter(e => e.type === 'module').map(e => e.message as any).findLast(e => e.type === 'status');
  };
  return { session, upstream, game, context, events, order, server, port, escapes, held, send, packets, sample,
    tick: async (hp: number | undefined, tickId = 1, maxHp = 707) => send('NEWTICK', hpData(hp, tickId, maxHp)),
    advance: (delta: number) => { now += delta; session.tick(now); },
  };
}

describe('Auto Nexus session adapter', () => {
  it('uses the unrounded 707 HP threshold and writes before the triggering main-thread event', async () => {
    const h = await harness(); await h.tick(177); expect(h.escapes()).toHaveLength(0);
    h.order.length = 0; await h.tick(176, 2); await until(() => h.escapes().length === 1, 'ESCAPE');
    expect(h.order.slice(0, 2)).toEqual(['write:auto-nexus', 'packet:NEWTICK']);
    expect(h.context.automation.latchReason).toBe('auto escape');
    expect(h.events.filter(e => e.type === 'module' && (e.message as { type: string }).type === 'decision')).toHaveLength(1);
  });

  it('at zero requires an explicit HP zero, not unknown HP or positive HP', async () => {
    const h = await harness({ thresholdPct: 0 }); await h.tick(undefined); await h.tick(1, 2);
    expect(h.escapes()).toHaveLength(0); await h.tick(0, 3); await until(() => h.escapes().length === 1, 'zero ESCAPE');
  });

  it('writes four retries at 400ms intervals and then stops', async () => {
    const h = await harness(); await h.tick(100); await until(() => h.escapes().length === 1, 'initial');
    for (let count = 2; count <= 5; count++) {
      h.advance(399); expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(count - 1);
      h.advance(1); await until(() => h.escapes().length === count, 'retry');
    }
    h.advance(10000); h.advance(10000); expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(5);
  });

  it('held, dropped and malformed RECONNECT do not stop retries; accepted rewritten RECONNECT does', async () => {
    const h = await harness(); await h.tick(100); await until(() => h.escapes().length === 1, 'initial');
    const reconnect = reconnectBytes(factory, { host: 'localhost', port: h.server.port, key: Buffer.alloc(0) });
    h.upstream.send(reconnect); await until(() => h.held().length === 1, 'held transfer');
    h.advance(400); await until(() => h.escapes().length === 2, 'held retry');
    const first = h.held()[0]; h.session.forward(first.sequence, first.generation, null);
    expect(h.session.inject(reconnectBytes(factory, { host: 'bad host', port: h.server.port, key: Buffer.alloc(0) }), true)).toBe(false);
    h.advance(400); await until(() => h.escapes().length === 3, 'dropped retry');
    h.upstream.send(reconnect); await until(() => h.held().length === 2, 'accepted transfer');
    const second = h.held()[1]; h.session.forward(second.sequence, second.generation, Buffer.from(second.data));
    await until(() => h.game.frames.some(f => f[4] === factory.getPacketId('RECONNECT')), 'written reconnect');
    const written = factory.createFromBytes(h.game.frames.at(-1)!, 'server');
    expect(written.data).toMatchObject({ host: '127.0.0.1', port: h.port });
    h.advance(10000); expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(3);
    expect(h.context.automation.escapeLatched()).toBe(true);
  });

  it('accepted transfer independently latches automation', async () => {
    const h = await harness();
    expect(h.context.automation.escapeLatched()).toBe(false);
    expect(h.session.inject(reconnectBytes(factory, { host: 'localhost', port: h.server.port, key: Buffer.alloc(0) }), true)).toBe(true);
    expect(h.context.automation.latchReason).toBe('transfer');
  });

  it('guards exactly four reports at entry and final writer while other packets and ciphers continue', async () => {
    const h = await harness(); await h.tick(100); await until(() => h.escapes().length === 1, 'initial');
    const reports = ['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE', 'MOVE'];
    for (const name of reports) {
      const report = frame(factory.getPacketId(name)!);
      h.game.send(report); expect(h.session.inject(report, false)).toBe(false);
    }
    h.game.send(bytes('PLAYERTEXT', { text: 'still synchronized' }));
    await until(() => h.upstream.frames.length === 3, 'unrelated packet');
    expect(factory.createFromBytes(h.upstream.frames[2], 'client').data.text).toBe('still synchronized');
    expect(h.events.filter(e => e.type === 'packet' && e.fromClient).map(e => factory.getPacketName((e as Extract<WorkerEvent, { type: 'packet' }>).data[4], 'client'))).toEqual(['PLAYERTEXT']);
    expect(h.upstream.errors).toEqual([]);
    // Disabling and a map reset cannot release an accepted automatic guard.
    autoNexusModule.configure!(config({ enabled: false })); await h.send('MAPINFO', { name: 'Nexus' });
    expect(h.session.inject(frame(factory.getPacketId('MOVE')!), false)).toBe(false);
  });

  it('manual command works while disabled and does not arm report suppression', async () => {
    const h = await harness({ enabled: false }); h.session.command('auto-nexus', { type: 'escape' });
    await until(() => h.escapes().length === 1, 'manual ESCAPE');
    expect(h.context.automation.latchReason).toBe('manual escape');
    for (const name of ['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE', 'MOVE']) expect(h.session.inject(frame(factory.getPacketId(name)!), false)).toBe(true);
    await until(() => h.upstream.frames.length === 6, 'manual reports');
    h.advance(400); expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(1);
  });

  it('accepts prediction config, rejects invalid config whole and immediately rechecks retained HP on valid changes', async () => {
    const h = await harness({ thresholdPct: 20, preHitPrediction: false }); await h.tick(172);
    expect(() => autoNexusModule.configure!(config({ thresholdPct: 20, preHitPrediction: true }))).not.toThrow();
    expect(h.sample()).toMatchObject({ collisionHp: 'on', status: { preHitPrediction: true, lowerHp: 172 } });
    expect(() => autoNexusModule.configure!({ settings: { ...config({ thresholdPct: 25 }).settings, notification: 'invalid' } })).toThrow(/notification must be a boolean/);
    h.advance(200); expect(h.escapes()).toHaveLength(0);
    autoNexusModule.configure!(config({ thresholdPct: 25 }));
    expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(1);
    await until(() => h.escapes().length === 1, 'retained HP escape');
  });
});

describe('Collision HP worker wiring', () => {
  const hit = (bulletId = 1) => bytes('PLAYERHIT', { objectId: 2, bulletId });
  const shoot = (bulletId = 1) => bytes('ENEMYSHOOT', { ownerId: 2, bulletId, bulletType: 0,
    damage: 300, numShots: 1, startingPos: { x: 0, y: 0 } });

  it('defaults ON and escapes on receipt while a PLAYERHIT verdict is blocked, without posting or writing the crossing report', async () => {
    const h = await harness({}, { clientVerdict: ['PLAYERHIT'] }); await h.tick(500);
    h.game.send(hit(1)); await until(() => h.packets('PLAYERHIT').length === 1, 'blocked hit verdict');
    expect(h.context.pendingDelivery().some(p => p.name === 'PLAYERHIT' && p.state === 'awaiting')).toBe(true);
    h.order.length = 0; h.game.send(hit(2));
    await until(() => h.escapes().length === 1, 'receipt-time ESCAPE');
    expect(h.order).toEqual(['write:auto-nexus']);
    expect(h.packets('PLAYERHIT')).toHaveLength(1);
    expect(h.upstream.frames.filter(f => f[4] === factory.getPacketId('PLAYERHIT'))).toHaveLength(0);
    expect(h.sample()).toMatchObject({ collisionHp: 'on', status: { lowerHp: 100, prediction: { pendingDamage: 400 } } });
  });

  it.each(['release', 'drop'] as const)('charges a held report once and retains its loss on %s until eligible reconciliation', async action => {
    const delivered = vi.spyOn(SafetyEngine.prototype, 'reportDelivered');
    const h = await harness({}, { clientVerdict: ['PLAYERHIT'] }); await h.tick(1000, 1, 1000);
    h.game.send(hit()); await until(() => h.packets('PLAYERHIT').length === 1, 'held hit');
    for (let i = 2; i <= 7; ++i) { h.advance(200); await h.tick(1000, i, 1000); }
    expect(h.sample().status.prediction.pendingDamage).toBe(200);
    expect(delivered).not.toHaveBeenCalled();
    const held = h.packets('PLAYERHIT')[0];
    h.session.forward(held.sequence, held.generation, action === 'release' ? Buffer.from(held.data) : null);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0][2]).toBe(action === 'release');
    expect(h.sample().status.prediction.pendingDamage).toBe(200);
    // A receipt older than the grace period cannot retire a just-written report.
    await h.tick(1000, 8, 1000); expect(h.sample().status.prediction.pendingDamage).toBe(200);
    for (let i = 9; i <= 14; ++i) { h.advance(200); await h.tick(1000, i, 1000); }
    expect(h.sample().status.prediction.pendingDamage).toBe(action === 'release' ? 0 : 200);
  });

  it.each(['injected', 'rewritten', 'renamed'] as const)('assesses %s reports before their RC4 and preserves subsequent cipher alignment', async kind => {
    const delivered = vi.spyOn(SafetyEngine.prototype, 'reportDelivered');
    const h = await harness({}, { clientVerdict: ['PLAYERHIT', 'PLAYERTEXT'] });
    await h.tick(kind === 'rewritten' ? 500 : 300);
    if (kind === 'injected') expect(h.session.inject(hit(), false)).toBe(false);
    else {
      const name = kind === 'rewritten' ? 'PLAYERHIT' : 'PLAYERTEXT';
      h.game.send(kind === 'rewritten' ? hit() : bytes('PLAYERTEXT', { text: 'replace me' }));
      await until(() => h.packets(name).length === 1, 'replacement verdict');
      const held = h.packets(name)[0]; h.session.forward(held.sequence, held.generation, hit(2));
    }
    await until(() => h.escapes().length === 1, 'preparation ESCAPE');
    expect(h.upstream.frames.filter(f => f[4] === factory.getPacketId('PLAYERHIT'))).toHaveLength(0);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0][2]).toBe(false);
    if (kind !== 'rewritten') expect(delivered.mock.calls[0][0]).toBeLessThan(0);
    expect(h.session.inject(bytes('PLAYERTEXT', { text: 'cipher intact' }), false)).toBe(true);
    await until(() => h.upstream.frames.length === 3, 'next encrypted packet');
    expect(factory.createFromBytes(h.upstream.frames[2], 'client').data.text).toBe('cipher intact');
    expect(h.upstream.errors).toEqual([]);
  });

  it('reconciles an accepted injected report using its synthetic delivery identity exactly once', async () => {
    const delivered = vi.spyOn(SafetyEngine.prototype, 'reportDelivered');
    const h = await harness(); await h.tick(1000, 1, 1000);
    expect(h.session.inject(hit(), false)).toBe(true);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]).toEqual([expect.any(Number), 1000, true]);
    expect(delivered.mock.calls[0][0]).toBeLessThan(0);
    expect(h.sample().status.prediction.pendingDamage).toBe(200);
    for (let i = 2; i <= 7; ++i) { h.advance(200); await h.tick(1000, i, 1000); }
    expect(h.sample().status.prediction).toMatchObject({ pendingDamage: 0, retiredCount: 1 });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it.each(['awaiting', 'ready', 'dropped', 'zero loss'] as const)('uses pending delivery for %s danger behind a verdict hold', async state => {
    const h = await harness({}, { serverVerdict: ['TEXT', 'ENEMYSHOOT'] }); await h.tick(600);
    if (state !== 'zero loss') {
      h.game.send(hit()); await until(() => h.packets('PLAYERHIT').length === 1, 'pending loss');
    }
    h.upstream.send(bytes('TEXT', { text: 'hold' }));
    await until(() => h.packets('TEXT').length === 1, 'earlier hold');
    h.upstream.send(shoot()); await until(() => h.packets('ENEMYSHOOT').length === 1, 'danger verdict');
    const danger = h.packets('ENEMYSHOOT')[0];
    if (state === 'ready' || state === 'dropped') h.session.forward(danger.sequence, danger.generation,
      state === 'ready' ? Buffer.from(danger.data) : null);
    if (state === 'dropped') expect(h.context.pendingDelivery().some(p => p.name === 'ENEMYSHOOT')).toBe(false);
    h.advance(100); expect(h.escapes()).toHaveLength(0);
    h.advance(1);
    if (state === 'awaiting' || state === 'ready') {
      await until(() => h.escapes().length === 1, 'stalled danger escape');
      expect(h.sample().status.lastReason).toBe('danger delivery stalled behind plugin processing');
    } else expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(0);
  });

  it('explicit OFF forwards reports without debt and still escapes on server HP', async () => {
    const h = await harness({ preHitPrediction: false }); await h.tick(300);
    h.game.send(hit()); await until(() => h.upstream.frames.length === 2, 'OFF hit');
    expect(h.sample()).toMatchObject({ collisionHp: 'off', status: { preHitPrediction: false, lowerHp: 300, prediction: null } });
    expect(h.escapes()).toHaveLength(0);
    await h.tick(176, 2); await until(() => h.escapes().length === 1, 'server HP escape');
  });

  it('falls back to server HP with a null catalog, rejects invalid catalogs whole and resumes ON without invented debt', async () => {
    const h = await harness({}, { catalog: null }); await h.tick(300);
    h.game.send(hit()); await until(() => h.upstream.frames.length === 2, 'fallback hit');
    expect(h.sample()).toMatchObject({ collisionHp: 'fallback', catalog: { state: 'fallback', reason: 'catalog not loaded' },
      status: { preHitPrediction: false, lowerHp: 300, prediction: null, projectileDefinitions: 0 } });
    expect(() => autoNexusModule.configure!({ ...config({ thresholdPct: 100 }), catalog: { ...catalog, schemaVersion: 2 } })).toThrow();
    expect(h.sample()).toMatchObject({ collisionHp: 'fallback', status: { lowerHp: 300 } });
    expect(h.escapes()).toHaveLength(0);
    autoNexusModule.configure!(config());
    expect(h.sample()).toMatchObject({ collisionHp: 'on', catalog: { state: 'ready' },
      status: { lowerHp: 300, prediction: { pendingDamage: 0 }, projectileDefinitions: 1 } });
    // Incur non-crossing debt, then retire it by entering fallback while keeping the HP anchor.
    await h.tick(600, 2); h.game.send(hit(2)); await until(() => h.upstream.frames.length === 3, 'ON hit');
    expect(h.sample().status.prediction.pendingDamage).toBe(200);
    autoNexusModule.configure!(config({}, null));
    expect(h.sample()).toMatchObject({ collisionHp: 'fallback', status: { lowerHp: 600, prediction: null, projectileDefinitions: 0 } });
    autoNexusModule.configure!(config()); expect(h.sample().status.prediction.pendingDamage).toBe(0);
    autoNexusModule.configure!(config({}, null)); await h.tick(176, 3);
    await until(() => h.escapes().length === 1, 'fallback server HP escape');
    expect(h.events.filter(e => e.type === 'module').map(e => e.message).find((e: any) => e.type === 'decision'))
      .toMatchObject({ collisionHp: 'fallback', catalog: { state: 'fallback' }, decision: { reason: 'server HP threshold' } });
  });

  it('clears prediction on reconnect and assesses a surviving held report afresh in the new epoch', async () => {
    const delivered = vi.spyOn(SafetyEngine.prototype, 'reportDelivered');
    const h = await harness({}, { clientVerdict: ['PLAYERHIT'], serverVerdict: ['ENEMYSHOOT'] }); await h.tick(1000, 1, 1000);
    h.game.send(hit()); await until(() => h.packets('PLAYERHIT').length === 1, 'surviving hit');
    expect(h.sample().status.prediction.pendingDamage).toBe(200);
    h.upstream.send(shoot()); await until(() => h.packets('ENEMYSHOOT').length === 1, 'old danger');
    const held = h.packets('PLAYERHIT')[0]; const oldEpoch = h.sample().status.epoch;
    // Exercise the same generation change used by transport's upstream retry.
    h.session['connect']({ host: '127.0.0.1', port: h.server.port }, helloBytes(factory, Buffer.alloc(0)));
    await until(() => (h.server.peers[1]?.frames.length ?? 0) === 1, 'new upstream HELLO');
    expect(h.sample()).toMatchObject({ generation: 2, status: { confirmedHp: null, prediction: { pendingDamage: 0 } } });
    const upstream = h.server.peers[1];
    upstream.send(bytes('MAPINFO', { name: 'Realm' })); upstream.send(bytes('CREATESUCCESS', { objectId: 1, charId: 1 }));
    const count = h.packets('NEWTICK').length;
    upstream.send(bytes('NEWTICK', hpData(600, 1, 1000)));
    await until(() => h.packets('NEWTICK').length > count, 'new HP anchor');
    h.session.forward(held.sequence, held.generation, Buffer.from(held.data));
    await until(() => upstream.frames.length === 2, 'surviving report written');
    expect(h.sample()).toMatchObject({ generation: 2, status: { confirmedHp: 600, lowerHp: 400, prediction: { pendingDamage: 200 } } });
    expect(h.sample().status.epoch).toBeGreaterThan(oldEpoch);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0][2]).toBe(true);
    expect(h.order.filter(s => s === 'write:auto-nexus')).toHaveLength(0);
    expect(upstream.errors).toEqual([]);
  });
});

describe('Auto Nexus module lifecycle', () => {
  function local(accept = true) {
    let now = 0; let generation = 1;
    let blocked = false;
    const automation = new SessionAutomation(); automation.reset(generation);
    const messages: any[] = [];
    const writePriority = vi.fn((_data, _toClient, done) => { if (accept) done?.(); return accept; });
    const ctx: WorkerSessionContext = { sessionId: 'local', factory, automation, generation: () => generation, now: () => now,
      writePriority, transport: () => ({ available: true, backlog: true, upstreamBackpressure: blocked }), held: () => [], pendingDelivery: () => [], post: m => messages.push(m) };
    autoNexusModule.configure!(config()); const module = autoNexusModule.createSession(ctx); cleanups.push(() => module.close!());
    const observe = (name: string, data: Record<string, unknown>) => module.observe!(packet(name, data), false, now, 1);
    observe('MAPINFO', { name: 'Realm' }); observe('CREATESUCCESS', { objectId: 1 });
    return { module, ctx, messages, writePriority, observe,
      advance: (ms: number) => { now += ms; module.tick!(now); },
      block: () => { blocked = true; },
      replace: () => { automation.reset(++generation); module.connectionChanged!(generation); } };
  }

  it('latches rejected decisions before posting but only accepted writes arm the guard', () => {
    const f = local(false); f.observe('NEWTICK', hpData(100, 1));
    expect(f.ctx.automation.latchReason).toBe('auto escape');
    expect(f.module.suppressEntry!('MOVE', true)).toBe(false);
    expect(f.messages.find(m => m.type === 'decision').status.attemptPhase).toBe('failed');
  });

  it('releases the guard only on new generation and emits a fresh generation status', () => {
    const f = local(); f.observe('NEWTICK', hpData(100, 1));
    expect(f.module.suppressEntry!('MOVE', true)).toBe(true);
    expect(f.module.suppressEntry!('MOVE', false)).toBe(false);
    f.replace(); expect(f.module.suppressEntry!('MOVE', true)).toBe(false);
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', generation: 2, status: { confirmedHp: null } });
    f.advance(199); const count = f.messages.length; f.advance(1); expect(f.messages).toHaveLength(count + 1);
  });

  it('applies module configuration to all live sessions and removes closed instances', () => {
    const first = local(); const second = local();
    for (const f of [first, second]) f.observe('NEWTICK', hpData(200, 1));
    first.module.close!(); autoNexusModule.configure!(config({ thresholdPct: 30 }));
    expect(first.writePriority).not.toHaveBeenCalled(); expect(second.writePriority).toHaveBeenCalledTimes(1);
    second.module.close!(); second.advance(400); expect(second.writePriority).toHaveBeenCalledTimes(1);
  });

  it('advances only one retry after a long delay, and uses upstream backpressure rather than held verdict backlog', () => {
    const f = local(); f.observe('NEWTICK', hpData(100, 1));
    f.advance(1600); expect(f.writePriority).toHaveBeenCalledTimes(2);
    f.advance(0); expect(f.writePriority).toHaveBeenCalledTimes(2);
    f.block(); f.advance(400); expect(f.writePriority).toHaveBeenCalledTimes(2);
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: { attemptPhase: 'failed' } });
  });

  it.each([null, [], {}, { settings: null }, { settings: { enabled: 'true' } }, { settings: { thresholdPct: NaN } }, { settings: { notification: 1 } }])('rejects invalid configuration %j without changing existing settings', invalid => {
    const f = local(); f.observe('NEWTICK', hpData(200, 1));
    expect(() => autoNexusModule.configure!(invalid)).toThrow();
    f.advance(200); expect(f.writePriority).not.toHaveBeenCalled();
    f.observe('NEWTICK', hpData(176, 2)); expect(f.writePriority).toHaveBeenCalledTimes(1);
  });
});
