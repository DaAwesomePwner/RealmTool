// Ported from realm-engine-client client/src/auto-drink/AutoDrinkTypes.ts @ 88a66b2 (MIT, see NOTICE).
export interface AutoDrinkSettings {
  enabled: boolean;
  enableHp: boolean;
  hpThresholdPct: number;
  enableMp: boolean;
  mpThresholdPct: number;
  intervalMs: number;
  inventoryFallback: boolean;
  healingOverTime: boolean;
  slotPriority: number[];
  excludedItems: number[];
}

export interface AutoDrinkItem {
  type: number;
  name: string;
  hp: number;
  mp: number;
  /** Healing condition duration; may be positive with hp=0 (no predicted healing). */
  healingDurationMs: number;
  quickslot: boolean;
}

export interface AutoDrinkExhaustion {
  slotId: number;
  /** Monotonic within a controller lifetime; unrelated drinks cannot change it. */
  episode: number;
  reason: string;
}

export interface AutoDrinkStatus {
  enabled: boolean;
  state: string;
  reason: string;
  hp: number | null;
  maxHp: number | null;
  slotId: number | null;
  itemType: number | null;
  /** Wall-clock milliseconds, for display only. */
  lastAttemptAt: number | null;
  cooldownRemainingMs: number;
  pending: boolean;
  epoch: number;
  /** Current exhausted slots, independent of the most recent drink attempt. */
  exhaustedSlots?: AutoDrinkExhaustion[];
}

export const DEFAULT_AUTO_DRINK_SETTINGS: AutoDrinkSettings = {
  enabled: false, enableHp: true, hpThresholdPct: 50, enableMp: false, mpThresholdPct: 50,
  intervalMs: 400, inventoryFallback: false, healingOverTime: false,
  slotPriority: [0, 1, 2], excludedItems: [],
};

/** Validate at both sides of the worker boundary; never coerce NaN/strings to a usable threshold. */
export function autoDrinkSettings(input: Partial<AutoDrinkSettings> = {}): AutoDrinkSettings {
  const result = { ...DEFAULT_AUTO_DRINK_SETTINGS, ...input };
  for (const key of ['enabled', 'enableHp', 'enableMp', 'inventoryFallback', 'healingOverTime'] as const) {
    if (typeof result[key] !== 'boolean') throw new TypeError(`Auto Drink ${key} must be boolean`);
  }
  for (const key of ['hpThresholdPct', 'mpThresholdPct', 'intervalMs'] as const) {
    if (!Number.isFinite(result[key])) throw new TypeError(`Auto Drink ${key} must be finite`);
  }
  result.hpThresholdPct = Math.max(0, Math.min(95, result.hpThresholdPct));
  result.mpThresholdPct = Math.max(0, Math.min(95, result.mpThresholdPct));
  result.intervalMs = Math.max(400, Math.min(5000, result.intervalMs));
  if (!Array.isArray(result.slotPriority) || result.slotPriority.some(v => !Number.isInteger(v) || v < 0 || v > 2))
    throw new TypeError('Auto Drink slotPriority must contain quickslot indices 0..2');
  if (!Array.isArray(result.excludedItems) || result.excludedItems.some(v => !Number.isInteger(v) || v < 0 || v > 0x7fffffff))
    throw new TypeError('Auto Drink excludedItems must contain item types');
  result.slotPriority = [...new Set([...result.slotPriority, 0, 1, 2])];
  result.excludedItems = [...new Set(result.excludedItems)];
  return result;
}

export function autoDrinkCatalog(items: AutoDrinkItem[]): AutoDrinkItem[] {
  if (!Array.isArray(items)) throw new TypeError('Auto Drink catalog must be an array');
  const seen = new Set<number>();
  return items.map(item => {
    if (!item || !Number.isInteger(item.type) || item.type < 0 || item.type > 0x7fffffff || seen.has(item.type)
      || typeof item.name !== 'string' || typeof item.quickslot !== 'boolean'
      || ![item.hp, item.mp, item.healingDurationMs].every(v => Number.isFinite(v) && v >= 0)
      || item.healingDurationMs > 86_400_000 || (item.hp === 0 && item.mp === 0 && item.healingDurationMs === 0))
      throw new TypeError('Invalid or duplicate Auto Drink catalog item');
    seen.add(item.type);
    return { ...item };
  });
}
