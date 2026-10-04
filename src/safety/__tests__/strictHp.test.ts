// Adapted from realm-engine-client client/src/safety/__tests__/strictHp.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it, vi } from 'vitest';
import { createFactory } from '../../protocol/schema.ts';
import { SafetyEngine } from '../SafetyEngine.ts';
import { DEFAULT_SAFETY_SETTINGS, safetySettings, type SafetySettingsInput } from '../SafetyTypes.ts';

const factory = createFactory();
const S = { MaxHP: 0, HP: 1, Defense: 21, HpBoost: 26 };

function fixture(settings: SafetySettingsInput = {}, hp: number | null = 707, max: number | null = 707) {
  let now = 1000, tick = 0;
  const escape = vi.fn();
  const engine = new SafetyEngine(escape);
  engine.configure({ enabled: true, preHitPrediction: false, ...settings }, now);
  const emit = (name: string, data: any = {}, client = false, defined = true) => {
    const packet = factory.createByName(name);
    packet.direction = client ? 'client' : 'server';
    packet.isDefined = defined; packet.data = data; engine.observe(packet, now);
  };
  const health = (value?: number, extra: any[] = []) => emit('NEWTICK', { tickId: ++tick,
    statuses: [{ objectId: 1, data: [...extra, ...(value === undefined ? [] : [{ id: S.HP, value }])] }] });
  emit('MAPINFO', { name: 'Realm' }); emit('CREATESUCCESS', { objectId: 1 });
  emit('UPDATE', { tiles: [{ x: 1, y: 1, type: 7 }], newObjs: [
    { objectType: 49897, status: { objectId: 184312, data: [] } },
    { objectType: 768, status: { objectId: 1, position: { x: 1, y: 1 }, data: [
      ...(max === null ? [] : [{ id: S.MaxHP, value: max }, { id: S.Defense, value: 0 }]), ...(hp === null ? [] : [{ id: S.HP, value: hp }]),
    ] } },
  ] });
  engine.setCatalog({ projectiles: [[49897, 0, { lifetimeMs: 10000, multiHit: false, armorPiercing: false,
    maxHealthDamage: 0, conditionEffects: [{ effect: 'Curse', durationSec: 2 }] }]], tiles: [[7, 10]] });
  const shot = (bullet = 0, damage = 90) => emit('ENEMYSHOOT', { ownerId: 184312, bulletId: bullet, bulletType: 0, damage, numShots: 1 });
  const hit = (bullet = 0) => emit('PLAYERHIT', { objectId: 184312, bulletId: bullet }, true);
  const damage = (bullet = 0, amount = 90) => emit('DAMAGE', { targetId: 1, objectId: 184312, bulletId: bullet, damageAmount: amount });
  return { engine, escape, emit, health, shot, hit, damage,
    configure: (value: SafetySettingsInput) => engine.configure(value, now),
    time: () => now, advance: (ms: number) => { now += ms; engine.advance(now); } };
}

function expectStrict(f: ReturnType<typeof fixture>, hp = 707) {
  expect(f.engine.status().confirmedHp).toBe(hp);
  expect(f.engine.decisionEvidence(f.time(), 'test')).toMatchObject({ pendingCount: 0, pendingDamage: 0, impacts: [] });
  expect(f.escape).not.toHaveBeenCalled();
}

it.each([false])('logged Curse-applying projectile at 707/707 HP with prediction=%s', preHitPrediction => {
  const f = fixture({ preHitPrediction });
  f.shot(0, 90); f.hit(0);
  expectStrict(f);
  f.health(177); expectStrict(f, 177);
  f.health(176);
  expect(f.escape).toHaveBeenCalledTimes(1);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 176, lowerHp: 176,
    maxHp: 707, thresholdHp: 176.75, evidence: { trigger: 'server health', preHitPrediction: false,
      pendingCount: 0, pendingDamage: 0, impacts: [] } });
});

it('keeps explicitly OFF monitoring ready above the threshold and gates direct automatic requests only', () => {
  expect(DEFAULT_SAFETY_SETTINGS.preHitPrediction).toBe(true);
  const f = fixture();
  expect(f.engine.status()).toMatchObject({ automaticEligible: true, protectionState: 'monitoring' });
  for (const reason of ['unbounded impact', 'damage ledger capacity', 'native feed stalled', 'ordinary backlog', 'manual nexus']) {
    f.engine.uncertain(f.time(), reason); f.engine.request(f.time(), reason);
  }
  expectStrict(f);
  f.engine.request(f.time(), 'server health', true);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ origin: 'manual', reason: 'server health', confirmedHp: 707 });
});

