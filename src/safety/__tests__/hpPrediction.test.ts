// Adapted from realm-engine-client client/src/safety/__tests__/hpPrediction.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFactory } from '../../protocol/schema.ts';
import { SafetyEngine } from '../SafetyEngine.ts';
import { assessPredictedLoss } from '../DamageModel.ts';
import type { SafetySettingsInput } from '../SafetyTypes.ts';
const factory = createFactory();
const createPacket = (_id: number, name: string, direction: 'client' | 'server') => {
  const packet = factory.createByName(name); packet.direction = direction; return packet;
};
function fixture(settings: SafetySettingsInput = {}, hp = 707, max = 707) {
  const escape = vi.fn(), engine = new SafetyEngine(escape);
  let now = 1000, tick = 0, observation = 0;
  const send = (name: string, data: any = {}, client = false) => {
    const p = createPacket(1, name, client ? 'client' : 'server'); p.isDefined = true; p.data = data;
    const id = ++observation; engine.observe(p, now, id); return { p, id };
  };
  engine.configure({ enabled: true, preHitPrediction: true, predictionModel: 'v2', burstGuard: false, retryCount: 0, ...settings }, now);
  engine.setCatalog({ projectiles: [[100, 0, { lifetimeMs: 10000, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] }]], tiles: [] });
  send('MAPINFO', { name: 'Realm' }); send('CREATESUCCESS', { objectId: 1 });
  send('UPDATE', { newObjs: [ { objectType: 100, status: { objectId: 2, data: [] } },
    { objectType: 768, status: { objectId: 1, data: [{ id: 0, value: max }, { id: 1, value: hp }, { id: 21, value: 0 }] } } ] });
  const hit = (bullet: number, raw?: number) => {
    if (raw !== undefined) send('ENEMYSHOOT', { ownerId: 2, bulletId: bullet, bulletType: 0, damage: raw });
    return send('PLAYERHIT', { objectId: 2, bulletId: bullet }, true);
  };
  return { engine, escape, send, hit, now: () => now,
    advance: (ms: number) => { now += ms; engine.advance(now); },
    hp: (hp?: number) => send('NEWTICK', { tickId: ++tick, serverLastRttMs: 80,
      statuses: [{ objectId: 1, data: hp === undefined ? [] : [{ id: 1, value: hp }] }] }),
  };
}

