// Adapted from realm-engine-client client/plugins/auto-nexus.ts @ 88a66b2 (MIT, see NOTICE).
import type { SettingDef } from '../../src/plugins/api.ts';

export const DEFAULTS = Object.freeze({
  PreHitPrediction: true,
  ForceAutoNexusHealth: 25,
  ShowChatMessageOnNexus: true,
  EscapeRetryCount: 4,
  EscapeRetryIntervalMs: 400,
});

export const SETTING_DEFS: readonly SettingDef[] = [
  { key: 'PreHitPrediction', label: 'Collision HP', type: 'boolean', value: DEFAULTS.PreHitPrediction },
  { key: 'ForceAutoNexusHealth', label: 'Nexus Health (0%: confirmed server zero only)', type: 'range', value: DEFAULTS.ForceAutoNexusHealth, min: 0, max: 100, step: 1 },
  { key: 'ShowChatMessageOnNexus', label: 'Show Chat Message on Nexus', advanced: true, type: 'boolean', value: DEFAULTS.ShowChatMessageOnNexus },
  { key: 'EscapeRetryCount', label: 'Escape Retries', advanced: true, type: 'range', value: DEFAULTS.EscapeRetryCount, min: 0, max: 10, step: 1 },
  { key: 'EscapeRetryIntervalMs', label: 'Escape Retry Interval', advanced: true, type: 'range', value: DEFAULTS.EscapeRetryIntervalMs, min: 100, max: 2000, step: 50 },
];

export function validate(key: string, value: unknown): unknown {
  const def = SETTING_DEFS.find(def => def.key === key);
  if (!def) throw new Error(`Unknown Auto Nexus setting: ${key}`);
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  const clamped = Math.max(def.min!, Math.min(def.max!, value));
  return key === 'EscapeRetryCount' ? Math.trunc(clamped) : clamped;
}

/** Startup replacement: validate all retained values before publishing any of them. */
export function migrate(saved: unknown, _present: boolean): Record<string, unknown> {
  if (saved === undefined) return { ...DEFAULTS };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Auto Nexus settings must be an object');
  const input = saved as Record<string, unknown>;
  return Object.fromEntries(SETTING_DEFS.map(def => [def.key,
    Object.hasOwn(input, def.key) ? validate(def.key, input[def.key]) : def.value]));
}
