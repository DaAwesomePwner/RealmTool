// Adapted from realm-engine-client client/src/status/__tests__/AutoNexusPlugin.test.ts @ 88a66b2 (MIT, see NOTICE).
// Adapted from realm-engine-client client/src/plugins/__tests__/autoNexusSettings.test.ts @ 88a66b2 (MIT, see NOTICE).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin, { register } from '../index.ts';
import type { SafetyCatalogLoad } from '../../../src/data/safety.ts';
import type { AutoNexusEvent } from '../messages.ts';
import { DEFAULTS, SETTING_DEFS, migrate, validate } from '../settings.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';
import { SafetyEngine } from '../../../src/safety/SafetyEngine.ts';
import type { SafetyDecision } from '../../../src/safety/SafetyTypes.ts';

const cleanups: (() => void)[] = [];
let records: LogRecord[];
beforeEach(() => { records = []; log.setConsole(false); cleanups.push(log.addSink(r => records.push(r))); });
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); log.setConsole(true); vi.restoreAllMocks(); });
const ready = { state: 'ready', gameBuild: 'A', projectiles: 0, tiles: 0 } as const;
const catalog: SafetyCatalogLoad = { ok: true, path: 'fixture', catalog: { schemaVersion: 1, gameBuild: 'A', source: { objectsSha256: 'a'.repeat(64), tilesSha256: 'b'.repeat(64) }, projectiles: [], tiles: [] } };
function fixture(settings?: Record<string, unknown>, enabled?: boolean, loaded = catalog, buildReader = (_dir: string) => 'A', gameDir: string | null = 'game') {
  const dir = mkdtempSync(join(tmpdir(), 'realmtool-nexus-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'profiles'));
  if (settings || enabled !== undefined) writeFileSync(join(dir, 'profiles', 'default.json'), JSON.stringify({ schemaVersion: 1, plugins: { 'auto-nexus': { settings, enabled } } }));
  const h = startHost([{ ...plugin, register: ctx => register(ctx, () => loaded, buildReader) }], { profileDir: dir, gameDir }); cleanups.push(() => h.host.stop());
  const client = h.connect();
  const ctx = h.host.context('auto-nexus')!;
  return { h, ctx, client,
    command(text = '/an', id = client) { h.packet(id, 'PLAYERTEXT', { text }); },
    reply: () => h.factory.createFromBytes(h.proxy.injected.at(-1)!.data, 'server').data,
    snapshot() { ctx.updateSetting('ForceAutoNexusHealth', ctx.getSetting('ForceAutoNexusHealth')); h.profile.flush(); return JSON.parse(readFileSync(h.profile.path, 'utf8')).plugins['auto-nexus']; },
  };
}
const status = () => new SafetyEngine(() => {}).status();

describe('Auto Nexus UI status', () => {
  it('disarms stale data immediately and only restores Collision HP after a verified reload', () => {
    const f = fixture(); f.h.host.notifyDataInvalidated('game files changed');
    expect(f.h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalog: null, catalogState: { state: 'fallback' } });
    f.ctx.enabled = false; f.ctx.enabled = true; f.h.connect('another');
    expect(f.h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalog: null });
    f.h.host.notifyDataRefreshed();
    expect(f.h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalogState: ready });
  });
  it('reloads fallback into ready without reconnecting and preserves it on failure', () => {
    let loaded: SafetyCatalogLoad = { ok: false, reason: 'missing' };
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-reload-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const h = startHost([{ ...plugin, register: ctx => register(ctx, () => loaded, () => 'A') }], { profileDir: dir, gameDir: 'fixture' });
    cleanups.push(() => h.host.stop()); h.connect();
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalogState: { state: 'fallback' } });
    loaded = catalog; h.host.notifyDataRefreshed();
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalog: catalog.ok ? catalog.catalog : null, catalogState: ready });
    const count = h.proxy.configured.length;
    loaded = { ok: false, reason: 'invalid replacement' }; h.host.notifyDataRefreshed();
    expect(h.proxy.configured).toHaveLength(count);
  });
  it('retries a thrown reload on the next session', () => {
    let loaded: SafetyCatalogLoad = catalog;
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-retry-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const h = startHost([{ ...plugin, register: ctx => register(ctx, () => loaded, () => 'A') }],
      { profileDir: dir, gameDir: 'fixture' });
    cleanups.push(() => h.host.stop());
    h.host.notifyDataInvalidated('stale');
    loaded = { ok: false, reason: 'transient failure' };
    h.host.notifyDataRefreshed();
    expect(records.some(r => r.message.includes('Catalog reload failed'))).toBe(true);
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalog: null });
    loaded = catalog; h.connect();
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalogState: ready });
  });
  it('retries failed reloads mid-session at most once per 15 seconds, except while invalidated', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const loader = vi.fn((): SafetyCatalogLoad => catalog);
    const dir = mkdtempSync(join(tmpdir(), 'realmtool-message-retry-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const h = startHost([{ ...plugin, register: ctx => register(ctx, loader, () => 'A') }],
      { profileDir: dir, gameDir: 'fixture' });
    cleanups.push(() => h.host.stop());
    const client = h.connect();
    const send = () => h.workerMessage(client, 'auto-nexus', { type: 'status', generation: 1,
      sampledAt: now, collisionHp: 'fallback', catalog: { state: 'fallback', reason: 'stale' }, status: status() });
    h.host.notifyDataInvalidated('stale');
    const before = loader.mock.calls.length;
    send(); expect(loader).toHaveBeenCalledTimes(before);
    loader.mockImplementation(() => { throw new Error('disk busy'); });
    h.host.notifyDataRefreshed();
    send();
    const failed = loader.mock.calls.length;
    loader.mockReturnValue(catalog);
    now = 14_999; send(); expect(loader).toHaveBeenCalledTimes(failed);
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalog: null });
    now = 15_000; send();
    expect(loader).toHaveBeenCalledTimes(failed + 1);
    expect(h.proxy.configured.at(-1)?.['auto-nexus']).toMatchObject({ catalogState: ready });
  });
  it('does not sync an unchanged catalog retry', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(undefined, true, { ok: false, reason: 'missing' });
    const before = f.h.proxy.configured.length;
    sendStatus(f);
    now = 15_000; sendStatus(f);
    expect(f.h.proxy.configured).toHaveLength(before);
  });
  it('publishes only the sanitized fresh status shape', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const f = fixture(); const publish = vi.spyOn(f.ctx, 'broadcastData');
    sendStatus(f, 'on');
    const expected = { clientId: f.client, collisionHp: 'on', catalog: ready,
      enabled: status().enabled, phase: status().phase, thresholdPct: 25,
      protectionState: status().protectionState, degraded: null, automaticEligible: false,
      confirmedHp: status().confirmedHp, maxHp: status().maxHp, lowerHp: status().lowerHp,
      pendingDamage: 230, pendingCount: 2, attemptPhase: status().attemptPhase, sampledAgeMs: 0 };
    expect(f.h.host.data('auto-nexus')!.get('status')).toEqual(expected);
    expect(publish).toHaveBeenCalledExactlyOnceWith('status', expected);
  });
  it('coalesces to the latest sample at 250ms and cancels pending samples on disconnect and cleanup', () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const publish = vi.spyOn(f.ctx, 'broadcastData');
    sendStatus(f, 'on'); now = 1100; sendStatus(f, 'off');
    now = 1200; sendStatus(f, 'fallback'); expect(publish).toHaveBeenCalledTimes(1);
    now = 1250; vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][1]).toMatchObject({ collisionHp: 'fallback', sampledAgeMs: 50 });
    now = 1300; sendStatus(f, 'on'); f.ctx.enabled = false; f.h.close(f.client);
    expect(publish).toHaveBeenLastCalledWith('status', { clientId: f.client, state: 'disconnected' });
    const count = publish.mock.calls.length; now = 2000; vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(count);
    const other = f.h.connect('other'); sendStatus(f, 'on', other); sendStatus(f, 'off', other);
    f.h.host.stop(); const stopped = publish.mock.calls.length; vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(stopped);
  });
  it('coalesces independently for two clients and only cancels the disconnected client', () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(), other = f.h.connect('other'), publish = vi.spyOn(f.ctx, 'broadcastData');
    sendStatus(f, 'on'); sendStatus(f, 'on', other);
    expect(publish).toHaveBeenCalledTimes(2);
    now = 1100; sendStatus(f, 'off'); sendStatus(f, 'fallback', other);
    now = 1250; vi.advanceTimersByTime(250);
    expect(publish.mock.calls.slice(2).map(([, data]) => data)).toEqual([
      expect.objectContaining({ clientId: f.client, collisionHp: 'off' }),
      expect.objectContaining({ clientId: other, collisionHp: 'fallback' }),
    ]);
    now = 1300; sendStatus(f, 'on'); sendStatus(f, 'on', other); f.h.close(f.client);
    publish.mockClear(); now = 1500; vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledExactlyOnceWith('status', expect.objectContaining({ clientId: other }));
    now = 1550; sendStatus(f, 'off', other); f.h.host.stop(); publish.mockClear();
    now = 2000; vi.advanceTimersByTime(1000); expect(publish).not.toHaveBeenCalled();
  });
  it('does not publish stale, future, or older-generation samples', () => {
    let now = 4000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const publish = vi.spyOn(f.ctx, 'broadcastData');
    const send = (generation: number, sampledAt: number) => f.h.workerMessage(f.client, 'auto-nexus', {
      type: 'status', generation, sampledAt, status: status(), collisionHp: 'off', catalog: ready,
    });
    send(2, 1000); send(2, 4001); expect(publish).not.toHaveBeenCalled();
    send(3, now); expect(publish).toHaveBeenCalledTimes(1);
    now += 250; send(2, now); expect(publish).toHaveBeenCalledTimes(1);
  });
  it('rechecks freshness and generation at delayed publication and never revives a future sample', () => {
    vi.useFakeTimers(); cleanups.push(() => vi.useRealTimers());
    let now = 4000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const publish = vi.spyOn(f.ctx, 'broadcastData');
    const send = (sampledAt = now) => f.h.workerMessage(f.client, 'auto-nexus', {
      type: 'status', generation: 1, sampledAt, status: status(), collisionHp: 'off', catalog: ready,
    });
    send(); now += 100; send(); send(now + 1);
    now += 150; vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledTimes(1);
    send(); now += 100; send(); now += 2001; vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledTimes(2);
    send(); now += 100; send();
    f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', collisionHp: 'off', catalog: ready,
      status: status(), writeDelayMs: 0,
      decision: { origin: 'manual', connectionGeneration: 2, confirmedHp: 10, maxHp: 100, reason: 'manual' } });
    now += 150; vi.advanceTimersByTime(250);
    expect(publish).toHaveBeenCalledTimes(3);
  });
});

