import type { SettingDef } from '../../src/plugins/api.ts';
import type { PluginSnapshot } from '../../src/plugins/snapshot.ts';
import { el, message } from './dom.ts';

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
interface Field {
  def: SettingDef; row: HTMLElement; control: Control; error: HTMLElement; warning: HTMLElement;
  output?: HTMLOutputElement; dirty: boolean; pending: boolean; timer?: ReturnType<typeof setTimeout>;
}
type Save = (key: string, value: unknown) => Promise<SettingDef[]>;

export class SettingsView {
  readonly element = el('div', undefined, 'settings');
  private plugin: PluginSnapshot;
  private all: PluginSnapshot[];
  private readonly save: Save;
  private readonly fields = new Map<string, Field>();
  private disposed = false;

  constructor(plugin: PluginSnapshot, all: PluginSnapshot[], save: Save) {
    this.plugin = plugin; this.all = all; this.save = save;
    const advanced = el('details'); advanced.append(el('summary', 'Advanced'));
    for (const def of plugin.settings.filter(def => !def.hidden)) {
      const field = this.createField(def);
      this.fields.set(def.key, field);
      (def.advanced ? advanced : this.element).append(field.row);
    }
    if (advanced.children.length > 1) this.element.append(advanced);
    this.update(plugin, all);
  }

  private createField(def: SettingDef): Field {
    const row = el('div', undefined, 'setting'); row.dataset.key = def.key;
    const label = el('label'); const title = el('span', def.label, 'setting-label');
    let control: Control;
    if (def.type === 'select') {
      control = el('select');
      for (const option of def.options ?? []) { const node = el('option', option.label); node.value = option.value; control.append(node); }
    } else if (def.type === 'button') {
      control = el('button', def.label); control.type = 'button';
    } else if (def.type === 'text' && def.multiline) {
      control = el('textarea'); control.rows = def.rows ?? 3;
    } else {
      control = el('input'); control.type = def.type === 'boolean' ? 'checkbox' : def.type;
      if (def.type === 'number' || def.type === 'range') {
        if (def.min !== undefined) control.min = String(def.min);
        if (def.max !== undefined) control.max = String(def.max);
        control.step = def.step === undefined ? 'any' : String(def.step);
      }
    }
    if (def.maxLength !== undefined && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) control.maxLength = def.maxLength;
    const id = `setting-${encodeURIComponent(this.plugin.id)}-${encodeURIComponent(def.key)}`;
    control.id = id;
    label.htmlFor = id;
    if (def.type !== 'button') label.append(title);
    label.append(control); row.append(label);
    let output: HTMLOutputElement | undefined;
    if (def.type === 'range') { output = el('output'); output.setAttribute('for', id); label.append(output); }
    const description = el('div', undefined, 'help'); description.id = `${id}-help`;
    if (def.help) description.append(el('p', def.help));
    if (def.transient) description.append(el('span', 'Not saved'));
    const warning = el('p', def.warnWhen?.message ?? '', 'warning');
    const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
    description.append(warning, error); row.append(description); control.setAttribute('aria-describedby', description.id);
    const field: Field = { def, row, control, output, error, warning, dirty: false, pending: false };
    const submit = () => { clearTimeout(field.timer); field.timer = undefined; void this.submit(field); };
    if (def.type === 'button') control.addEventListener('click', () => { field.dirty = true; submit(); });
    else {
      control.addEventListener('input', () => {
        field.dirty = true;
        if (output) output.value = control.value;
        if (def.type === 'text') { clearTimeout(field.timer); field.timer = setTimeout(submit, 300); }
      });
      control.addEventListener('change', () => { field.dirty = true; submit(); });
      control.addEventListener('blur', submit);
    }
    return field;
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
