import { describe, expect, it } from 'vitest';
import { computeProtection, type ProtectionInputs } from '../protection.ts';
const ready = (): ProtectionInputs => ({ proxy: 'running', gameRunning: true, routing: 'routed', helper: 'installed',
  data: { state: 'idle', gameBuild: 'A', catalogBuild: 'A' }, modules: {},
  plugins: [ { id: 'auto-nexus', enabled: true, failed: null, data: { status: { protectionState: 'monitoring', collisionHp: 'on' } } },
    { id: 'auto-drink', enabled: true, failed: null, data: {} } ] });
describe('computeProtection', () => {
  it('reports protected only with verified readiness', () => expect(computeProtection(ready())).toEqual({ state: 'protected', reasons: [] }));
  it.each(['stopped', 'starting', 'stopping'])('%s is idle without a game and unprotected with one', proxy => {
    expect(computeProtection({ ...ready(), proxy, gameRunning: false }).state).toBe('idle');
    expect(computeProtection({ ...ready(), proxy }).state).toBe('unprotected');
  });
  it.each([
    ['proxy-failed', { proxy: 'failed' }], ['not-routed', { routing: 'not-routed' }],
    ['helper-unavailable', { helper: 'absent' }], ['helper-unavailable', { helper: 'outdated' }],
    ['helper-unavailable', { helper: 'foreign' }], ['helper-unavailable', { helper: 'unknown' }],
    ['auto-nexus-failing', { modules: { 'auto-nexus': { failing: true } } }],
    ['auto-nexus-config-rejected', { modules: { 'auto-nexus': { rejected: true } } }],
  ] as const)('%s prevents protection', (code, changes) => {
    const result = computeProtection({ ...ready(), ...changes });
    expect(result.state).toBe('unprotected'); expect(result.reasons.map(r => r.code)).toContain(code);
  });
  it.each([
    ['routing-unknown', { routing: 'unknown' }], ['helper-unavailable', { helper: 'absent', gameRunning: false }],
    ['auto-drink-failing', { modules: { 'auto-drink': { failing: true } } }],
    ['auto-drink-config-rejected', { modules: { 'auto-drink': { rejected: true } } }],
    ['data-unverified', { data: { state: 'failed', gameBuild: 'A', catalogBuild: 'A' } }],
    ['data-unverified', { data: { state: 'idle', gameBuild: 'B', catalogBuild: 'A' } }],
    ['data-unverified', { dataInvalidated: true }],
  ] as const)('%s degrades protection', (code, changes) => {
    const result = computeProtection({ ...ready(), ...changes });
    expect(result.state).toBe('degraded'); expect(result.reasons.map(r => r.code)).toContain(code);
  });
  it('reports disabled and unavailable Auto Nexus', () => {
    const input = ready(); input.plugins[0].enabled = false;
    expect(computeProtection(input).reasons[0].message).toBe('Auto Nexus is off');
    input.plugins[0].failed = 'failed'; expect(computeProtection(input).state).toBe('unprotected');
    input.plugins = []; expect(computeProtection(input).state).toBe('unprotected');
  });
  it.each(['server-hp-stale', 'hp-stream-unreadable', 'map-unreadable'])('explains %s and collision fallback', degraded => {
    const input = ready(); input.plugins[0].data.status = { protectionState: 'monitoring-degraded', degraded, collisionHp: 'fallback' };
    const result = computeProtection(input); expect(result.state).toBe('degraded');
    expect(result.reasons.map(r => r.code)).toEqual(['nexus-monitoring-degraded', 'collision-hp-fallback']);
    expect(result.reasons[0].message).toContain(degraded);
  });
  it('degrades for missing status or unavailable drink, but permits optional drink to be off', () => {
    const input = ready(); input.plugins[1].enabled = false;
    expect(computeProtection(input).state).toBe('protected');
    input.plugins[1].enabled = true;
    input.plugins[1].data.status = { reason: 'consumables catalog unavailable: missing' };
    expect(computeProtection(input).state).toBe('degraded');
    input.plugins[0].data = {}; expect(computeProtection(input).reasons.map(r => r.code)).toContain('nexus-status-unknown');
  });
  it.each(['waiting', 'degraded', 'transition', 'escaping', 'cooldown', 'disabled', 'dead'])('does not call %s protected', protectionState => {
    const input = ready(); input.plugins[0].data.status = { protectionState };
    expect(computeProtection(input).state).not.toBe('protected');
  });
  it('waits idly for a game without masking actual failures', () => {
    const input = { ...ready(), gameRunning: false, routing: 'unknown' };
    expect(computeProtection(input)).toEqual({ state: 'idle', reasons: [{ code: 'waiting-for-game', source: 'game', severity: 'info', message: 'Waiting for the game' }] });
    input.data.state = 'failed'; expect(computeProtection(input).state).toBe('degraded');
  });
  it.each([false, true])('only enabled Auto Drink problems degrade (enabled=%s)', enabled => {
    const input = ready(); input.plugins[1].enabled = enabled; input.plugins[1].failed = 'broken';
    input.modules['auto-drink'] = { failing: true, rejected: true };
    expect(computeProtection(input).state).toBe(enabled ? 'degraded' : 'protected');
  });
  it('uses the worst client status and deduplicates shared reasons', () => {
    const input = ready(); input.nexusStatuses = [{ stale: true }, { stale: false, status: { protectionState: 'monitoring' } }, { stale: true }];
    expect(computeProtection(input)).toMatchObject({ state: 'degraded', reasons: [{ code: 'nexus-status-stale' }] });
  });
  it('allows pending connection grace without masking a reported degraded status', () => {
    const input = ready(); input.nexusStatuses = [{ pending: true, stale: false }];
    expect(computeProtection(input).state).toBe('protected');
    input.nexusStatuses = [{ pending: true, stale: false, status: { protectionState: 'monitoring-degraded' } }];
    expect(computeProtection(input).state).toBe('degraded');
    input.nexusStatuses = [{ pending: false, stale: false }];
    expect(computeProtection(input).state).toBe('degraded');
  });
  it('orders errors before warnings deterministically without changing its input', () => {
    const input = ready(); input.helper = 'outdated'; input.gameRunning = false;
    input.modules = { 'auto-nexus': { rejected: true }, 'auto-drink': { failing: true } };
    const original = structuredClone(input), result = computeProtection(input);
    expect(result.state).toBe('unprotected'); expect(result.reasons[0].code).toBe('auto-nexus-config-rejected');
    expect(computeProtection(input)).toEqual(result); expect(input).toEqual(original);
  });
});

it('degrades and recovers with sustained worker lag, never main-thread lag', () => {
  const input = ready();
  expect(computeProtection({ ...input, mainLag: { degraded: true } }).state).toBe('protected');
  const result = computeProtection({ ...input, workerLag: { degraded: true } });
  expect(result.state).toBe('degraded');
  expect(result.reasons[0].message).toBe('network worker lagging');
  expect(computeProtection({ ...input, workerLag: { degraded: false } }).state).toBe('protected');
});