it.each([false, true])('retires delivered hits at full HP on healthy HP-less ticks, owner absent=%s', absent => {
  const f = fixture({}, 865, 865);
  f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 21, value: 45 }] } }] });
  for (let bullet = 1; bullet <= 4; ++bullet) {
    const hit = f.hit(bullet, 140); f.engine.reportDelivered(hit.id, f.now(), true);
  }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 4, pendingDamage: 380 });
  const revision = f.engine.predictor.revision;
  for (let tick = 1; tick <= 150; ++tick) {
    f.advance(200);
    if (absent) f.send('NEWTICK', { tickId: tick, serverLastRttMs: 80, statuses: [{ objectId: 2, data: [{ id: 1, value: 10 }] }] });
    else f.hp();
  }
  expect(f.engine.status()).toMatchObject({ confirmedHp: 865, lowerHp: 865, healthAgeMs: 30000,
    prediction: { pendingCount: 0, pendingDamage: 0, retiredCount: 4, creditedDamage: 0, retirementEnabled: true } });
  expect(f.engine.predictor.revision).toBe(revision);
  f.hit(5, 140); expect(f.engine.status().lowerHp).toBe(770); expect(f.escape).not.toHaveBeenCalled();
  expect(f.engine.decisionEvidence(f.now(), 'test')).toMatchObject({ retirementEnabled: true, graceMs: 580, lastHpAgeMs: 30000 });
});
it('HP-less ticks wait for the full grace and supply no loss credit', () => {
  const f = fixture(); f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  f.advance(200); f.hp(); f.advance(200); f.hp(); f.advance(179); f.hp();
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 100,
    creditedDamage: 0, retiredCount: 0, graceMs: 580, retirementEnabled: true });
  f.advance(1); f.hp();
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 0, creditedDamage: 0, retiredCount: 1 });
});
it.each(['backlog', 'unhealthy', 'long-rtt'] as const)('HP-less ticks retain delivered debt with %s timing', kind => {
  const f = fixture(); f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  if (kind === 'backlog') f.engine.deliveryBacklog(true);
  if (kind === 'unhealthy') { f.advance(1600); f.hp(); }
  else for (let tick = 4; tick <= 24; ++tick) {
    f.advance(200);
    f.send('NEWTICK', { tickId: tick, serverLastRttMs: kind === 'long-rtt' ? 3000 : 80, statuses: [] });
  }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 100,
    retiredCount: 0, creditedDamage: 0, retirementEnabled: false });
});
it('HP-less ticks retain held reports and age them from their eventual write', () => {
  const f = fixture(); const hit = f.hit(1, 100);
  for (let i = 0; i < 10; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 100, retiredCount: 0, retirementEnabled: true });
  f.engine.reportDelivered(hit.id, f.now(), true);
  f.advance(200); f.hp(); expect(f.engine.status().prediction?.pendingCount).toBe(1);
  for (let i = 0; i < 4; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 0, retiredCount: 1 });
});
it.each([undefined, null, -1, NaN, Infinity, '865'])('does not reconcile an explicit invalid HP stat: %s', value => {
  const f = fixture(); const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  for (let tick = 1; tick <= 10; ++tick) {
    f.advance(200);
    f.send('NEWTICK', { tickId: tick, serverLastRttMs: 80, statuses: [{ objectId: 1, data: [{ id: 1, value }] }] });
  }
  expect(f.engine.status()).toMatchObject({ confirmedHp: 707, healthAgeMs: 2000,
    prediction: { pendingCount: 1, pendingDamage: 100, retiredCount: 0, retirementEnabled: true } });
});
it.each(['NEWTICK', 'UPDATE', 'invalid HP'] as const)('a gap from %s blocks later HP-less reconciliation until a valid HP sample', gap => {
  const f = fixture(); f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  if (gap === 'invalid HP') f.send('NEWTICK', { tickId: 4, serverLastRttMs: 80, statuses: [{ objectId: 1, data: [{ id: 1, value: -1 }] }] });
  else { const p = createPacket(1, gap, 'server'); p.isDefined = false; f.engine.observe(p, f.now()); }
  // The gap may have carried the real loss; later omissions cannot prove the stale anchor unchanged.
  for (let i = 0; i < 10; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 100, retiredCount: 0, retirementEnabled: true });
  f.advance(200); f.hp(707);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 0, retiredCount: 1 });
  const next = f.hit(2, 100); f.engine.reportDelivered(next.id, f.now(), true);
  for (let i = 0; i < 6; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 0, retiredCount: 2, creditedDamage: 0 });
});
it.each(['unreadable', 'duplicate', 'old'] as const)('does not reconcile %s HP-less ticks', kind => {
  const f = fixture(); f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true); f.advance(600);
  const p = createPacket(1, 'NEWTICK', 'server');
  p.isDefined = kind !== 'unreadable'; p.data = { tickId: kind === 'old' ? 2 : kind === 'duplicate' ? 3 : 4, statuses: [] };
  f.engine.observe(p, f.now());
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 100, retiredCount: 0, retirementEnabled: true });
});
it('HP-less ticks cannot establish an unknown HP anchor or retire its debt', () => {
  const f = fixture({}, NaN); const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  for (let i = 0; i < 10; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status()).toMatchObject({ confirmedHp: null, healthAgeMs: null,
    prediction: { pendingCount: 1, pendingDamage: 100, retiredCount: 0, retirementEnabled: true } });
  expect(f.engine.decisionEvidence(f.now(), 'test').lastHpAgeMs).toBeNull();
});
it('does not run unchanged-HP reconciliation with Collision HP off', () => {
  const f = fixture({ preHitPrediction: false }); const reconcile = vi.spyOn(f.engine.predictor, 'unchangedHp');
  for (let i = 0; i < 10; ++i) { f.advance(200); f.hp(); }
  expect(reconcile).not.toHaveBeenCalled();
  expect(f.engine.status()).toMatchObject({ confirmedHp: 707, healthAgeMs: 2000 });
  expect(f.engine.decisionEvidence(f.now(), 'test').retirementEnabled).toBe(false);
});
it('HP-less ticks reconcile server-seen damage without requiring a client write', () => {
  const f = fixture(); f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 100 });
  for (let i = 0; i < 10; ++i) { f.advance(200); f.hp(); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 0, retiredCount: 1, creditedDamage: 0 });
});
it('explicit HP loss still credits a delivered hit after unchanged-HP reconciliation', () => {
  const f = fixture(); f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, 100); f.engine.reportDelivered(hit.id, f.now(), true);
  f.advance(100); f.hp();
  expect(f.engine.status().prediction).toMatchObject({ pendingDamage: 100, creditedDamage: 0 });
  f.advance(100); f.hp(647);
  expect(f.engine.status()).toMatchObject({ confirmedHp: 647, healthAgeMs: 0,
    prediction: { pendingCount: 1, pendingDamage: 40, creditedDamage: 60, retiredCount: 0 } });
});

