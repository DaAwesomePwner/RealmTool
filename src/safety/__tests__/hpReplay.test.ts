// Adapted from realm-engine-client client/src/safety/__tests__/hpReplay.test.ts and hpPrediction.test.ts @ 88a66b2 (MIT, see NOTICE).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { replayHpPrediction, type HpReplay, type ReplayEvent } from './replay.ts';
import { assessPredictedLoss } from '../DamageModel.ts';
const trace: HpReplay = JSON.parse(readFileSync(new URL('./fixtures/projectile-healing-2026-09-23.json', import.meta.url), 'utf8'));
it('replays 34 recorded hits and recovery without permanent old debt', () => {
  const result = replayHpPrediction(trace);
  expect(result).toMatchObject({ distinctHits: 34, totalAssessedDamage: 1753, estimatedRetirements: 34 });
  expect(result.samples.at(-1)).toMatchObject({ serverHp: 707, modeledHp: 707, pendingCount: 0 });
  expect(result.samples.some(s => s.retired === 19 && s.serverHp === 707 && s.modeledHp === 707)).toBe(true);
  expect(result.samples.some(s => s.serverHp === 533 && s.pendingCount > 0 && s.modeledHp! < 533)).toBe(true);
});
it('replays explicit mitigated and assumed assessment amounts', () => {
  expect(replayHpPrediction({ schema: 1, description: 'Assessment amounts', events: [
    { at: 0, kind: 'hit', id: 1, amount: 33, assessmentKind: 'mitigated-estimate' },
    { at: 1, kind: 'hit', id: 2, amount: 200, assessmentKind: 'assumed' },
  ] })).toMatchObject({ distinctHits: 2, totalAssessedDamage: 233 });
});
interface Scenario {
  label: string; defense: number; serverHp: number; maxHp: number;
  events: { at: number; kind: string; hp?: number; rtt?: number; id?: number; raw?: number; written?: boolean }[];
}
const early: { scenarios: Scenario[] } = JSON.parse(readFileSync(new URL('./fixtures/early-escapes-2026-09-23.json', import.meta.url), 'utf8'));
it.each(early.scenarios)('reconciles reported losses above the threshold in $label', scenario => {
  const events: ReplayEvent[] = [];
  for (const e of scenario.events) {
    if (e.kind === 'tick') events.push({ at: e.at, kind: 'tick', rtt: e.rtt });
    if (e.hp !== undefined) events.push({ at: e.at, kind: 'hp', hp: e.hp, maxHp: scenario.maxHp });
    if (e.kind === 'hit') {
      const assessment = assessPredictedLoss(e.raw, { lifetimeMs: 10000, multiHit: false, armorPiercing: false,
        maxHealthDamage: 0, conditionEffects: [] }, { defense: scenario.defense, effects: 0, effects2: 0,
        conditionsKnown: true, revision: 1, ageMs: 0 });
      events.push({ at: e.at, kind: 'hit', id: e.id, amount: assessment.amount, assessmentKind: assessment.kind });
    }
    if (e.kind === 'delivery' && e.written) events.push({ at: e.at, kind: 'written', id: e.id });
  }
  const result = replayHpPrediction({ schema: 1, description: scenario.label, events });
  expect(result.firstHypotheticalThresholdCrossingMs).toBeNull();
  // Summary metadata describes the historical decision; replay uses explicit HP events only.
  expect(result.samples.at(-1)?.serverHp).toBe(scenario.events.filter(e => e.hp !== undefined).at(-1)!.hp);
  expect(result.samples.at(-1)!.modeledHp).toBeGreaterThan(scenario.maxHp * .25);
  const expected = scenario.label === 'Recorded escape 1'
    ? { hp: 524, damage: 132, count: 4, retired: 0 }
    : { hp: 593, damage: 66, count: 2, retired: 1 };
  expect(result.samples.at(-1)).toMatchObject({ modeledHp: expected.hp, pendingDamage: expected.damage,
    pendingCount: expected.count });
  expect(result.estimatedRetirements).toBe(expected.retired);
});