it.each(['known', 'unknown', 'ambiguous', 'multiHit', 'Curse', 'max-health'] as const)(
  'never charges repeated %s hits, ground, AoE or DAMAGE before/after HP updates in strict mode', kind => {
    const f = fixture();
    // Keep the source's 513-report stress loop; catalog distinctions belong to 3b.
    for (let i = 0; i <= 512; ++i) {
      f.shot(i, 900); if (kind === 'ambiguous') f.shot(i, 900);
      f.hit(i); f.hit(i); f.hit(65000);
      f.damage(i, 900); f.health(700); f.damage(i, 900);
      f.emit('GROUNDDAMAGE', { position: { x: 1, y: 1 } }, true);
      f.emit('GROUNDDAMAGE', { position: { x: 20, y: 20 } }, true);
      f.emit('AOE', { position: { x: 1, y: 1 }, radius: 2, damage: 900 });
      f.emit('AOE', { position: { x: NaN, y: 1 }, radius: -1, damage: NaN });
      f.emit('AOEACK', { position: { x: 1, y: 1 } }, true);
      expectStrict(f, 700);
    }
    f.advance(10000); expectStrict(f, 700);
    f.health(176);
    expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', lowerHp: 176,
      evidence: { pendingCount: 0, pendingDamage: 0 } });
  });

it('ignores native crossings, missing metadata, unreadable packets, tracker overflow and stalled health above threshold', () => {
  const f = fixture(); f.shot(0, 900);
  for (const name of ['UPDATE', 'NEWTICK', 'DAMAGE']) f.emit(name, {}, false, false);
  f.emit('GOTO', { objectId: 1, position: { x: 10, y: 10 } });
  f.advance(20000); expectStrict(f);
  expect(f.engine.status()).toMatchObject({ healthAgeMs: 20000, streamAgeMs: 20000 });
});

it('ignores saved Burst Guard above threshold and carries no strict-mode burst history into prediction', () => {
  const f = fixture({ burstGuard: true, thresholdPct: 10 }, 1000, 1000);
  f.advance(200); f.health(700); f.advance(1000); f.health(350);
  expectStrict(f, 350);
  f.configure({ reactionMs: 600, notification: false });
  f.health(350); expect(f.escape).not.toHaveBeenCalled();
  f.health(100);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', thresholdHp: 100, lowerHp: 100 });
});

it('preserves the explicit HP anchor and its age through HP-less and invalid-stat ticks', () => {
  const f = fixture();
  const anchor = f.engine.status().confirmedHp;
  for (const value of [undefined, null, -1, NaN, Infinity, '0']) {
    f.advance(100);
    f.health(undefined, [{ id: S.HP, value }, { id: S.MaxHP, value }]);
    expectStrict(f);
    expect(f.engine.status().maxHp).toBe(707);
  }
  f.advance(100); f.health();
  expect(f.engine.status().confirmedHp).toBe(anchor);
  expect(f.engine.status()).toMatchObject({ healthAgeMs: 700, streamAgeMs: 0 });
  f.health(177); expectStrict(f, 177);
  f.advance(100); f.health(undefined, [{ id: S.MaxHP, value: 708 }, { id: S.HpBoost, value: 120 }]);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ confirmedHp: 177, maxHp: 708, thresholdHp: 177,
    reason: 'server HP threshold', evidence: { trigger: 'server health' } });
  expect(f.engine.status().healthAgeMs).toBe(100);
});

it.each([0, 25])('unknown HP or maximum cannot trigger automatically at threshold %s', thresholdPct => {
  for (const [hp, max] of [[null, 707], [0, null], [null, null]] as const) {
    const f = fixture({ thresholdPct }, hp, max);
    f.health(undefined, [{ id: S.HP, value: NaN }, { id: S.MaxHP, value: 0 }]);
    f.hit(); f.damage(0, 99999); f.engine.uncertain(f.time(), 'health unavailable during danger');
    f.engine.request(f.time(), 'direct automatic request'); f.advance(20000);
    expect(f.engine.status().confirmedHp).toBe(hp);
    expect(f.escape).not.toHaveBeenCalled();
    f.health(0, [{ id: S.MaxHP, value: 707 }]);
    expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 0, lowerHp: 0 });
  }
});