it('charges each distinct unknown hit at 200 without a full-HP uncertainty exit', () => {
  const f = fixture(); f.hit(1);
  expect(f.engine.status().lowerHp).toBe(507); expect(f.escape).not.toHaveBeenCalled();
  f.hit(2); expect(f.engine.status().lowerHp).toBe(307); expect(f.escape).not.toHaveBeenCalled();
  f.hit(3); expect(f.escape).toHaveBeenCalledTimes(1);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 107, evidence: { pendingCount: 3, pendingDamage: 600 } });
});
it('counts repeated unresolved reports independently while final-writer observation stays deduplicated', () => {
  const f = fixture(); const hit = f.hit(1);
  f.engine.preparePredictionWrite(hit.p, f.now(), hit.id);
  expect(f.engine.status().lowerHp).toBe(507);
  f.hit(1); expect(f.engine.status().lowerHp).toBe(307);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 });
  expect(f.engine.status().lowerHp).toBe(307); // Ambiguous correspondence cannot forgive either loss.
  f.hit(1); expect(f.escape).toHaveBeenCalledTimes(1);
});
it('keeps decision evidence server-only with active model selected and prediction OFF', () => {
  const f = fixture({ preHitPrediction: false }); f.hit(1, 600); f.hp(100);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 100,
    evidence: { pendingCount: 0, pendingDamage: 0 } });
});
it('crosses on the seventh synthetic hit before any server reply', () => {
  const f = fixture({}, 767, 860);
  for (let i = 1; i <= 6; ++i) f.hit(i, 80);
  expect(f.escape).not.toHaveBeenCalled(); f.hit(7, 80);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 207, thresholdHp: 215 });
});
// These reconstruct the two reviewed live decision states, not the full capture.
// Raw exports rotated before archival. The first case uses a synthetic 90-HP
// inclusion to recreate the recorded 3-HP residual; event timings are synthetic.
it.each([
  { serverHp: 260, residual: 3, hits: 1, estimatedHp: 164 },
  { serverHp: 355, residual: 0, hits: 2, estimatedHp: 169 },
])('preserves the reviewed smoke boundary: $serverHp server -> $estimatedHp collision HP', scenario => {
  const f = fixture({}, scenario.serverHp + (scenario.residual ? 90 : 0));
  f.send('NEWTICK', { tickId: 0, serverLastRttMs: 80,
    statuses: [{ objectId: 1, data: [{ id: 21, value: 32 }] }] });
  f.advance(200); f.hp(); f.advance(200); f.hp();
  if (scenario.residual) {
    const older = f.hit(0, 125);
    f.engine.reportDelivered(older.id, f.now(), true);
    f.advance(100); f.hp(scenario.serverHp);
    expect(f.engine.status().prediction?.pendingDamage).toBe(3);
  }
  for (let i = 1; i <= scenario.hits; ++i) {
    expect(f.escape).not.toHaveBeenCalled();
    f.advance(100); f.hit(i, 125);
  }
  expect(f.escape).toHaveBeenCalledTimes(1);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ confirmedHp: scenario.serverHp,
    lowerHp: scenario.estimatedHp, maxHp: 707, thresholdHp: 176.75,
    evidence: { impacts: expect.arrayContaining([expect.objectContaining({ kind: 'mitigated-estimate' })]) } });
  expect(f.engine.status().confirmedHp).toBeGreaterThan(176.75);
});
it('preserves a known large amount and labels unsupported amplification as assumed', () => {
  expect(assessPredictedLoss(400, undefined, { defense: 0, effects: 0, effects2: 0, conditionsKnown: true, revision: 1, ageMs: 0 }))
    .toMatchObject({ amount: 400, kind: 'assumed', reason: 'missing-projectile-definition' });
  const f = fixture(); f.hit(1, 600); expect(f.escape.mock.calls[0][0].lowerHp).toBe(107);
});
it('replaces a matching estimate with server DAMAGE, including zero, without adding it twice', () => {
  const f = fixture(); f.hit(1, 100);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 });
  expect(f.engine.status().lowerHp).toBe(689);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 0 });
  expect(f.engine.status().lowerHp).toBe(707);
});
it('server DAMAGE before PLAYERHIT stays one measured occurrence', () => {
  const f = fixture(); f.send('ENEMYSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 100 });
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 }); f.hit(1);
  expect(f.engine.status().lowerHp).toBe(689);
});
it('unknown DAMAGE can replace exactly one unresolved report in either arrival order', () => {
  for (const damageFirst of [false, true]) {
    const f = fixture();
    const damage = () => f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 });
    if (damageFirst) damage(); f.hit(1); if (!damageFirst) damage();
    expect(f.engine.status().lowerHp).toBe(689);
  }
});
it('counts individual multi-hit reports while declining ambiguous DAMAGE forgiveness', () => {
  const f = fixture();
  f.engine.setCatalog({ projectiles: [[100, 0, { lifetimeMs: 10000, multiHit: true, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] }]], tiles: [] });
  f.hit(1, 100); f.hit(1); expect(f.engine.status().lowerHp).toBe(507);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 });
  expect(f.engine.status().lowerHp).toBe(507);
});
it('retired shadow selector cannot calculate HP while Collision HP is OFF', () => {
  const f = fixture({ predictionModel: 'v2-shadow', preHitPrediction: false }); f.hit(1, 600);
  expect(f.escape).not.toHaveBeenCalled(); expect(f.engine.status().lowerHp).toBe(707);
  expect(f.engine.status().prediction).toBeNull();
  f.hp(100); expect(f.escape.mock.calls[0][0].reason).toBe('server HP threshold');
});
it('ignores the retired shadow selector with explicit Collision HP ON', () => {
  const f = fixture({ predictionModel: 'v2-shadow' }); f.hit(1, 600);
  expect(f.escape).toHaveBeenCalledTimes(1);
});
it.each([false, true])('v2 retains the explicit server-zero contract, prediction=%s', preHitPrediction => {
  const f = fixture({ thresholdPct: 0, preHitPrediction }); f.hit(1, 1000);
  expect(f.escape).not.toHaveBeenCalled(); f.hp(0); expect(f.escape).toHaveBeenCalledTimes(1);
});

