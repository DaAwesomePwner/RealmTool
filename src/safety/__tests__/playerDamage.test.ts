// Adapted from realm-engine-client client/src/safety/__tests__/playerDamage.test.ts @ 88a66b2 (MIT, see NOTICE).
import { expect, it } from 'vitest';
import { assessPredictedLoss, type PlayerDamageBasis } from '../DamageModel.ts';
import type { SafetyProjectileDef } from '../SafetyCatalog.ts';

const definition: SafetyProjectileDef = { lifetimeMs: 4250, multiHit: false, armorPiercing: false, maxHealthDamage: 0, conditionEffects: [] };
const basis: PlayerDamageBasis = { defense: 32, effects: 0, effects2: 0, conditionsKnown: true, revision: 1, ageMs: 0 };

// Current client core routine plus the live 707 -> 674 and 707 -> 641 observations.
it.each([
  ['ordinary', 65, 32, false, 0, 0, 33],
  ['minimum floors at ten percent', 65, 99, false, 0, 0, 6],
  ['small minimum may be zero', 9, 99, false, 0, 0, 0],
  ['Armored truncates odd defense', 65, 33, false, 0x2000000, 0, 16],
  ['Armor Broken overrides Armored', 65, 32, false, 0x6000000, 0, 65],
  ['piercing', 65, 32, true, 0, 0, 65],
  ['Exposed', 65, 32, false, 0, 0x20000, 53],
  ['piercing then Exposed', 65, 32, true, 0, 0x20000, 85],
  ['Armor Broken then Exposed', 65, 32, false, 0x4000000, 0x20000, 85],
  ['Curse after defense', 65, 32, false, 0, 0x40, 41],
  ['Curse after exposed piercing', 65, 32, true, 0, 0x20040, 106],
  ['no speculative immunity credit', 65, 32, false, 0x1000000, 0, 33],
  ['no speculative petrification credit', 65, 32, false, 0, 8, 33],
] as const)('%s', (_name, raw, defense, armorPiercing, effects, effects2, amount) => {
  expect(assessPredictedLoss(raw, { ...definition, armorPiercing }, { ...basis, defense, effects, effects2 }))
    .toMatchObject({ raw, defense, amount, kind: 'mitigated-estimate' });
});

it('keeps unknown metadata, defense and percent-health mechanics explicit', () => {
  expect(assessPredictedLoss(65, { ...definition, armorPiercing: undefined }, basis))
    .toMatchObject({ amount: 200, kind: 'assumed', reason: 'missing-armor-piercing-metadata' });
  expect(assessPredictedLoss(65, definition, { ...basis, defense: null }))
    .toMatchObject({ amount: 200, kind: 'assumed', reason: 'unknown-player-defense' });
  expect(assessPredictedLoss(400, { ...definition, maxHealthDamage: .1 }, basis))
    .toMatchObject({ amount: 400, kind: 'assumed', reason: 'max-health-damage' });
});
