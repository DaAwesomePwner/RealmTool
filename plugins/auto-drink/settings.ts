// Adapted from realm-engine-client client/plugins/auto-drink/settings.ts @ 88a66b2 (MIT, see NOTICE).
import type { SettingDef } from '../../src/plugins/api.ts';
import { autoDrinkSettings, type AutoDrinkSettings } from '../../src/auto-drink/AutoDrinkTypes.ts';

export const DEFAULTS = {
  enableHp: true, hpThresholdPct: 50, drinkIntervalMs: 400, enableMp: false, mpThresholdPct: 50,
  inventoryFallback: false, healingOverTime: false, slotPriority: '1,2,3', excludedItems: '',
  diagnostics: false, strictSettingsVersion: 1,
};
export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'enableHp', label: 'Drink HP restoratives', type: 'boolean', value: true },
  { key: 'hpThresholdPct', label: 'HP threshold % (server-reported HP)', type: 'range', value: 50, min: 0, max: 95, step: 5,
    warnWhen: { pluginId: 'auto-nexus', key: 'ForceAutoNexusHealth', cmp: 'gte',
      message: 'Auto Nexus % is at or above Auto Drink % — you may nexus before a drink can heal you. Set Auto Nexus % below Auto Drink %.' } },
  { key: 'drinkIntervalMs', label: 'Minimum interval between drinks (ms, HP and MP shared)', type: 'number', value: 400, min: 400, max: 5000, step: 50 },
  { key: 'enableMp', label: 'Drink MP restoratives', advanced: true, type: 'boolean', value: false },
  { key: 'mpThresholdPct', label: 'MP threshold % (server-reported MP)', advanced: true, type: 'range', value: 50, min: 0, max: 95, step: 5 },
  { key: 'inventoryFallback', label: 'Use inventory when no eligible quickslot is available', advanced: true, type: 'boolean', value: false },
  { key: 'healingOverTime', label: 'Allow Healing-over-time consumables (no instant HP credit)', advanced: true, type: 'boolean', value: false },
  { key: 'slotPriority', label: 'Quickslot order (each of 1,2,3 exactly once)', advanced: true, type: 'text', value: '1,2,3' },
  { key: 'excludedItems', label: 'Excluded item IDs (comma-separated decimal or 0x hex)', advanced: true, type: 'text', value: '' },
  { key: 'diagnostics', label: 'Log worker status changes', advanced: true, type: 'boolean', value: false },
  { key: 'strictSettingsVersion', label: 'Strict settings version', hidden: true, type: 'number', value: 1, min: 1, max: 1, step: 1 },
];

export function validate(key: string, value: unknown): unknown {
  const fail = (): never => { throw new TypeError(`Invalid Auto Drink ${key}`); };
  const def = SETTING_DEFS.find(d => d.key === key);
  if (!def) return fail();
  if (def.type === 'boolean') return typeof value === 'boolean' ? value : fail();
  if (def.type === 'number' || def.type === 'range') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail();
    return Math.max(def.min!, Math.min(def.max!, key === 'drinkIntervalMs' ? Math.trunc(value) : value));
  }
  if (key === 'slotPriority') return parseSlotPriority(value)?.map(slot => slot + 1).join(',') ?? fail();
  if (key === 'excludedItems') return parseExcludedItems(value)?.join(',') ?? fail();
  return fail();
}

export function migrate(saved: unknown, _present: boolean): Record<string, unknown> {
  if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved))) throw new TypeError('Invalid Auto Drink settings');
  const input = { ...(saved ?? {}) } as Record<string, unknown>;
  if (!Object.hasOwn(input, 'drinkIntervalMs') && typeof input.drinkCooldownMs === 'number' && Number.isFinite(input.drinkCooldownMs)) {
    input.drinkIntervalMs = input.drinkCooldownMs;
  }
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, validate(key, Object.hasOwn(input, key) ? input[key] : value)]));
}

export function workerSettings(values: Record<string, unknown>, enabled: boolean): AutoDrinkSettings {
  const saved = migrate(values, true);
  return autoDrinkSettings({ enabled, enableHp: saved.enableHp as boolean, hpThresholdPct: saved.hpThresholdPct as number,
    enableMp: saved.enableMp as boolean, mpThresholdPct: saved.mpThresholdPct as number, intervalMs: saved.drinkIntervalMs as number,
    inventoryFallback: saved.inventoryFallback as boolean, healingOverTime: saved.healingOverTime as boolean,
    slotPriority: parseSlotPriority(saved.slotPriority)!, excludedItems: parseExcludedItems(saved.excludedItems)! });
}

/** UI order is one-based; controller order is a complete zero-based permutation. */
export function parseSlotPriority(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',').map(part => part.trim());
  if (parts.length !== 3 || parts.some(part => !/^[123]$/.test(part)) || new Set(parts).size !== 3) return null;
  return parts.map(part => Number(part) - 1);
}

/** Reject the entire malformed list so a typo cannot silently drop an exclusion. */
export function parseExcludedItems(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return [];
  const parts = value.split(',').map(part => part.trim());
  if (parts.some(part => !/^(?:0x[\da-f]+|\d+)$/i.test(part))) return null;
  const items = parts.map(Number);
  if (items.some(item => !Number.isSafeInteger(item) || item < 0 || item > 0x7fffffff)) return null;
  return [...new Set(items)];
}