it('uses updated DEF for new hits and leaves the earlier assessment unchanged', () => {
  const f = fixture();
  const stats = (data: any[]) => f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data } }] });
  stats([{ id: 21, value: 32 }]); f.hit(1, 65);
  stats([{ id: 21, value: 40 }]); f.hit(1); f.hit(2, 65);
  expect(f.engine.predictor.state(f.now()).pendingDamage).toBe(33 + 25);
});

it('escapes on the 17th ordinary mitigated hit, not at 70-80% HP', () => {
  const f = fixture(); f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 21, value: 32 }] } }] });
  for (let bullet = 1; bullet <= 16; ++bullet) f.hit(bullet, 65);
  expect(f.engine.status().lowerHp).toBe(179); expect(f.escape).not.toHaveBeenCalled();
  f.hit(17, 65); expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 146, thresholdHp: 176.75 });
});

it('uses an inclusive 25% boundary for a mitigated hit', () => {
  const f = fixture({}, 233, 800);
  f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 21, value: 32 }] } }] });
  f.hit(1, 64); expect(f.engine.status().lowerHp).toBe(201); expect(f.escape).not.toHaveBeenCalled();
  f.hit(2, 10); expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 200, thresholdHp: 200 });
});


it.each([200, 400, 2000])('replays the Kraken approach without escape and counts the sixth synthetic collision, window=%s', reactionMs => {
  const trace = JSON.parse(readFileSync(new URL('./fixtures/kraken-precontact-2026-09-24.json', import.meta.url), 'utf8'));
  const f = fixture({ reactionMs }, trace.hp, trace.maxHp);
  f.engine.setCatalog({ projectiles: [1500, 1675, 1875, 2150, 2500, 3000].map((lifetimeMs, bullet) =>
    [trace.ownerType, bullet, { lifetimeMs, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] }]), tiles: [] });
  f.send('UPDATE', { newObjs: [{ objectType: trace.ownerType, status: { objectId: 2, data: [] } },
    { status: { objectId: 1, data: [{ id: 21, value: trace.defense }] } }] });
  for (const shot of trace.shots) f.send('ENEMYSHOOT', { ownerId: 2, bulletId: shot.bullet,
    bulletType: shot.bulletType, damage: trace.raw, numShots: shot.numShots });
  f.advance(20);
  let previous = 0;
  for (const scan of trace.scans) {
    f.advance(scan.at - previous); previous = scan.at;
    expect(f.engine.predictor.state(f.now())).toMatchObject({ hp: 707, pendingDamage: 0 });
    expect(f.escape).not.toHaveBeenCalled();
  }
  // The live recording ended at escape without hits. This suffix deliberately
  // simulates the alternative of continuing into six distinct projectiles.
  for (const shot of trace.shots.slice(0, 5)) f.hit(shot.bullet);
  expect(f.engine.status()).toMatchObject({ lowerHp: 217, confirmedHp: 707 });
  expect(f.escape).not.toHaveBeenCalled();
  f.hit(trace.shots[5].bullet);
  expect(f.escape).toHaveBeenCalledTimes(1);
  expect(f.escape.mock.calls[0][0]).toMatchObject({ lowerHp: 119, confirmedHp: 707, thresholdHp: 176.75,
    evidence: { pendingCount: 6, pendingDamage: 588 } });
});


