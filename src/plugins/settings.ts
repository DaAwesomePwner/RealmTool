import { log } from '../util/log.ts';
import type { SettingDef } from './api.ts';

/** Generic validation from the setting's declaration. Returns the value to store or throws. */
export function validateSetting(def: SettingDef, value: unknown): unknown {
  const fail = (): never => { throw new Error(`Invalid value for ${def.key}`); };
  switch (def.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : fail();
    case 'number':
    case 'range':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail();
      if (def.min !== undefined && (value as number) < def.min) fail();
      if (def.max !== undefined && (value as number) > def.max) fail();
      return value;
    case 'select':
      return typeof value === 'string' && (def.options ?? []).some(option => option.value === value) ? value : fail();
    case 'text':
      if (typeof value !== 'string') fail();
      if (def.maxLength !== undefined && (value as string).length > def.maxLength) fail();
      return value;
    default:
      return fail();
  }
}

type Validator = (key: string, value: unknown) => unknown;

/** One plugin's settings: declarations, current values and change callbacks. */
export class SettingsStore {
  private readonly defs = new Map<string, SettingDef>();
  private readonly values = new Map<string, unknown>();
  private readonly callbacks = new Map<string, ((value: any) => void)[]>();
  private readonly validator: Validator | undefined;
  private readonly onChange: (() => void) | undefined;

  constructor(validator?: Validator, onChange?: () => void) {
    this.validator = validator;
    this.onChange = onChange;
  }

  register(key: string, def: Omit<SettingDef, 'key'>, onChange?: (value: any) => void): void {
    if (this.defs.has(key)) throw new Error(`Setting ${key} is already registered`);
    this.defs.set(key, { ...def, key });
    if (def.type !== 'button') this.values.set(key, def.value);
    if (onChange) this.callbacks.set(key, [onChange]);
  }

  definition(key: string): SettingDef | undefined {
    return this.defs.get(key);
  }

  definitions(): SettingDef[] {
    return [...this.defs.values()].map(def => ({ ...def, value: def.type === 'button' ? undefined : this.values.get(def.key) }));
  }

  get<T = unknown>(key: string): T {
    return this.values.get(key) as T;
  }

  update(key: string, value: unknown): boolean {
    const def = this.defs.get(key);
    if (!def) return false;
    if (def.type === 'button') {
      this.fire(key, true);
      return true;
    }
    let next: unknown;
    try {
      next = this.validator ? this.validator(key, value) : validateSetting(def, value);
    } catch {
      return false;
    }
    this.values.set(key, next);
    this.fire(key, next);
    try {
      this.onChange?.();
    } catch (error) {
      log.error('Settings', 'Settings change listener failed', error);
    }
    return true;
  }

  /** Values a profile should save: everything except buttons and transient inputs. */
  persistable(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const def of this.defs.values()) {
      if (def.type === 'button' || def.transient) continue;
      out[def.key] = this.values.get(def.key);
    }
    return out;
  }

  private fire(key: string, value: unknown): void {
    for (const callback of this.callbacks.get(key) ?? []) {
      try {
        callback(value);
      } catch (error) {
        log.error('Settings', `Setting ${key} callback failed`, error);
      }
    }
  }
}