describe('Auto Nexus facade', () => {
  it('declares exactly the five canonical controls', () => {
    expect(SETTING_DEFS).toEqual([
      { key: 'PreHitPrediction', label: 'Collision HP', type: 'boolean', value: true },
      { key: 'ForceAutoNexusHealth', label: 'Nexus Health (0%: confirmed server zero only)', type: 'range', value: 25, min: 0, max: 100, step: 1 },
      { key: 'ShowChatMessageOnNexus', label: 'Show Chat Message on Nexus', advanced: true, type: 'boolean', value: true },
      { key: 'EscapeRetryCount', label: 'Escape Retries', advanced: true, type: 'range', value: 4, min: 0, max: 10, step: 1 },
      { key: 'EscapeRetryIntervalMs', label: 'Escape Retry Interval', advanced: true, type: 'range', value: 400, min: 100, max: 2000, step: 50 },
    ]);
    const f = fixture();
    for (const def of SETTING_DEFS) expect(f.ctx.getSetting(def.key)).toBe(def.value);
    expect(f.h.proxy.configured).toEqual([{ 'auto-nexus': { settings: { enabled: true, preHitPrediction: true, thresholdPct: 25, notification: true, retryCount: 4, retryMs: 400, reactionMs: 400 },
      catalog: catalog.ok ? catalog.catalog : null, catalogState: ready } }]);
  });

  it.each([true, false])('publishes one complete saved startup configuration, enabled=%s', enabled => {
    const f = fixture({ ForceAutoNexusHealth: 19, ShowChatMessageOnNexus: false, EscapeRetryCount: 6.9, EscapeRetryIntervalMs: 700,
      PredictionModel: 'v1', BurstGuard: true, ReactionWindowMs: 900, InstantNexus: true, PreHitPrediction: true }, enabled);
    expect(f.h.proxy.configured).toEqual([{ 'auto-nexus': { settings: { enabled, preHitPrediction: true, thresholdPct: 19, notification: false, retryCount: 6, retryMs: 700, reactionMs: 400 },
      catalog: catalog.ok ? catalog.catalog : null, catalogState: ready } }]);
    expect(f.snapshot().settings).toEqual({ PreHitPrediction: true, ForceAutoNexusHealth: 19, ShowChatMessageOnNexus: false, EscapeRetryCount: 6, EscapeRetryIntervalMs: 700 });
  });

  it('clamps finite ranges, truncates retries and drops all retired keys', () => {
    expect(migrate({ ForceAutoNexusHealth: 150, EscapeRetryCount: 6.9, EscapeRetryIntervalMs: -1, PreHitPrediction: true }, true))
      .toEqual({ ...DEFAULTS, ForceAutoNexusHealth: 100, EscapeRetryCount: 6, EscapeRetryIntervalMs: 100 });
    expect(validate('ForceAutoNexusHealth', -1)).toBe(0);
    expect(validate('EscapeRetryCount', 20)).toBe(10);
    expect(validate('EscapeRetryIntervalMs', 3000)).toBe(2000);
    expect(migrate(undefined, false)).toEqual(DEFAULTS);
    expect(migrate({}, true)).toEqual(DEFAULTS);
    expect(() => migrate([], true)).toThrow();
  });

  it.each<[string, unknown]>([
    ['ForceAutoNexusHealth', '30'], ['ForceAutoNexusHealth', NaN], ['EscapeRetryCount', Infinity],
    ['EscapeRetryIntervalMs', null], ['ShowChatMessageOnNexus', 'false'], ['ShowChatMessageOnNexus', 1],
    ...['PredictionModel', 'BurstGuard', 'ReactionWindowMs', 'InstantNexus'].map(key => [key, true] as [string, unknown]),
  ])('rejects invalid live %s=%j without mutation or publication', (key, value) => {
    const f = fixture(); const before = f.h.proxy.configured.length;
    const old = f.ctx.getSetting(String(key));
    expect(f.ctx.updateSetting(String(key), value)).toBe(false);
    expect(f.ctx.getSetting(String(key))).toBe(old);
    expect(f.h.proxy.configured).toHaveLength(before);
  });

  it('rejects a saved profile whole with defaults and one warning', () => {
    const f = fixture({ ForceAutoNexusHealth: 80, EscapeRetryCount: 'bad' });
    expect(f.snapshot().settings).toEqual(DEFAULTS);
    expect(records.filter(r => r.level === 'warn')).toHaveLength(1);
    expect(records.find(r => r.level === 'warn')!.message).toMatch(/saved settings are invalid.*using defaults/);
  });

  it('keeps updates immediate, retains other values and syncs enable changes', () => {
    const f = fixture({ EscapeRetryCount: 7 });
    f.command('/an 30');
    expect(f.ctx.getSetting('ForceAutoNexusHealth')).toBe(30);
    expect(f.reply().text).toContain('Threshold 30%');
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { thresholdPct: 30, retryCount: 7 } } });
    f.ctx.enabled = false;
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { enabled: false, thresholdPct: 30 } } });
  });

  it.each(['/an abc', '/an 101', '/an -1'])('rejects command %s', text => {
    const f = fixture(); const before = f.h.proxy.configured.length; f.command(text);
    expect(f.reply().text).toBe('Usage: /an [0-100]');
    expect(f.h.proxy.configured).toHaveLength(before);
  });

  it('sends manual escape to only that client with no reply; reset explains server reconciliation', () => {
    const f = fixture(); f.command('/nexus');
    expect(f.h.proxy.commands).toEqual([{ moduleId: 'auto-nexus', id: f.client, message: { type: 'escape' } }]);
    expect(f.h.proxy.injected).toEqual([]);
    const before = f.h.proxy.configured.length; f.command('/reset');
    expect(f.reply().text).toBe('Pending loss reconciles from server evidence and cannot be erased by command.');
    expect(f.h.proxy.configured).toHaveLength(before);
  });

  it('uses fresh worker status scoped to client and generation, with monotonic expiry', () => {
    let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const other = f.h.connect('other');
    const send = (generation: number, sampledAt = now) => f.h.workerMessage(f.client, 'auto-nexus', { type: 'status', catalog: ready, collisionHp: 'off', status: { ...status(), attemptOrigin: 'manual', attemptPhase: 'written' }, sampledAt, generation });
    send(2); f.command();
    expect(f.reply().text).toContain('worker disabled; automatic not eligible; protection disabled; Collision HP off; catalog game build A; pending damage 0, count 0; assumed count 0; attempt MANUAL NEXUS written');
    f.command('/an', other); expect(f.reply().text).toContain('Worker status unavailable');
    now += 2001; f.command(); expect(f.reply().text).toContain('Worker status unavailable');
    send(1); f.command(); expect(f.reply().text).toContain('Worker status unavailable');
    send(3); f.command(); expect(f.reply().text).toContain('MANUAL NEXUS written');
    now += 100; send(3, now - 3000); f.command(); expect(f.reply().text).toContain('Worker status unavailable');
    send(3, now + 1); f.command(); expect(f.reply().text).toContain('Worker status unavailable');
    send(3); f.command('/an 0'); expect(f.reply().text).toContain('proactive escapes suppressed; confirmed server zero only; manual Nexus available');
  });

  it.each(['manual', 'automatic'] as const)('labels %s decisions, logs even with notifications disabled', origin => {
    const f = fixture();
    const decision: SafetyDecision = { origin, attemptId: 1, connectionGeneration: 1, lifecycleRevision: 1, reason: 'reason', epoch: 1,
      confirmedHp: 80, lowerHp: 80, maxHp: 100, thresholdHp: 25, at: 1,
      evidence: { trigger: 'reason', preHitPrediction: false, reactionMs: 400, pendingCount: 0, pendingDamage: 0, impacts: [],
        retirementEnabled: false, graceMs: 1000, lastHpAgeMs: 0 } };
    const send = () => f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', catalog: ready, collisionHp: 'off', decision, status: status(), writeDelayMs: 0.25 });
    send(); const label = origin === 'manual' ? 'MANUAL NEXUS' : 'AUTO NEXUS';
    expect(f.reply().name).toBe(label);
    expect(f.reply().text).toBe('Server HP 80/100; threshold 25%; reason; Collision HP off; local write attempt 0.250ms (not server acceptance)');
    f.ctx.updateSetting('ShowChatMessageOnNexus', false); const count = f.h.proxy.injected.length; send();
    expect(f.h.proxy.injected).toHaveLength(count);
    expect(records.filter(r => r.message.startsWith(`${label} —`))).toHaveLength(2);
  });

  it('logs which collision reports made up the predicted loss, without changing the chat text', () => {
    const f = fixture();
    const hit = (amount: number, kind: 'assumed' | 'mitigated-estimate', reason: string | null, raw: number | null, ageMs: number) =>
      ({ id: String(amount), amount, source: 'player-hit' as const, ageMs, kind, reason, raw, credited: 0, writtenAt: null });
    const decision: SafetyDecision = { origin: 'automatic', attemptId: 1, connectionGeneration: 1, lifecycleRevision: 1,
      reason: 'predicted HP crosses threshold', epoch: 1, confirmedHp: 755, lowerHp: 183, maxHp: 755, thresholdHp: 188, at: 1,
      evidence: { trigger: 'reported impact', preHitPrediction: true, reactionMs: 400, pendingCount: 3, pendingDamage: 572,
        retirementEnabled: true, graceMs: 580, lastHpAgeMs: 31200,
        impacts: [hit(200, 'assumed', 'missing-shot', null, 140.4), hit(372, 'mitigated-estimate', 'standard projectile', 420, 0)] } };
    f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', catalog: ready, collisionHp: 'on', decision, status: status(), writeDelayMs: 0.25 });
    expect(f.reply().text).not.toContain('pending loss');
    expect(records.at(-1)?.message).toMatch(/; local write attempt 0\.250ms \(not server acceptance\); pending loss 572 from 3 reports: /);
    expect(records.at(-1)?.message).toContain('pending loss 572 from 3 reports: player-hit 200 assumed (missing-shot) 140 ms ago, '
      + 'player-hit 372 (raw 420) mitigated-estimate 0 ms ago, 1 more; reconciliation on, grace 580 ms, last HP sample 31200 ms ago');
    decision.evidence.retirementEnabled = false; decision.evidence.lastHpAgeMs = null;
    f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', catalog: ready, collisionHp: 'on', decision, status: status(), writeDelayMs: 0.25 });
    expect(records.at(-1)?.message).toContain('; reconciliation off, grace 580 ms, last HP sample unknown');
    decision.evidence.pendingCount = 0; decision.evidence.pendingDamage = 0; decision.evidence.impacts = [];
    f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', catalog: ready, collisionHp: 'on', decision, status: status(), writeDelayMs: 0.25 });
    expect(records.at(-1)?.message).not.toContain('reconciliation');
  });

  it('cleans up subscriptions and disarms the worker on stop', () => {
    const f = fixture(); f.h.host.stop();
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { enabled: false } } });
    expect(f.h.proxy.listenerCount('module')).toBe(0);
  });
});

