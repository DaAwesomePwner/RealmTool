import { autoDrinkCatalog, autoDrinkSettings, type AutoDrinkItem, type AutoDrinkSettings, type AutoDrinkStatus } from '../../src/auto-drink/AutoDrinkTypes.ts';

export interface AutoDrinkConfig {
  settings: AutoDrinkSettings;
  items: AutoDrinkItem[];
  gameBuild: string | null;
  gameDir: string | null;
}
export type AutoDrinkEvent = { type: 'status'; status: AutoDrinkStatus; generation: number };

/** Validate the whole message before callers mutate their live configuration. */
export function validateConfig(value: unknown): AutoDrinkConfig {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid Auto Drink config');
  const config = value as AutoDrinkConfig;
  if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) throw new TypeError('Invalid Auto Drink settings');
  for (const key of ['gameBuild', 'gameDir'] as const) {
    const field = config[key];
    if (field !== null && (typeof field !== 'string' || !field.trim() || field.includes('\0'))) {
      throw new TypeError(`Invalid Auto Drink ${key}`);
    }
  }
  return { settings: autoDrinkSettings(config.settings), items: autoDrinkCatalog(config.items),
    gameBuild: config.gameBuild, gameDir: config.gameDir };
}
