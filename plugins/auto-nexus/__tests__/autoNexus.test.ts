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
      evidence: { trigger: 'reason', preHitPrediction: false, reactionMs: 400, pendingCount: 0, pendingDamage: 0, impacts: [] } };
    const send = () => f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', catalog: ready, collisionHp: 'off', decision, status: status(), writeDelayMs: 0.25 });
    send(); const label = origin === 'manual' ? 'MANUAL NEXUS' : 'AUTO NEXUS';
    expect(f.reply().name).toBe(label);
    expect(f.reply().text).toBe('Server HP 80/100; threshold 25%; reason; Collision HP off; local write attempt 0.250ms (not server acceptance)');
    f.ctx.updateSetting('ShowChatMessageOnNexus', false); const count = f.h.proxy.injected.length; send();
    expect(f.h.proxy.injected).toHaveLength(count);
    expect(records.filter(r => r.message.startsWith(`${label} —`))).toHaveLength(2);
  });

  it('cleans up subscriptions and disarms the worker on stop', () => {
    const f = fixture(); f.h.host.stop();
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { enabled: false } } });
    expect(f.h.proxy.listenerCount('module')).toBe(0);
  });
});

function sendStatus(f: ReturnType<typeof fixture>, mode: AutoNexusEvent['collisionHp'] = 'fallback', client = f.client, reason = 'missing', objectId = 1) {
  f.h.workerMessage(client, 'auto-nexus', { type: 'status', generation: 1, sampledAt: performance.now(),
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
    expect(f.reply().text).toBe('Collision HP FALLBACK: server HP only (missing). Run npm run gen:catalogs and restart RealmTool.');
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
    const reason = 'catalog is for game build A but the installed game is B; run npm run gen:catalogs';
    expect(f.h.proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { catalog: null, catalogState: { state: 'fallback', reason } } });
    expect(f.h.proxy.injected).toHaveLength(0);
    sendStatus(f, 'fallback', other, reason); sendStatus(f, 'fallback', other, reason);
    expect(f.h.proxy.injected).toHaveLength(1);
    expect(f.reply().text).toBe(`Collision HP FALLBACK: server HP only (${reason}). Run npm run gen:catalogs and restart RealmTool.`);
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
