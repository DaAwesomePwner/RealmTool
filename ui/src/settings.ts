import type { SettingDef } from '../../src/plugins/api.ts';
import type { PluginSnapshot } from '../../src/plugins/snapshot.ts';
import { el, message } from './dom.ts';
import { createField, type Field } from './settingField.ts';

type Save = (key: string, value: unknown) => Promise<SettingDef[]>;
interface Group { element: HTMLElement; fields: Field[] }

/** Settings as grouped rows: one box per `group`, ungrouped settings in one unnamed box; advanced ones inside "Advanced". */
export class SettingsView {
  readonly element = el('div', undefined, 'settings');
  private plugin: PluginSnapshot;
  private all: PluginSnapshot[];
  private readonly save: Save;
  private readonly fields = new Map<string, Field>();
  private readonly groups: Group[] = [];
  private readonly advanced = el('details', undefined, 'settings-advanced');
  private readonly advancedGroups: Group[] = [];
  private disposed = false;

  constructor(plugin: PluginSnapshot, all: PluginSnapshot[], save: Save) {
    this.plugin = plugin; this.all = all; this.save = save;
    this.advanced.append(el('summary', 'Advanced'));
    const main = new Map<string, Group>(), advanced = new Map<string, Group>();
    for (const def of plugin.settings.filter(def => !def.hidden)) {
      const field = createField(plugin.id, def, field => void this.submit(field));
      this.fields.set(def.key, field);
      const groups = def.advanced ? advanced : main;
      let group = groups.get(def.group ?? '');
      if (!group) {
        group = createGroup(def.group); groups.set(def.group ?? '', group);
        (def.advanced ? this.advancedGroups : this.groups).push(group);
        (def.advanced ? this.advanced : this.element).append(group.element);
      }
      group.fields.push(field); group.element.lastElementChild!.append(field.row);
    }
    if (this.advancedGroups.length) this.element.append(this.advanced);
    this.update(plugin, all);
  }

  private value(field: Field): unknown {
    if (field.def.type === 'button') return true;
    if (field.def.type === 'boolean') return (field.control as HTMLInputElement).checked;
    if (field.def.type === 'number' || field.def.type === 'range') return (field.control as HTMLInputElement).valueAsNumber;
    return field.control.value;
  }

  private restore(field: Field): void {
    if (field.def.type === 'boolean') (field.control as HTMLInputElement).checked = field.def.value === true;
    else if (field.def.type !== 'button') field.control.value = String(field.def.value ?? '');
    if (field.output) field.output.value = field.control.value;
  }

  private async submit(field: Field): Promise<void> {
    if (this.disposed || field.pending || !field.dirty) return;
    field.dirty = false; field.pending = true; field.control.disabled = true; field.error.textContent = '';
    try {
      const settings = await this.save(field.def.key, this.value(field));
      if (this.disposed) return;
      this.plugin = { ...this.plugin, settings };
      const current = settings.find(def => def.key === field.def.key);
      if (current) field.def = current;
    } catch (error) { field.error.textContent = message(error); }
    finally {
      field.pending = false;
      this.restore(field);
      this.update(this.plugin, this.all);
    }
  }

  update(plugin: PluginSnapshot, all: PluginSnapshot[]): void {
    this.plugin = plugin; this.all = all;
    for (const field of this.fields.values()) {
      const def = plugin.settings.find(def => def.key === field.def.key);
      if (!def) { field.row.hidden = true; continue; }
      field.def = def;
      field.row.hidden = !!def.hidden || (!!def.visibleWhen && !Object.is(plugin.settings.find(s => s.key === def.visibleWhen!.key)?.value, def.visibleWhen.value));
      field.control.disabled = field.pending || !!plugin.failed || (def.type === 'button' && !plugin.enabled);
      if (!field.dirty && !field.pending) this.restore(field);
      const rule = def.warnWhen;
      const target = rule?.pluginId ? all.find(p => p.id === rule.pluginId) : plugin;
      const other = target?.settings.find(s => s.key === rule?.key);
      field.warning.hidden = !rule || !other || !compare(other.value, def.value, rule.cmp);
    }
    // A box whose rows are all hidden disappears with them, and so does an empty Advanced section.
    for (const group of [...this.groups, ...this.advancedGroups]) group.element.hidden = group.fields.every(field => field.row.hidden);
    this.advanced.hidden = this.advancedGroups.every(group => group.element.hidden);
  }

  cancelDrafts(): void {
    for (const field of this.fields.values()) {
      clearTimeout(field.timer); field.timer = undefined; field.dirty = false;
      if (!field.pending) this.restore(field);
    }
  }

  dispose(): void { this.disposed = true; this.cancelDrafts(); }
}

function compare(a: unknown, b: unknown, cmp: NonNullable<SettingDef['warnWhen']>['cmp']): boolean {
  if (cmp === 'eq') return Object.is(a, b);
  if (cmp === 'neq') return !Object.is(a, b);
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return cmp === 'gt' ? a > b : cmp === 'gte' ? a >= b : cmp === 'lt' ? a < b : a <= b;
}

function createGroup(name: string | undefined): Group {
  const element = el('section', undefined, 'setting-group');
  if (name) element.append(el('h3', name, 'setting-group-title'));
  element.dataset.group = name ?? '';
  element.append(el('div', undefined, 'setting-rows'));
  return { element, fields: [] };
}
