import type { SettingDef } from '../../src/plugins/api.ts';
import { el } from './dom.ts';

export type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
export interface Field {
  def: SettingDef; row: HTMLElement; control: Control; error: HTMLElement; warning: HTMLElement;
  output?: HTMLOutputElement; dirty: boolean; pending: boolean; timer?: ReturnType<typeof setTimeout>;
}

function createControl(def: SettingDef): Control {
  if (def.type === 'select') {
    const control = el('select');
    for (const option of def.options ?? []) { const node = el('option', option.label); node.value = option.value; control.append(node); }
    return control;
  }
  if (def.type === 'button') { const control = el('button', def.label); control.type = 'button'; return control; }
  if (def.type === 'text' && def.multiline) { const control = el('textarea'); control.rows = def.rows ?? 3; return control; }
  const control = el('input'); control.type = def.type === 'boolean' ? 'checkbox' : def.type;
  if (def.type === 'boolean') { control.className = 'switch'; control.setAttribute('role', 'switch'); }
  if (def.type === 'number' || def.type === 'range') {
    if (def.min !== undefined) control.min = String(def.min);
    if (def.max !== undefined) control.max = String(def.max);
    control.step = def.step === undefined ? 'any' : String(def.step);
  }
  return control;
}

/**
 * One setting row: label and help on the left, the control on the right.
 * Multiline text and ranges stack the control under the label; buttons put the button first.
 */
export function createField(pluginId: string, def: SettingDef, submit: (field: Field) => void): Field {
  const stack = def.type === 'range' || (def.type === 'text' && !!def.multiline);
  const row = el('div', undefined, `setting setting-${def.type}${stack ? ' setting-stack' : ''}`); row.dataset.key = def.key;
  const control = createControl(def);
  if (def.maxLength !== undefined && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) control.maxLength = def.maxLength;
  const id = `setting-${encodeURIComponent(pluginId)}-${encodeURIComponent(def.key)}`;
  control.id = id;
  const text = el('div', undefined, 'setting-text');
  if (def.type !== 'button') { const label = el('label', def.label, 'setting-label'); label.htmlFor = id; text.append(label); }
  let output: HTMLOutputElement | undefined;
  if (def.type === 'range') { output = el('output', undefined, 'setting-output'); output.setAttribute('for', id); text.append(output); }
  const description = el('div', undefined, 'help'); description.id = `${id}-help`;
  if (def.help) description.append(el('p', def.help));
  if (def.transient) description.append(el('span', 'Not saved', 'transient'));
  const warning = el('p', def.warnWhen?.message ?? '', 'warning');
  const error = el('p', '', 'error'); error.setAttribute('role', 'alert');
  description.append(warning, error); control.setAttribute('aria-describedby', description.id);
  if (stack) row.append(text, control, description);
  else if (def.type === 'button') row.append(control, description);
  else { text.append(description); row.append(text, control); }
  const field: Field = { def, row, control, output, error, warning, dirty: false, pending: false };
  const flush = () => { clearTimeout(field.timer); field.timer = undefined; submit(field); };
  if (def.type === 'button') control.addEventListener('click', () => { field.dirty = true; flush(); });
  else {
    control.addEventListener('input', () => {
      field.dirty = true;
      if (output) output.value = control.value;
      if (def.type === 'text') { clearTimeout(field.timer); field.timer = setTimeout(flush, 300); }
    });
    control.addEventListener('change', () => { field.dirty = true; flush(); });
    control.addEventListener('blur', flush);
  }
  return field;
}
