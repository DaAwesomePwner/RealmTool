// Adapted from realm-engine-client client/src/safety/__tests__/hpPrediction.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it } from 'vitest';
import { HealthPredictor } from '../HealthPredictor.ts';
import { assessPredictedLoss, applyProjectileConditions, withProjectileConditions } from '../DamageModel.ts';
import type { SafetyProjectileDef } from '../SafetyCatalog.ts';
const loss = (amount: number) => ({ amount, kind: 'mitigated-estimate' as const, reason: null });
const definition: SafetyProjectileDef = { lifetimeMs: 10000, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] };
const basis = { defense: 32, effects: 0, effects2: 0, conditionsKnown: true, revision: 1, ageMs: 0 };
function ledger() {
  const p = new HealthPredictor(); p.snapshot(707, 0);
  for (const at of [0, 200, 400]) p.timing(at, 80);
  return p;
}
it('healing on the next update does not acknowledge a recent written hit', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  p.timing(600, 80); p.snapshot(707, 600);
  expect(p.lowerHp).toBe(657); expect(p.state(600).retiredCount).toBe(0);
});
it('requires HP reconciliation and sufficient write age; time and timing() alone never retire', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1); p.delivered(1, 450, 'written');
  for (let t = 600; t <= 1400; t += 200) p.timing(t, 80);
  p.expire(1400); expect(p.lowerHp).toBe(657);
  p.snapshot(707, 1400); expect(p.lowerHp).toBe(707);
  p.impact('a', loss(50), 1401, 'player-hit'); expect(p.lowerHp).toBe(707);
});
it('ages held reports from the actual write and keeps unwritten losses separate', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1);
  for (let t = 600; t <= 1400; t += 200) p.timing(t, 80);
  p.snapshot(707, 1400); expect(p.lowerHp).toBe(657);
  p.delivered(1, 1400, 'written'); p.snapshot(707, 1401); expect(p.lowerHp).toBe(657);
});
it('stalls/backpressure and an unsupported reconciliation window stop retirement', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  p.timing(2000, 80); p.snapshot(707, 2000); expect(p.lowerHp).toBe(657);
  p.timing(2200, 80); p.timing(2400, 80); p.deliveryBacklog(true); p.snapshot(707, 2400); expect(p.lowerHp).toBe(657);
  p.deliveryBacklog(false); p.timing(2600, 3000); p.snapshot(707, 2600); expect(p.lowerHp).toBe(657);
  expect(p.state(2600)).toMatchObject({ graceMs: 3500, retirementEnabled: false });
});

it('derives grace from RTT and tick timing', () => {
  const p = ledger();
  expect(p.graceMs).toBe(580);
});

it('credits older written damage once while retaining newer, held and blocked reports', () => {
  const p = ledger();
  for (let id = 1; id <= 4; ++id) p.impact(String(id), loss(33), 410 + id, 'player-hit', 12000, id);
  p.delivered(1, 415, 'written'); p.delivered(2, 595, 'written'); p.delivered(4, 420, 'blocked');
  p.timing(600, 80); p.snapshot(674, 600);
  expect(p.state(600)).toMatchObject({ pendingDamage: 99, creditedDamage: 33, hp: 575 });
  // Same explicit HP cannot supply another credit; healing supplies none either.
  p.snapshot(674, 610); p.snapshot(707, 620);
  expect(p.state(620)).toMatchObject({ pendingDamage: 99, creditedDamage: 33 });
});