function sendStatus(f: ReturnType<typeof fixture>, mode: AutoNexusEvent['collisionHp'] = 'fallback', client = f.client, reason = 'missing', objectId = 1) {
  f.h.workerMessage(client, 'auto-nexus', { type: 'status', thresholdPct: 25, generation: 1, sampledAt: performance.now(),
    status: { ...status(), objectId, prediction: { pendingDamage: 230, pendingCount: 2, assumedCount: 1 } },
    collisionHp: mode, catalog: mode === 'fallback' ? { state: 'fallback', reason } : ready });
}
describe('Collision HP facade', () => {
  it('waits for an in-game player before consuming the fallback notice', () => {
    const f = fixture(undefined, true, { ok: false, reason: 'missing' });
    sendStatus(f, 'fallback', f.client, 'missing', 0);
    sendStatus(f, 'fallback', f.client, 'missing', 0);
    expect(f.h.proxy.injected).toHaveLength(0);
    sendStatus(f, 'fallback', f.client, 'missing', 42);
    expect(f.h.proxy.injected).toHaveLength(1);
    expect(f.reply().text).toBe('Collision HP FALLBACK: server HP only (missing). RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log.');
    sendStatus(f, 'fallback', f.client, 'missing', 42);
    sendStatus(f, 'fallback', f.client, 'missing', 42);
    expect(f.h.proxy.injected).toHaveLength(1);
  });
  it.each([undefined, {}, { ForceAutoNexusHealth: 30 }])('defaults migration to ON for %j', saved => {
    expect(migrate(saved, saved !== undefined).PreHitPrediction).toBe(true);
  });
  it('preserves explicit OFF and publishes toggles', () => {
    expect(migrate({ PreHitPrediction: false }, true).PreHitPrediction).toBe(false);
    const f = fixture({ PreHitPrediction: false });
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { preHitPrediction: false } } });
    f.ctx.updateSetting('PreHitPrediction', true);
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { preHitPrediction: true } } });
    expect(records.some(r => r.message.includes('Collision HP on'))).toBe(true);
  });
  it.each(['false', 0, null])('rejects invalid saved prediction %j', value => {
    expect(() => migrate({ PreHitPrediction: value }, true)).toThrow();
    expect(() => validate('PreHitPrediction', value)).toThrow();
  });
  it.each(['safety catalog not found', 'Invalid JSON', 'Missing or invalid gameBuild'])('falls back for %s without changing saved ON', reason => {
    const f = fixture(undefined, true, { ok: false, reason });
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalog: null, catalogState: { state: 'fallback', reason } } });
    expect(f.snapshot().settings.PreHitPrediction).toBe(true);
    expect(records.some(r => r.level === 'warn' && r.message.includes(reason))).toBe(true);
  });
  it.each([null, 'game'])('falls back for unknown installed build (%s)', dir => {
    const f = fixture(undefined, true, catalog, () => { throw new Error('unreadable'); }, dir);
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalog: null, catalogState: { state: 'fallback', reason: expect.stringContaining('installed game build unknown') } } });
  });
  it('rechecks changes on connection and enable, restores catalog, and suppresses obsolete notices', () => {
    let build = 'A'; const f = fixture(undefined, true, catalog, () => build);
    build = 'B'; const other = f.h.connect('other');
    const reason = 'catalog is for game build A but the installed game is B; RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log';
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalog: null, catalogState: { state: 'fallback', reason } } });
    expect(f.h.proxy.injected).toHaveLength(0);
    sendStatus(f, 'fallback', other, reason); sendStatus(f, 'fallback', other, reason);
    expect(f.h.proxy.injected).toHaveLength(1);
    expect(f.reply().text).toBe(`Collision HP FALLBACK: server HP only (${reason}). RealmTool refreshes game data automatically; if it keeps failing, use "Refresh game data" in RealmTool and check the log.`);
    build = 'A'; const restored = f.h.connect('restored');
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalogState: ready } });
    sendStatus(f, 'fallback', restored, reason); sendStatus(f, 'on', restored);
    expect(f.h.proxy.injected).toHaveLength(1);
    f.ctx.enabled = false; build = 'B'; f.ctx.enabled = true;
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalog: null } });
    f.ctx.enabled = false; build = 'A'; f.ctx.enabled = true;
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalogState: ready } });
  });
  it('notifies once per connection, including when decision is the first event', () => {
    const f = fixture(undefined, true, { ok: false, reason: 'missing' });
    sendStatus(f); sendStatus(f);
    const other = f.h.connect('other');
    f.h.workerMessage(other, 'auto-nexus', { type: 'decision', collisionHp: 'fallback', catalog: { state: 'fallback', reason: 'missing' }, status: { ...status(), objectId: 1 }, writeDelayMs: 0,
      decision: { connectionGeneration: 1, origin: 'automatic', confirmedHp: 10, maxHp: 100, reason: 'threshold' } });
    sendStatus(f, 'fallback', other);
    const texts = f.h.proxy.injected.map(p => f.h.factory.createFromBytes(p.data, 'server').data.text);
    expect(texts.filter(t => String(t).startsWith('Collision HP FALLBACK:'))).toHaveLength(2);
    expect(texts.some(t => String(t).includes('Collision HP fallback (server HP only): missing'))).toBe(true);
  });
  it.each([false, true])('does not notify when disabled or ready (enabled=%s)', enabled => {
    const f = fixture(undefined, enabled, enabled ? catalog : { ok: false, reason: 'missing' });
    sendStatus(f, enabled ? 'on' : 'fallback');
    expect(f.h.proxy.injected).toHaveLength(0);
  });
  it.each(['on', 'off', 'fallback'] as const)('shows fresh effective %s status and pending estimates', mode => {
    const f = fixture(); sendStatus(f, mode); f.command();
    expect(f.reply().text).toContain(mode === 'fallback' ? 'Collision HP fallback (server HP only): missing' : `Collision HP ${mode}; catalog game build A`);
    expect(f.reply().text).toContain('pending damage 230, count 2; assumed count 1');
  });
  it('shows estimated HP for ON decisions', () => {
    const f = fixture();
    f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', collisionHp: 'on', catalog: ready, status: status(), writeDelayMs: 0,
      decision: { origin: 'automatic', connectionGeneration: 1, confirmedHp: 80, lowerHp: 20, maxHp: 100, reason: 'threshold' } });
    expect(f.reply().text).toContain('Server HP 80/100; estimated HP 20');
    expect(f.reply().text).toContain('Collision HP on');
  });
});