it('does not charge again at the final writer; rewritten/injected hits are evaluated', () => {
  const f = fixture(); const original = f.hit(1, 100);
  f.engine.preparePredictionWrite(original.p, f.now(), original.id);
  expect(f.engine.predictor.state(f.now()).pendingCount).toBe(1);
  const p = createPacket(1, 'PLAYERHIT', 'client'); p.isDefined = true; p.data = { objectId: 2, bulletId: 2 };
  f.engine.preparePredictionWrite(p, f.now(), null); expect(f.engine.status().lowerHp).toBe(407);
});
it('mode/epoch changes clear model history without inventing health', () => {
  const f = fixture(); f.hit(1, 100);
  f.engine.configure({ preHitPrediction: false }, f.now()); expect(f.engine.predictor.state(f.now()).pendingCount).toBe(0);
  expect(f.engine.status().confirmedHp).toBe(707);
  f.engine.connectionChanged(2); expect(f.engine.predictor.hp).toBeNull();
});


const definition = (multiHit = false) => ({ lifetimeMs: 10000, multiHit, armorPiercing: false,
  maxHealthDamage: 0, conditionEffects: [] });
it('applies harmful conditions after the actual hit and expires them for later reports', () => {
  const f = fixture({ thresholdPct: 0 });
  f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 21, value: 32 }] } }] });
  f.engine.setCatalog({ projectiles: [[100, 0, { ...definition(), conditionEffects: [{ effect: 'Armor Broken', durationSec: 2 }] }]], tiles: [] });
  f.send('ENEMYSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 65 });
  expect(f.engine.status().prediction?.pendingDamage).toBe(0);
  f.hit(1); f.hit(1); f.hit(2, 65);
  expect(f.engine.status().prediction?.pendingDamage).toBe(33 + 65);
  f.advance(2001); f.hit(3, 65);
  expect(f.engine.status().prediction?.pendingDamage).toBe(33 + 65 + 33);
});
it('unknown HP without loss stays idle; a real report requests health unavailable during observed danger', () => {
  const f = fixture({}, NaN);
  f.advance(2000); expect(f.escape).not.toHaveBeenCalled(); f.hit(1);
  expect(f.escape.mock.calls[0][0].reason).toBe('health unavailable during observed danger');
});
it.each([0, 18])('DAMAGE first preserves measured %s against the later matching report', amount => {
  const f = fixture(); f.send('ENEMYSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 100 });
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: amount }); f.hit(1);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: amount });
});
it.each([false, true])('multi-hit keeps each report and declines ambiguous DAMAGE, DAMAGE first=%s', first => {
  const f = fixture(); f.engine.setCatalog({ projectiles: [[100, 0, definition(true)]], tiles: [] });
  f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 21, value: 32 }] } }] });
  f.send('ENEMYSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 80 });
  const damage = () => f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 0 });
  if (first) damage(); f.hit(1); if (!first) damage();
  expect(f.engine.status().prediction?.pendingDamage).toBe(48);
  f.hit(1); expect(f.engine.status().prediction?.pendingDamage).toBe(96);
});
it('same observation rewritten at the final writer assesses the changed report once', () => {
  const f = fixture(); const original = f.hit(1, 100);
  const rewritten = createPacket(1, 'PLAYERHIT', 'client');
  rewritten.isDefined = true; rewritten.data = { objectId: 2, bulletId: 2 };
  f.engine.preparePredictionWrite(rewritten, f.now(), original.id);
  f.engine.preparePredictionWrite(rewritten, f.now(), original.id);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 2, pendingDamage: 300 });
});
it.each(['zero', 'credited'] as const)('R3: stalled delivery ignores %s remaining loss, then positive loss faults only at threshold', kind => {
  const f = fixture(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const hit = f.hit(1, kind === 'zero' ? 0 : 50); f.engine.reportDelivered(hit.id, f.now(), true);
  if (kind === 'credited') { f.advance(100); f.hp(657); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: 0 });
  f.engine.deliveryStalled(f.now(), 10000);
  expect(f.engine.status().prediction?.fault).toBeNull(); expect(f.escape).not.toHaveBeenCalled();
  f.hit(2, 1); const hp = f.engine.status().lowerHp!;
  f.engine.deliveryStalled(f.now(), hp - 176.75 - .01); expect(f.escape).not.toHaveBeenCalled();
  f.engine.deliveryStalled(f.now(), hp - 176.75);
  expect(f.escape.mock.calls[0][0].reason).toBe('danger delivery stalled behind plugin processing');
});
it('R4: unresolved report serials never reuse older active IDs after the 12 second window', () => {
  const f = fixture({ thresholdPct: 0 }); f.hit(1); f.hit(1);
  f.advance(12001); f.hit(1); f.hit(1);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 4, pendingDamage: 800 });
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 0 });
  expect(f.engine.status().prediction?.pendingDamage).toBe(800);
});
it('each unresolved report refreshes correspondence so later DAMAGE cannot replace an ambiguous contact', () => {
  const f = fixture({ thresholdPct: 0 });
  f.hit(1); // Relative t=0.
  f.advance(11000); f.hit(1);
  f.advance(1001); f.hit(1);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 3, pendingDamage: 600 });
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 0 });
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 3, pendingDamage: 600 });
});
it('DAMAGE lookup does not refresh the unresolved report correspondence window', () => {
  const f = fixture({ thresholdPct: 0 }); f.hit(1);
  f.advance(11000);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 18 });
  f.advance(1001); f.hit(1);
  f.send('DAMAGE', { targetId: 1, objectId: 2, bulletId: 1, damageAmount: 0 });
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 2, pendingDamage: 18 });
});
it.each([true, false])('injected ground delivery gets a unique negative id and reconciles only when written=%s', written => {
  const f = fixture();
  f.engine.setCatalog({ projectiles: [], tiles: [[7, 50]] });
  f.send('UPDATE', { tiles: [{ x: 1, y: 1, type: 7 }] });
  f.hp(); f.advance(200); f.hp(); f.advance(200); f.hp();
  const packet = createPacket(1, 'GROUNDDAMAGE', 'client');
  packet.isDefined = true; packet.data = { position: { x: 1, y: 1 } };
  const id = f.engine.preparePredictionWrite(packet, f.now(), null);
  expect(id).toBeLessThan(0);
  f.engine.reportDelivered(id, f.now(), written);
  expect(f.engine.decisionEvidence(f.now(), 'test').impacts[0].writtenAt).toBe(written ? f.now() : null);
  f.advance(100); f.hp(657);
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: 1, pendingDamage: written ? 0 : 50 });
  for (let i = 0; i < 4; ++i) { f.advance(200); f.hp(657); }
  expect(f.engine.status().prediction).toMatchObject({ pendingCount: written ? 0 : 1, pendingDamage: written ? 0 : 50 });
  const nextId = f.engine.preparePredictionWrite(packet, f.now(), null);
  expect(nextId).toBeLessThan(id!);
});
it('R5: zero threshold with unknown maxHP never triggers ON until maxHP becomes known', () => {
  const f = fixture({ thresholdPct: 0 }, 0, NaN); f.hit(1); f.advance(20000);
  expect(f.escape).not.toHaveBeenCalled();
  f.send('UPDATE', { newObjs: [{ status: { objectId: 1, data: [{ id: 0, value: 707 }] } }] });
  expect(f.escape.mock.calls[0][0]).toMatchObject({ reason: 'server HP threshold', confirmedHp: 0 });
});
it('retires a dropped AoE by observation id without changing HP or lifecycle', () => {
  const f = fixture(); f.hit(1, 10);
  for (const [id, damage] of [[1, 500], [2, 20]]) {
    const p = createPacket(1, 'AOE', 'server');
    p.isDefined = true; p.data = { position: { x: 1, y: 1 }, radius: 2, damage };
    f.engine.observe(p, f.now(), id);
  }
  const before = f.engine.status();
  f.engine.retireArea(1);
  expect(f.engine.status()).toEqual(before);
  f.engine.retireArea(999);
  expect(f.engine.status()).toEqual(before);
  f.send('AOEACK', { position: { x: 1, y: 1 } }, true);
  expect(f.engine.status()).toMatchObject({ confirmedHp: 707, lowerHp: 677,
    prediction: { pendingDamage: 30 } });
  f.engine.retireArea(2);
  expect(f.engine.status().prediction?.pendingDamage).toBe(30);
  expect(f.escape).not.toHaveBeenCalled();
});
it('retiring an unknown AoE observation leaves FIFO correspondence unchanged', () => {
  const f = fixture();
  f.send('AOE', { position: { x: 1, y: 1 }, radius: 2, damage: 40 });
  f.send('AOE', { position: { x: 1, y: 1 }, radius: 2, damage: 20 });
  f.engine.retireArea(999);
  f.send('AOEACK', { position: { x: 1, y: 1 } }, true);
  expect(f.engine.status().prediction?.pendingDamage).toBe(40);
  f.send('AOEACK', { position: { x: 1, y: 1 } }, true);
  expect(f.engine.status().prediction?.pendingDamage).toBe(60);
});
it('R9: cleanup prunes areas older than 10 seconds and the next ACK consumes the fresh area', () => {
  const f = fixture();
  f.send('AOE', { position: { x: 1, y: 1 }, radius: 2, damage: 500 });
  f.advance(10001);
  f.send('AOE', { position: { x: 1, y: 1 }, radius: 2, damage: 20 }); f.hp();
  f.send('AOEACK', { position: { x: 1, y: 1 } }, true);
  expect(f.engine.status().prediction?.pendingDamage).toBe(20); expect(f.escape).not.toHaveBeenCalled();
});
it.each([false, true])('R11: held report final assessment uses new mode, originally ON=%s', initiallyOn => {
  const f = fixture({ preHitPrediction: initiallyOn }); const hit = f.hit(1, 100);
  f.advance(100); f.engine.configure({ preHitPrediction: !initiallyOn }, f.now());
  f.engine.preparePredictionWrite(hit.p, f.now(), hit.id);
  expect(f.engine.status()).toMatchObject({ confirmedHp: 707, healthAgeMs: 100, lowerHp: initiallyOn ? 707 : 607 });
  if (initiallyOn) {
    f.engine.configure({ preHitPrediction: true }, f.now());
    f.engine.preparePredictionWrite(hit.p, f.now(), hit.id);
    expect(f.engine.status().prediction?.pendingDamage).toBe(100);
  }
});
it.each([21, 29, 95])('malformed stat %s makes the damage basis unknown until a valid sample', id => {
  for (const value of [NaN, Infinity, '0', -2147483649, 4294967296, .5]) {
    const f = fixture({ thresholdPct: 0 });
    f.send('NEWTICK', { tickId: 1, statuses: [{ objectId: 1, data: [{ id, value }] }] }); f.hit(1, 80);
    expect(f.engine.decisionEvidence(f.now(), 'test').impacts[0]).toMatchObject({ amount: 200, kind: 'assumed' });
    if (id !== 21) expect(f.engine.status().conditionsKnown).toBe(false);
    f.send('NEWTICK', { tickId: 2, statuses: [{ objectId: 1, data: [{ id, value: 0 }] }] }); f.hit(2, 80);
    expect(f.engine.decisionEvidence(f.now(), 'test').impacts[1]).toMatchObject({ amount: 80, kind: 'mitigated-estimate' });
  }
});
it('AoE capacity of 128 records uncertainty and faults when an impact is pending', () => {
  const f = fixture(); f.hit(1, 1);
  for (let i = 0; i < 129; ++i) f.send('AOE', { position: { x: 1, y: 1 }, radius: 1, damage: 1 });
  expect(f.escape.mock.calls[0][0].reason).toBe('AoE correspondence capacity');
});
it('R6: SERVERPLAYERSHOOT does not establish a known PLAYERHIT', () => {
  const f = fixture(); f.send('SERVERPLAYERSHOOT', { ownerId: 2, bulletId: 1, bulletType: 0, damage: 80 }); f.hit(1);
  expect(f.engine.decisionEvidence(f.now(), 'test').impacts[0]).toMatchObject({ amount: 200, kind: 'assumed' });
});
it('catalog replacement keeps debt and late definitions resolve existing spawns', () => {
  const f = fixture(); f.hit(1, 80);
  f.engine.setCatalog({ projectiles: [], tiles: [] });
  f.send('ENEMYSHOOT', { ownerId: 2, bulletId: 2, bulletType: 0, damage: 20 });
  f.engine.setCatalog({ projectiles: [[100, 0, definition()]], tiles: [] }); f.hit(2);
  expect(f.engine.status().prediction?.pendingDamage).toBe(100);
});