it('zero threshold requires explicit server HP zero, not invalid stats, hits or estimates', () => {
  const f = fixture({ thresholdPct: 0 }, 1);
  f.shot(0, 99999); f.hit(); f.damage(0, 99999); f.engine.uncertain(f.time(), 'unknown hit');
  f.health(undefined, [{ id: S.HP, value: -1 }]); f.advance(10000);
  expectStrict(f, 1);
  f.health(0);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 0, lowerHp: 0, thresholdHp: 0 });
});

it('reevaluates the retained HP on a threshold setting change without creating debt', () => {
  const f = fixture(); f.health(177);
  const anchor = f.engine.status().confirmedHp;
  f.configure({ thresholdPct: 26 });
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 177, lowerHp: 177,
    evidence: { trigger: 'settings changed', pendingCount: 0 } });
  expect(f.engine.status().confirmedHp).toBe(anchor);
});


it('enable/disable and ordinary settings changes preserve active-mode HP facts without artificial healing', () => {
  for (const preHitPrediction of [false]) {
    const f = fixture({ preHitPrediction }); f.shot(); f.hit();
    const anchor = f.engine.status().confirmedHp;
    f.advance(100); f.configure({ enabled: false }); f.configure({ notification: false, reactionMs: 600 });
    f.configure({ enabled: true });
    expect(f.engine.status()).toMatchObject({ confirmedHp: 707, healthAgeMs: 100 });
    expect(f.engine.status().confirmedHp).toBe(anchor); expect(f.escape).not.toHaveBeenCalled();
  }
});

it('defaults Collision HP ON, respects explicit OFF, and ignores retired selectors', () => {
  expect(safetySettings({}).preHitPrediction).toBe(true);
  expect(safetySettings({ preHitPrediction: false }).preHitPrediction).toBe(false);
  expect(safetySettings({ preHitPrediction: true, burstGuard: true, instantNexus: true, predictionModel: 'v2-shadow', forecastTiming: 'old' }))
    .toEqual(DEFAULT_SAFETY_SETTINGS);
});

it('filters owner stats and triggers immediately on a full owner UPDATE', () => {
  const f = fixture({}, null, null);
  const status = (objectId: number) => ({ objectId, data: [{ id: 0, value: 707 }, { id: 1, value: 176 }] });
  f.emit('UPDATE', { newObjs: [{ status: status(2) }] });
  f.emit('NEWTICK', { tickId: 1, statuses: [status(2)] });
  expect(f.engine.status()).toMatchObject({ confirmedHp: null, maxHp: 0 });
  expect(f.engine.player).toMatchObject({ ownerObjectId: 1, hp: null, maxHp: null });
  expect(f.escape).not.toHaveBeenCalled();
  f.emit('UPDATE', { newObjs: [{ status: status(1) }] });
  expect(f.engine.player).toMatchObject({ hp: 176, maxHp: 707 });
  expect(f.escape.mock.calls[0][0]).toMatchObject({ confirmedHp: 176, thresholdHp: 176.75 });
});

it.each([1, 0, -1, 1.5, NaN, Infinity])('rejects stale or invalid tick ID %s without refreshing HP or liveness', tickId => {
  const f = fixture(); f.health(700); f.advance(100);
  f.emit('NEWTICK', { tickId, statuses: [{ objectId: 1, data: [{ id: 1, value: 0 }] }] });
  expectStrict(f, 700);
  expect(f.engine.status()).toMatchObject({ healthAgeMs: 100, streamAgeMs: 100 });
  f.health(0); expect(f.escape).toHaveBeenCalledTimes(1);
});

it('owner kill flag records zero and death without requesting an automatic escape', () => {
  const f = fixture({ thresholdPct: 0 });
  f.emit('DAMAGE', { targetId: 2, kill: true }); expectStrict(f);
  f.emit('DAMAGE', { targetId: 1, kill: true });
  expect(f.engine.status()).toMatchObject({ phase: 'dead', confirmedHp: 0, automaticEligible: false });
  f.engine.request(f.time(), 'manual nexus', true); f.advance(5000);
  expect(f.escape).not.toHaveBeenCalled();
});

