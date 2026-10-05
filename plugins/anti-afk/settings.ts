import type { SettingDef } from '../../src/plugins/api.ts';

export const SETTING_DEFS: SettingDef[] = [{
  key: 'idleMinutes', type: 'number', label: 'Click the game after this many minutes without activity',
  min: 1, max: 15, step: 1, value: 5,
  help: "Exalt disconnects after about 20 minutes without input. The click shoots toward your cursor and is skipped while the cursor is over the game's buttons or panels.",
}];

export function validate(key: string, value: unknown): number {
  if (key !== 'idleMinutes' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid Anti-AFK ${key}`);
  }
  return Math.max(1, Math.min(15, Math.trunc(value)));
}
