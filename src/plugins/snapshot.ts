import type { SettingDef } from './api.ts';

export interface PluginSnapshot {
  id: string; name: string; category: string;
  enabled: boolean;
  /** Load/registration failure message; failed plugins have no settings or data. */
  failed: string | null;
  /** Current definitions, excluding hidden settings and including transient ones. */
  settings: SettingDef[];
  data: Record<string, unknown>;
}

/** Detached JSON data. Cycles/depth overflow become null; unsupported values are omitted. */
export function toJsonSafe(value: unknown): unknown {
  const ancestors = new Set<object>();
  function copy(input: unknown, depth: number): unknown {
    if (typeof input === 'string') return input.slice(0, 4000);
    if (typeof input === 'bigint') return String(input).slice(0, 4000);
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return undefined;
    if (depth >= 6 || ancestors.has(input)) return null;
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return input.map(item => copy(item, depth + 1)).filter(item => item !== undefined);
      return Object.fromEntries(Object.entries(input).flatMap(([key, item]) => {
        const next = copy(item, depth + 1);
        return next === undefined ? [] : [[key, next]];
      }));
    } finally { ancestors.delete(input); }
  }
  return copy(value, 0);
}