it('publishes degraded reasons and warns only on transitions, rate limited per reason across reconnects', () => {
  let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  const send = (degraded: string | null, client = f.client) => f.h.workerMessage(client, 'auto-nexus', {
    type: 'status', generation: 1, sampledAt: now,
    status: { ...status(), objectId: 1, enabled: true, protectionState: degraded ? 'monitoring-degraded' : 'monitoring', degraded },
    collisionHp: 'on', catalog: ready,
  });
  send('server-hp-stale');
  expect(f.h.host.data('auto-nexus')!.get('status')).toMatchObject({ degraded: 'server-hp-stale', protectionState: 'monitoring-degraded' });
  expect(f.reply().text).toContain('server-hp-stale');
  const count = f.h.proxy.injected.length;
  send('server-hp-stale'); send(null); send('server-hp-stale');
  expect(f.h.proxy.injected).toHaveLength(count);
  send('hp-stream-unreadable'); expect(f.h.proxy.injected).toHaveLength(count + 1);
  for (let i = 0; i < 10; ++i) { send(null); send('hp-stream-unreadable'); }
  expect(records.filter(r => r.message.includes('degraded'))).toHaveLength(2);
  now += 29999; f.h.close(f.client);
  const other = f.h.connect('other'); send('server-hp-stale', other);
  expect(f.h.proxy.injected).toHaveLength(count + 1);
  now += 1; send(null, other); send('server-hp-stale', other);
  expect(f.h.proxy.injected).toHaveLength(count + 2);
  expect(records.filter(r => r.message.includes('degraded'))).toHaveLength(3);
});