it('partial net loss and pet/potion/beacon healing do not forgive the unobserved remainder', () => {
  const p = ledger(); p.impact('a', loss(33), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  p.timing(600, 80); p.snapshot(688, 600); // 33 loss with 14 recovery: only net 19 supplies credit.
  expect(p.state(600)).toMatchObject({ pendingDamage: 14, hp: 674, creditedDamage: 19 });
  p.snapshot(707, 610); expect(p.lowerHp).toBe(693);
});

it('charges distinct unknown reports at 200 and deduplicates repeated observation of one id', () => {
  const p = ledger();
  for (let id = 1; id <= 3; id++) {
    p.impact(`unknown:${id}`, assessPredictedLoss(undefined, undefined, basis), 410, 'player-hit', 12000, id);
    p.impact(`unknown:${id}`, loss(1), 411, 'player-hit', 12000, id);
    expect(p.lowerHp).toBe(707 - 200 * id);
  }
});
it('keeps older unresolved debt when a new occurrence arrives after 12 seconds', () => {
  const p = ledger();
  p.impact('epoch:unknown:1', loss(200), 410, 'player-hit');
  p.expire(13000);
  p.impact('epoch:unknown:2', loss(200), 13000, 'player-hit');
  expect(p.pendingDamage).toBe(400);
});
it.each([false, true])('measured damage including zero is charged once, measurement first=%s', first => {
  for (const amount of [48, 0]) {
    const p = ledger();
    const estimate = () => p.impact('a', loss(200), 410, 'player-hit', 12000, 1);
    const measure = () => p.impact('a', { amount, kind: 'measured', reason: null }, 410, 'server-damage', 12000, null, true);
    if (first) { measure(); estimate(); } else { estimate(); measure(); }
    expect(p.state(410)).toMatchObject({ pendingCount: 1, pendingDamage: amount });
    expect(p.assessment('a')?.kind).toBe('measured');
  }
});
it.each([false, true])('measurement of one unresolved occurrence preserves other occurrences, first=%s', first => {
  const p = ledger();
  const measure = () => p.impact('unknown:1', { amount: 30, kind: 'measured', reason: null }, 410, 'server-damage', 12000, null, true);
  if (first) measure();
  for (const id of [1, 2, 3]) p.impact(`unknown:${id}`, loss(200), 410, 'player-hit');
  if (!first) measure();
  expect(p.pendingDamage).toBe(430);
});
it('counts separate multi-hit occurrence ids independently', () => {
  const p = ledger();
  for (let n = 1; n <= 3; n++) p.impact(`multi:${n}`, loss(48), 410, 'player-hit');
  expect(p.pendingDamage).toBe(144);
});
it('crosses the synthetic 25 percent threshold on the seventh reported hit', () => {
  const p = ledger(); p.snapshot(618, 400);
  for (let n = 1; n <= 7; n++) {
    p.impact(String(n), loss(60), 410, 'player-hit');
    expect(p.lowerHp! <= 857 * .25).toBe(n === 7);
  }
});
it.each([{ hp: 260, residual: 3, hits: 1, expected: 164 }, { hp: 355, residual: 0, hits: 2, expected: 169 }])(
  'preserves the reviewed $hp to $expected collision HP accounting', ({ hp, residual, hits, expected }) => {
    const p = ledger(); p.snapshot(hp, 400); p.impact('residual', loss(residual), 410, 'player-hit');
    for (let n = 0; n < hits; n++) p.impact(String(n), loss(93), 410, 'player-hit');
    expect(p.lowerHp).toBe(expected);
  });
it('preserves large unsupported damage as an assumption', () => {
  expect(assessPredictedLoss(400, { ...definition, maxHealthDamage: .1 }, basis))
    .toMatchObject({ amount: 400, kind: 'assumed', reason: 'max-health-damage' });
});
it('fully credited entries retain zero remaining damage when timing stalls', () => {
  const p = ledger(); p.impact('a', loss(33), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  p.timing(600, 80); p.snapshot(674, 600); p.expire(2200);
  expect(p.state(2200)).toMatchObject({ pendingCount: 1, pendingDamage: 0, hp: 674, retirementEnabled: false });
});
it('new DEF affects new hits without revising a previous estimate', () => {
  const p = ledger(); p.impact('a', assessPredictedLoss(65, definition, basis), 410, 'player-hit');
  const updated = assessPredictedLoss(65, definition, { ...basis, defense: 40 });
  p.impact('a', updated, 420, 'player-hit'); p.impact('b', updated, 420, 'player-hit');
  expect(p.pendingDamage).toBe(58);
});
it('crosses the inclusive threshold on the seventeenth ordinary mitigated hit', () => {
  const p = ledger();
  for (let n = 1; n <= 17; n++) {
    p.impact(String(n), assessPredictedLoss(65, definition, basis), 410, 'player-hit');
    expect(p.lowerHp! <= 707 * .25).toBe(n === 17);
  }
  p.clearDebt(); p.snapshot(209.75, 420); p.impact('boundary', loss(33), 421, 'player-hit');
  expect(p.lowerHp).toBe(707 * .25);
});
it('applies harmful conditions only to subsequent hits and expires them at their deadline', () => {
  const active = new Map<string, number>();
  const def = { ...definition, conditionEffects: [
    { effect: 'Armor_Broken', durationSec: 1 }, { effect: 'Exposed', durationSec: 1 },
    { effect: 'Cursed', durationSec: 1 }, { effect: 'Armored', durationSec: 10 },
    { effect: 'Curse', durationSec: -1 }, { effect: 'Curse', durationSec: Infinity }] };
  expect(assessPredictedLoss(65, def, withProjectileConditions(basis, active, 0)).amount).toBe(33);
  applyProjectileConditions(active, def, 0);
  expect(assessPredictedLoss(65, def, withProjectileConditions(basis, active, 999)).amount).toBe(106);
  expect(active.size).toBe(3);
  expect(assessPredictedLoss(65, def, withProjectileConditions(basis, active, 1000)).amount).toBe(33);
});
it('capacity faults retain all existing impacts and remain sticky until clearDebt', () => {
  const p = ledger();
  for (let n = 0; n < HealthPredictor.CAPACITY; n++) expect(p.impact(String(n), loss(1), 410, 'player-hit')).toBe(true);
  expect(p.impact('overflow', loss(100), 411, 'player-hit')).toBe(false);
  expect(p.pendingDamage).toBe(512); expect(p.fault).toBe('HP prediction impact capacity');
  p.expire(999999); expect(p.pendingCount).toBe(512);
  p.clearDebt(); expect(p.fault).toBeNull();
});
it('delivery association capacity faults without replacing an existing impact', () => {
  const p = ledger();
  for (let n = 0; n < HealthPredictor.CAPACITY; n++) p.impact('a', loss(33), 410, 'player-hit', 12000, n);
  expect(p.impact('a', loss(33), 410, 'player-hit', 12000, 512)).toBe(false);
  expect(p.fault).toBe('HP prediction delivery capacity'); expect(p.pendingDamage).toBe(33);
});
it('clearDebt preserves the HP anchor and revision, while reset starts a fresh epoch', () => {
  const p = ledger(); const revision = p.revision;
  p.impact('a', loss(33), 410, 'player-hit'); p.clearDebt();
  expect(p.hp).toBe(707); expect(p.revision).toBe(revision); expect(p.pendingCount).toBe(0);
  p.reset(); expect(p.hp).toBeNull(); expect(p.revision).toBe(0); expect(p.graceMs).toBe(1000);
});
it('Armor Broken affects new losses while preserving earlier debt', () => {
  const p = ledger(); p.snapshot(300, 400);
  p.impact('a', assessPredictedLoss(65, definition, basis), 410, 'player-hit');
  const broken = assessPredictedLoss(65, definition, { ...basis, effects: 0x4000000 });
  p.impact('b', broken, 420, 'player-hit'); expect(p.lowerHp).toBe(202);
  p.impact('c', broken, 430, 'player-hit'); expect(p.lowerHp).toBe(137);
  expect(p.assessment('a')?.amount).toBe(33);
});
it.each([200, 400, 2000])('elapsed %s ms creates no loss; six later 98-damage reports cross the threshold', elapsed => {
  const p = ledger(); p.expire(400 + elapsed);
  expect(p.state(400 + elapsed)).toMatchObject({ hp: 707, pendingDamage: 0 });
  for (let n = 1; n <= 6; n++) {
    p.impact(String(n), loss(98), 401 + elapsed, 'player-hit');
    expect(p.lowerHp! <= 707 * .25).toBe(n === 6);
  }
  expect(p.lowerHp).toBe(119);
});
it('unknown HP remains unknown while real report debt is retained', () => {
  const p = new HealthPredictor(); expect(p.lowerHp).toBeNull();
  p.impact('a', loss(200), 0, 'player-hit');
  expect(p.lowerHp).toBeNull(); expect(p.pendingDamage).toBe(200);
  p.snapshot(707, 1); expect(p.lowerHp).toBe(507);
});
it('settled ids stay deduplicated through their expiry and can be reused only afterwards', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  for (let at = 600; at <= 1000; at += 200) p.timing(at, 80);
  p.snapshot(707, 1000); expect(p.has('a')).toBe(true); expect(p.assessment('a')).toBeUndefined();
  p.impact('a', { amount: 20, kind: 'measured', reason: null }, 1001, 'server-damage', 12000, null, true);
  expect(p.pendingCount).toBe(0);
  p.expire(12000); expect(p.has('a')).toBe(true);
  p.expire(12001); expect(p.has('a')).toBe(false);
  p.impact('a', loss(50), 12001, 'player-hit'); expect(p.pendingDamage).toBe(50);
});
it('measurement retains credited loss and never produces negative remaining damage', () => {
  const p = ledger(); p.impact('a', loss(50), 410, 'player-hit', 12000, 1); p.delivered(1, 411, 'written');
  p.timing(600, 80); p.snapshot(677, 600);
  p.impact('a', { amount: 0, kind: 'measured', reason: null }, 610, 'server-damage', 12000, null, true);
  expect(p.evidence(620)).toEqual({ pendingCount: 1, pendingDamage: 0, impacts: [
    { id: 'a', amount: 0, source: 'player-hit', ageMs: 210, kind: 'measured', reason: null, raw: null, credited: 30, writtenAt: 411 },
  ] });
});
it.each([NaN, Infinity, -1])('invalid assessment %s faults without changing HP or debt', amount => {
  const p = ledger(); expect(p.impact('invalid', loss(amount), 410, 'player-hit')).toBe(false);
  expect(p.state(410)).toMatchObject({ hp: 707, pendingDamage: 0, fault: 'invalid impact assessment' });
});
