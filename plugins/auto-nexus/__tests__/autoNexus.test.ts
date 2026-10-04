// Adapted from realm-engine-client client/src/status/__tests__/AutoNexusPlugin.test.ts @ 88a66b2 (MIT, see NOTICE).
// Adapted from realm-engine-client client/src/plugins/__tests__/autoNexusSettings.test.ts @ 88a66b2 (MIT, see NOTICE).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index.ts';
import { DEFAULTS, SETTING_DEFS, migrate, validate } from '../settings.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';
import { SafetyEngine } from '../../../src/safety/SafetyEngine.ts';
import type { SafetyDecision } from '../../../src/safety/SafetyTypes.ts';

const cleanups: (() => void)[] = [];
let records: LogRecord[];
beforeEach(() => { records = []; log.setConsole(false); cleanups.push(log.addSink(r => records.push(r))); });
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); log.setConsole(true); vi.restoreAllMocks(); });
function fixture(settings?: Record<string, unknown>, enabled?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'realmtool-nexus-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'profiles'));
  if (settings || enabled !== undefined) writeFileSync(join(dir, 'profiles', 'default.json'), JSON.stringify({ schemaVersion: 1, plugins: { 'auto-nexus': { settings, enabled } } }));
  const h = startHost([plugin], { profileDir: dir }); cleanups.push(() => h.host.stop());
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
  it('declares exactly the four canonical controls', () => {
    expect(SETTING_DEFS).toEqual([
      { key: 'ForceAutoNexusHealth', label: 'Nexus Health (0%: confirmed server zero only)', type: 'range', value: 25, min: 0, max: 100, step: 1 },
      { key: 'ShowChatMessageOnNexus', label: 'Show Chat Message on Nexus', advanced: true, type: 'boolean', value: true },
      { key: 'EscapeRetryCount', label: 'Escape Retries', advanced: true, type: 'range', value: 4, min: 0, max: 10, step: 1 },
      { key: 'EscapeRetryIntervalMs', label: 'Escape Retry Interval', advanced: true, type: 'range', value: 400, min: 100, max: 2000, step: 50 },
    ]);
    const f = fixture();
    for (const def of SETTING_DEFS) expect(f.ctx.getSetting(def.key)).toBe(def.value);
    expect(f.h.proxy.configured).toEqual([{ 'auto-nexus': { settings: { enabled: true, preHitPrediction: true, thresholdPct: 25, notification: true, retryCount: 4, retryMs: 400, reactionMs: 400 },
      catalog: null, catalogState: { state: 'fallback', reason: 'not loaded' } } }]);
  });

  it.each([true, false])('publishes one complete saved startup configuration, enabled=%s', enabled => {
    const f = fixture({ ForceAutoNexusHealth: 19, ShowChatMessageOnNexus: false, EscapeRetryCount: 6.9, EscapeRetryIntervalMs: 700,
      PredictionModel: 'v1', BurstGuard: true, ReactionWindowMs: 900, InstantNexus: true, PreHitPrediction: true }, enabled);
    expect(f.h.proxy.configured).toEqual([{ 'auto-nexus': { settings: { enabled, preHitPrediction: true, thresholdPct: 19, notification: false, retryCount: 6, retryMs: 700, reactionMs: 400 },
      catalog: null, catalogState: { state: 'fallback', reason: 'not loaded' } } }]);
    expect(f.snapshot().settings).toEqual({ ForceAutoNexusHealth: 19, ShowChatMessageOnNexus: false, EscapeRetryCount: 6, EscapeRetryIntervalMs: 700 });
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
    ...['PredictionModel', 'BurstGuard', 'ReactionWindowMs', 'InstantNexus', 'PreHitPrediction'].map(key => [key, true] as [string, unknown]),
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

  it('sends manual escape to only that client with no reply; reset only explains 3a', () => {
    const f = fixture(); f.command('/nexus');
    expect(f.h.proxy.commands).toEqual([{ moduleId: 'auto-nexus', id: f.client, message: { type: 'escape' } }]);
    expect(f.h.proxy.injected).toEqual([]);
    const before = f.h.proxy.configured.length; f.command('/reset');
    expect(f.reply().text).toBe('Collision HP is not available yet: Auto Nexus uses the server HP threshold only, so there is no estimated damage to reset.');
    expect(f.h.proxy.configured).toHaveLength(before);
  });

  it('uses fresh worker status scoped to client and generation, with monotonic expiry', () => {
    let now = 1000; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture(); const other = f.h.connect('other');
    const send = (generation: number, sampledAt = now) => f.h.workerMessage(f.client, 'auto-nexus', { type: 'status', status: { ...status(), attemptOrigin: 'manual', attemptPhase: 'written' }, sampledAt, generation });
    send(2); f.command();
    expect(f.reply().text).toContain('worker disabled; automatic not eligible; protection disabled; prediction off — server HP threshold only; attempt MANUAL NEXUS written');
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
    const send = () => f.h.workerMessage(f.client, 'auto-nexus', { type: 'decision', decision, status: status(), writeDelayMs: 0.25 });
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