it('Curse-applying projectile ON charges its own hit before the condition changes later hits', () => {
  const f = fixture({ preHitPrediction: true }); f.shot(0, 90); f.hit();
  expect(f.engine.status().lowerHp).toBe(617); expect(f.escape).not.toHaveBeenCalled();
  f.shot(1, 90); f.hit(1); expect(f.engine.status().lowerHp).toBe(505);
});
it('ON unknown HP with no reports never triggers, but real reported loss does', () => {
  const f = fixture({ preHitPrediction: true }, null); f.advance(10000);
  expect(f.escape).not.toHaveBeenCalled(); f.hit();
  expect(f.escape.mock.calls[0][0].reason).toBe('health unavailable during observed danger');
});
it('ON zero threshold ignores predicted zero and waits for explicit server zero', () => {
  const f = fixture({ preHitPrediction: true, thresholdPct: 0 }, 1); f.shot(0, 99999); f.hit();
  f.advance(10000); expect(f.escape).not.toHaveBeenCalled(); f.health(0);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 0 });
});
it('ON threshold change reevaluates retained collision HP without refreshing its anchor', () => {
  const f = fixture({ preHitPrediction: true }); f.shot(0, 90); f.hit(); f.advance(100);
  f.configure({ thresholdPct: 90 });
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 617, evidence: { trigger: 'settings changed', pendingDamage: 90 } });
  expect(f.engine.status().healthAgeMs).toBe(100);
});
it('OFF/ON retires reports, measurements and areas while preserving server HP revision and age', () => {
  const f = fixture({ preHitPrediction: true }, 1000, 1000);
  f.shot(1, 10); f.hit(1); f.damage(1, 10); f.health(990);
  f.shot(2, 10); f.damage(2, 10);
  f.emit('AOE', { position: { x: 1, y: 1 }, radius: 1, damage: 900 });
  f.emit('GROUNDDAMAGE', { position: { x: 1, y: 1 } }, true);
  f.advance(100); const revision = f.engine.predictor.revision;
  f.configure({ preHitPrediction: false });
  expect(f.engine.status()).toMatchObject({ confirmedHp: 990, lowerHp: 990, healthAgeMs: 100, prediction: null });
  f.configure({ preHitPrediction: true });
  expect(f.engine.predictor.revision).toBe(revision);
  expect(f.engine.status().prediction?.pendingCount).toBe(0);
  f.emit('AOE', { position: { x: 1, y: 1 }, radius: 1, damage: 20 });
  f.emit('AOEACK', { position: { x: 1, y: 1 } }, true);
  f.hit(1); expect(f.engine.status().lowerHp).toBe(960);
});
it('enable/disable ON preserves reported debt and server anchor age', () => {
  const f = fixture({ preHitPrediction: true }); f.shot(); f.hit(); f.advance(100);
  f.configure({ enabled: false }); f.configure({ notification: false, reactionMs: 600 }); f.configure({ enabled: true });
  expect(f.engine.status()).toMatchObject({ confirmedHp: 707, lowerHp: 617, healthAgeMs: 100, prediction: { pendingCount: 1 } });
});
it('stalled ENEMYSHOOT and AoE estimate one mitigated hit, with unknowns assumed at 200', () => {
  const f = fixture({ preHitPrediction: true }); f.health(707, [{ id: S.Defense, value: 77 }]);
  const assess = (name: string, data: any, defined = true) => {
    const p = factory.createByName(name); p.direction = 'server'; p.isDefined = defined; p.data = data;
    f.engine.observe(p, f.time()); return f.engine.stalledDanger(p, f.time());
  };
  expect(assess('ENEMYSHOOT', { ownerId: 184312, bulletId: 1, bulletType: 0, damage: 170, numShots: 4 })).toBe(93);
  expect(assess('ENEMYSHOOT', { ownerId: 999, bulletId: 1, bulletType: 0, damage: 120 })).toBe(200);
  expect(assess('AOE', { position: { x: 1, y: 1 }, radius: 1, damage: 100, armorPierce: false })).toBe(23);
  expect(assess('AOE', { position: { x: 1, y: 1 }, radius: 1, damage: 100, armorPierce: true })).toBe(100);
  expect(assess('AOE', {}, false)).toBe(200);
});
it('stalled delivery requires pending loss and reaches the inclusive threshold only', () => {
  const f = fixture({ preHitPrediction: true }); f.shot(); f.hit();
  f.engine.deliveryStalled(f.time(), 440); expect(f.escape).not.toHaveBeenCalled();
  f.engine.deliveryStalled(f.time(), 440.25);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 617, reason: 'danger delivery stalled behind plugin processing' });
  for (const preHitPrediction of [true, false]) {
    const idle = fixture({ preHitPrediction }); idle.engine.deliveryStalled(idle.time(), 10000);
    expect(idle.escape).not.toHaveBeenCalled();
  }
});
