// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { SettingDef } from '../../../src/plugins/api.ts';
import type { PluginSnapshot } from '../../../src/plugins/snapshot.ts';
import { SettingsView } from '../settings.ts';

const setting = (key: string, type: SettingDef['type'], value: unknown, extra: Partial<SettingDef> = {}): SettingDef => ({ key, label: key, type, value, ...extra });
const plugin = (settings: SettingDef[]): PluginSnapshot => ({ id: 'p', name: 'P', category: 'Utility', enabled: true, failed: null, settings, data: {} });
const sections = (root: Element) => [...root.querySelectorAll<HTMLElement>(':scope > .setting-group')].map(group => ({
  title: group.querySelector('h3')?.textContent ?? null,
  keys: [...group.querySelectorAll<HTMLElement>('.setting')].map(row => row.dataset.key),
}));

it('renders named groups, one unnamed section and grouped Advanced settings in registration order', () => {
  const defs = [
    setting('hideTrade', 'boolean', true, { group: 'What to hide' }), setting('loose', 'number', 1),
    setting('words', 'text', '', { group: 'Custom words', multiline: true }), setting('ads', 'boolean', true, { group: 'What to hide' }),
    setting('other', 'select', 'a', { options: [{ label: 'A', value: 'a' }] }),
    setting('debug', 'boolean', false, { advanced: true }), setting('trace', 'number', 2, { advanced: true, group: 'Diagnostics' }),
    setting('secret', 'text', '', { group: 'Custom words', hidden: true }),
  ];
  const p = plugin(defs); const view = new SettingsView(p, [p], async () => defs);
  expect(sections(view.element)).toEqual([
    { title: 'What to hide', keys: ['hideTrade', 'ads'] }, { title: null, keys: ['loose', 'other'] },
    { title: 'Custom words', keys: ['words'] },
  ]);
  const advanced = view.element.querySelector('details')!;
  expect(view.element.lastElementChild).toBe(advanced);
  expect(sections(advanced)).toEqual([{ title: null, keys: ['debug'] }, { title: 'Diagnostics', keys: ['trace'] }]);
  // Rows: label on the left, switch-style boolean, stacked multiline text.
  const toggle = view.element.querySelector<HTMLInputElement>('[data-key="hideTrade"] input')!;
  expect([toggle.type, toggle.getAttribute('role'), toggle.className]).toEqual(['checkbox', 'switch', 'switch']);
  expect(view.element.querySelector<HTMLLabelElement>('[data-key="hideTrade"] label')!.htmlFor).toBe(toggle.id);
  expect(view.element.querySelector('[data-key="words"]')!.classList.contains('setting-stack')).toBe(true);
});

it('hides a group, and an empty Advanced section, when all of its rows are hidden', () => {
  const defs = [
    setting('gate', 'boolean', false), setting('a', 'number', 1, { group: 'Gated', visibleWhen: { key: 'gate', value: true } }),
    setting('b', 'text', '', { group: 'Gated', visibleWhen: { key: 'gate', value: true } }),
    setting('c', 'number', 1, { advanced: true, group: 'Expert', visibleWhen: { key: 'gate', value: true } }),
  ];
  const p = plugin(defs); const view = new SettingsView(p, [p], async () => defs);
  const group = (name: string) => view.element.querySelector<HTMLElement>(`.setting-group[data-group="${name}"]`)!;
  expect(group('Gated').hidden).toBe(true); expect(group('Expert').hidden).toBe(true);
  expect(view.element.querySelector('details')!.hidden).toBe(true);
  const open = plugin([{ ...defs[0], value: true }, ...defs.slice(1)]);
  view.update(open, [open]);
  expect(group('Gated').hidden).toBe(false); expect(group('Expert').hidden).toBe(false);
  expect(view.element.querySelector('details')!.hidden).toBe(false);
  // A row that disappears from the snapshot counts as hidden too.
  const partial = plugin([{ ...defs[0], value: true }, defs[1]]);
  view.update(partial, [partial]);
  expect(group('Gated').hidden).toBe(false); expect(group('Expert').hidden).toBe(true);
  view.update(p, [p]); expect(group('Gated').hidden).toBe(true);
});
