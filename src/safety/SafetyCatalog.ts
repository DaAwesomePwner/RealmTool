// Adapted from realm-engine-client client/src/safety/SafetyTypes.ts @ 88a66b2 (MIT, see NOTICE).
export interface SafetyConditionEffect { effect: string; durationSec: number }
export interface SafetyProjectileDef {
  lifetimeMs: number;
  multiHit: boolean;
  /** Missing metadata is unknown, not non-piercing. Generated catalogs always set it. */
  armorPiercing?: boolean;
  maxHealthDamage: number;
  conditionEffects: SafetyConditionEffect[];
}
/** What SafetyEngine consumes (REC shape). An empty catalog is valid: every report takes the unknown path. */
export interface SafetyCatalog {
  projectiles: [objectType: number, projectileId: number, def: SafetyProjectileDef][];
  tiles: [groundType: number, damage: number][];
}
export const PROJECTILE_FLAGS = Object.freeze({ multiHit: 1, armorPiercing: 2 });
/** One row of data/catalogs/safety.json. */
export type SafetyProjectileRow = [objectType: number, projectileId: number, lifetimeMs: number,
  flags: number, maxHealthDamage: number, effects: [effect: string, durationSec: number][]];
export interface SafetyCatalogFile {
  schemaVersion: 1;
  gameBuild: string;
  source: { objectsSha256: string; tilesSha256: string };
  projectiles: SafetyProjectileRow[];
  tiles: [groundType: number, damage: number][];
}
/** Ruling R8. */
export const SAFETY_CATALOG_LIMITS = Object.freeze({
  maxType: 65_535, maxProjectileId: 255, maxLifetimeMs: 1_000_000_000, maxDurationSec: 1_000_000,
  maxDamage: 1_000_000, maxFileBytes: 1_048_576,
});
/** Catalog state shown in status; the engine sees only the SafetyCatalog. A fallback suspends Collision HP (ruling R2). */
export type SafetyCatalogState =
  | { state: 'ready'; gameBuild: string; projectiles: number; tiles: number }
  | { state: 'fallback'; reason: string };