it('notifies each new HP-stream reason while map decoding remains unreadable', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const f = fixture();
  for (const degraded of ['map-unreadable', 'server-hp-stale', 'hp-stream-unreadable']) {
    f.h.workerMessage(f.client, 'auto-nexus', {
      type: 'status', generation: 1, sampledAt: 1000, collisionHp: 'on', catalog: ready,
      status: { ...status(), objectId: 1, enabled: true, mapUnreadable: true, degraded },
    });
  }
  const texts = f.h.proxy.injected.map(p => f.h.factory.createFromBytes(p.data, 'server').data.text);
  expect(texts).toEqual([
    'Auto Nexus degraded: map-unreadable; protection may be incomplete.',
    'Auto Nexus degraded: server-hp-stale; protection may be incomplete.',
    'Auto Nexus degraded: hp-stream-unreadable; protection may be incomplete.',
  ]);
});

it('broadcasts failing, rejected and recovered notices with rate limits and no disconnected recipients', () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  f.h.connect('second'); f.h.connect('gone'); f.h.close('gone');
  f.h.connect('logging-in');
  for (const id of ['c1', 'second']) f.h.packet(id, 'CREATESUCCESS', { objectId: 1, charId: 1 });
  const health = (state: 'healthy' | 'failing') => f.h.proxy.emit('moduleStatus', { moduleId: 'auto-nexus', state, since: now });
  const config = (ok: boolean) => f.h.proxy.emit('moduleConfig', ok
    ? { type: 'moduleConfig', moduleId: 'auto-nexus', ok: true }
    : { type: 'moduleConfig', moduleId: 'auto-nexus', ok: false, error: 'invalid' });
  const notices = () => f.h.proxy.injected.map(i => ({ id: i.id, text: f.h.factory.createFromBytes(i.data, 'server').data.text }));
  health('healthy'); config(true);
  expect(notices()).toHaveLength(0);
  health('failing'); health('failing'); config(false); health('healthy');
  expect(notices()).toHaveLength(6); // Clearing failure announces the rejection that remains.
  config(true);
  expect(notices()).toEqual([
    ...['c1', 'second'].map(id => ({ id, text: 'Auto Nexus module failing — protection degraded' })),
    ...['c1', 'second'].map(id => ({ id, text: 'Auto Nexus module failing and settings rejected — protection degraded' })),
    ...['c1', 'second'].map(id => ({ id, text: 'Auto Nexus settings rejected' })),
    ...['c1', 'second'].map(id => ({ id, text: 'Auto Nexus module recovered — settings accepted' })),
  ]);
  health('failing'); config(false); health('healthy'); config(true);
  expect(notices()).toHaveLength(16);
  now += 30000;
  health('failing'); config(false); health('healthy'); config(true);
  expect(notices()).toHaveLength(24);
  f.h.close('c1'); f.h.close('second');
  now += 30000;
  health('failing'); config(false); health('healthy'); config(true);
  expect(notices()).toHaveLength(24);
});

