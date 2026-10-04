import { autoDrinkCatalog, autoDrinkSettings, type AutoDrinkItem, type AutoDrinkSettings, type AutoDrinkStatus } from '../../src/auto-drink/AutoDrinkTypes.ts';

export interface AutoDrinkConfig { settings: AutoDrinkSettings; items: AutoDrinkItem[] }
export type AutoDrinkEvent = { type: 'status'; status: AutoDrinkStatus; generation: number };

/** Validate both halves before callers mutate their live configuration. */
export function validateConfig(value: unknown): AutoDrinkConfig {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Auto Drink config');
  const config = value as AutoDrinkConfig;
  if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) throw new TypeError('Invalid Auto Drink settings');
  return { settings: autoDrinkSettings(config.settings), items: autoDrinkCatalog(config.items) };
}
