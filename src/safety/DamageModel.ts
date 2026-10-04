// Adapted from realm-engine-client client/src/safety/DamageModel.ts @ 88a66b2 (MIT, see NOTICE).
import type { SafetyProjectileDef } from './SafetyCatalog.ts';
import type { LossAssessment } from './HealthPredictor.ts';

export interface PlayerDamageBasis {
  defense: number | null;
  effects: number;
  effects2: number;
  conditionsKnown: boolean;
  revision: number;
  ageMs: number | null;
}

/** Standard incoming projectile path in game 7.0.0.2.0; see the correction evidence.
 * Wire DEF already includes equipment. Extra received-damage modifiers are not
 * observable here, so this is an estimate; additional modifiers may change actual loss.
 * Do not credit invulnerability, petrification or expected healing/reduction.
 */
export function assessPredictedLoss(raw: unknown, definition: SafetyProjectileDef | undefined,
  basis: PlayerDamageBasis, identityReason: string | null = null): LossAssessment {
  const validRaw = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000;
  const reason = identityReason ?? (!validRaw ? 'invalid-raw-damage' : !definition ? 'missing-projectile-definition'
    : typeof definition.armorPiercing !== 'boolean' ? 'missing-armor-piercing-metadata'
    : !basis.conditionsKnown ? 'unknown-player-conditions'
    : definition.maxHealthDamage !== 0 ? 'max-health-damage'
    : basis.defense === null ? 'unknown-player-defense' : null);
  const details = { raw: validRaw ? raw : null, defense: basis.defense, effects: basis.effects,
    effects2: basis.effects2, basisRevision: basis.revision, basisAgeMs: basis.ageMs };
  if (reason) return { ...details, amount: Math.max(200, validRaw ? raw : 0), kind: 'assumed', reason };
  let defense = definition!.armorPiercing || (basis.effects & 0x4000000) ? 0
    : (basis.effects & 0x2000000) ? Math.trunc(basis.defense! * 1.5) : basis.defense!;
  // Exposed follows piercing/Armor Broken: negative effective DEF is intentional.
  if (basis.effects2 & 0x20000) defense -= 20;
  let amount = Math.max(Math.trunc((raw as number) / 10), (raw as number) - defense);
  if (basis.effects2 & 0x40) amount = Math.trunc(Math.fround(amount * 1.25));
  return { ...details, amount, effectiveDefense: defense, kind: 'mitigated-estimate',
    reason: 'standard projectile; additional received-damage modifiers unobserved' };
}

/** Harmful effects are applied AFTER their own hit. Only three bounded entries.
 * Explicit durations let effects from earlier reports inform later burst estimates
 * without waiting for server condition stats. Never invent beneficial effects.
 */
export function applyProjectileConditions(active: Map<string, number>, definition: SafetyProjectileDef | undefined, at: number): void {
  for (const effect of definition?.conditionEffects ?? []) {
    const name = effect.effect.replace(/[\s_-]/g, '').toLowerCase();
    if (['armorbroken', 'exposed', 'curse', 'cursed'].includes(name) && Number.isFinite(effect.durationSec) && effect.durationSec > 0) {
      const key = name === 'cursed' ? 'curse' : name;
      active.set(key, Math.max(active.get(key) ?? 0, at + effect.durationSec * 1000));
    }
  }
}
export function withProjectileConditions(basis: PlayerDamageBasis, active: ReadonlyMap<string, number>, at: number): PlayerDamageBasis {
  return { ...basis, effects: basis.effects | ((active.get('armorbroken') ?? -Infinity) > at ? 0x4000000 : 0),
    effects2: basis.effects2 | ((active.get('exposed') ?? -Infinity) > at ? 0x20000 : 0)
      | ((active.get('curse') ?? -Infinity) > at ? 0x40 : 0) };
}