it('announces rejection again after recovery inside 30 seconds and skips clients logging in', () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  const config = (ok: boolean) => f.h.proxy.emit('moduleConfig', ok
    ? { type: 'moduleConfig', moduleId: 'auto-nexus', ok: true }
    : { type: 'moduleConfig', moduleId: 'auto-nexus', ok: false, error: 'invalid' });
  config(false);
  expect(f.h.proxy.injected).toHaveLength(0);
  f.h.packet(f.client, 'CREATESUCCESS', { objectId: 1, charId: 1 });
  config(false); // The skipped notice did not spend the rate limit.
  config(false);
  expect(f.h.proxy.injected).toHaveLength(1);
  config(true); config(false);
  expect(f.h.proxy.injected.map(i => f.h.factory.createFromBytes(i.data, 'server').data.text)).toEqual([
    'Auto Nexus settings rejected', 'Auto Nexus module recovered — settings accepted', 'Auto Nexus settings rejected',
  ]);
  config(false); expect(f.h.proxy.injected).toHaveLength(3);
  now += 29999; config(false); expect(f.h.proxy.injected).toHaveLength(3);
  now += 1; config(false); expect(f.h.proxy.injected).toHaveLength(4);
});


it.each(['rejected', 'failing'] as const)('announces every combined state starting with %s', first => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  f.h.packet(f.client, 'CREATESUCCESS', { objectId: 1, charId: 1 });
  const health = (state: 'healthy' | 'failing') => f.h.proxy.emit('moduleStatus', { moduleId: 'auto-nexus', state, since: now });
  const config = (ok: boolean) => f.h.proxy.emit('moduleConfig', ok
    ? { type: 'moduleConfig', moduleId: 'auto-nexus', ok: true }
    : { type: 'moduleConfig', moduleId: 'auto-nexus', ok: false, error: 'invalid' });
  const texts = () => f.h.proxy.injected.map(i => f.h.factory.createFromBytes(i.data, 'server').data.text);
  const failing = 'Auto Nexus module failing — protection degraded';
  const rejected = 'Auto Nexus settings rejected';
  const both = 'Auto Nexus module failing and settings rejected — protection degraded';
  if (first === 'rejected') { config(false); health('failing'); }
  else { health('failing'); config(false); }
  expect(texts()).toEqual([first === 'rejected' ? rejected : failing, both]);
  health('failing'); config(false);
  expect(texts()).toHaveLength(2);
  now += 30000; config(false);
  expect(texts()).toEqual([first === 'rejected' ? rejected : failing, both, both]);
  // Both ways of partially recovering must announce the remaining problem immediately.
  if (first === 'rejected') config(true);
  else health('healthy');
  expect(texts().at(-1)).toBe(first === 'rejected' ? failing : rejected);
  if (first === 'rejected') health('healthy');
  else config(true);
  expect(texts()).toHaveLength(5);
  expect(texts().at(-1)).toBe('Auto Nexus module recovered — settings accepted');
});

it('delivers a degraded health state that began during login once the client is in game', () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const f = fixture();
  const texts = () => f.h.proxy.injected.map(i => f.h.factory.createFromBytes(i.data, 'server').data.text);
  const inGameStatus = (id: string, generation: number) => f.h.workerMessage(id, 'auto-nexus', {
    type: 'status', generation, sampledAt: now, collisionHp: 'on', catalog: ready,
    status: { ...status(), objectId: 1, enabled: true },
  });
  f.h.proxy.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'failing', since: now });
  expect(texts()).toEqual([]); // Still logging in: nothing sent, limit not spent.
  f.h.packet(f.client, 'CREATESUCCESS', { objectId: 1, charId: 1 });
  inGameStatus(f.client, 1);
  inGameStatus(f.client, 2);
  expect(texts()).toEqual(['Auto Nexus module failing — protection degraded']);
  // A map hop opens a new connection; the pending notice is not repeated within 30 s.
  f.h.connect('hop'); f.h.packet('hop', 'CREATESUCCESS', { objectId: 2, charId: 1 });
  now += 5000; inGameStatus('hop', 1);
  expect(texts()).toHaveLength(1);
  now += 30000; inGameStatus('hop', 2);
  expect(texts()).toEqual(['Auto Nexus module failing — protection degraded', 'Auto Nexus module failing — protection degraded']);
  // Once healthy, status updates deliver nothing further.
  f.h.proxy.emit('moduleStatus', { moduleId: 'auto-nexus', state: 'healthy', since: now });
  const count = texts().length;
  now += 60000; inGameStatus('hop', 3);
  expect(texts()).toHaveLength(count);
});
