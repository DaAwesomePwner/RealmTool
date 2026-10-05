// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingDef } from '../../../src/plugins/api.ts';
import type { PluginSnapshot } from '../../../src/plugins/snapshot.ts';
import { SettingsView } from '../settings.ts';
import { PluginCards } from '../plugins.ts';
import { LogPanel } from '../logs.ts';
import { ProfilePicker } from '../profiles.ts';

const plugin = (settings: SettingDef[], id = 'test'): PluginSnapshot => ({
  id, name: '<img onerror="alert(1)">', category: 'Utility', enabled: true, failed: null, settings, data: {},
});
const setting = (key: string, type: SettingDef['type'], value: unknown, extra = {}): SettingDef => ({ key, label: key, type, value, ...extra });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('schema settings', () => {
  it('renders every type and presentation metadata, including hidden, advanced and transient', () => {
    const definitions = [
      setting('amount', 'number', 12, { min: 2, max: 20, step: 2, help: 'Helpful text' }),
      setting('threshold', 'range', 50, { min: 0, max: 100, step: 5 }),
      setting('enabled', 'boolean', true),
      setting('mode', 'select', 'b', { options: [{ label: 'Alpha', value: 'a' }, { label: 'Beta', value: 'b' }] }),
      setting('single', 'text', 'hello', { maxLength: 100, transient: true }),
      setting('multi', 'text', 'one\ntwo', { multiline: true, rows: 4, maxLength: 100500 }),
      setting('action', 'button', false), setting('expert', 'number', 3, { advanced: true }),
      setting('secret', 'text', 'hidden', { hidden: true }),
    ];
    const p = plugin(definitions);
    const view = new SettingsView(p, [p], async () => definitions);
    document.body.append(view.element);
    const number = view.element.querySelector<HTMLInputElement>('[data-key="amount"] input')!;
    expect([number.type, number.value, number.min, number.max, number.step]).toEqual(['number', '12', '2', '20', '2']);
    expect(view.element.textContent).toContain('Helpful text');
    const range = view.element.querySelector<HTMLInputElement>('[type="range"]')!;
    expect([range.value, range.min, range.max, range.step]).toEqual(['50', '0', '100', '5']);
    expect(view.element.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(true);
    const select = view.element.querySelector('select')!;
    expect(select.value).toBe('b'); expect(select.options[0].textContent).toBe('Alpha');
    expect(view.element.querySelector<HTMLInputElement>('[data-key="single"] input')!.maxLength).toBe(100);
    expect(view.element.querySelector('textarea')!.getAttribute('rows')).toBe('4');
    expect(view.element.querySelector('textarea')!.maxLength).toBe(100500);
    expect(view.element.querySelector('textarea')!.value).toBe('one\ntwo');
    expect(view.element.querySelector('[data-key="action"] button')!.textContent).toBe('action');
    expect(view.element.querySelector('details [data-key="expert"]')).not.toBeNull();
    expect(view.element.querySelector('[data-key="secret"]')).toBeNull();
    expect(view.element.textContent).toContain('Not saved');
  });

  it('updates visibleWhen and cross-plugin warnWhen from server snapshots', () => {
    const defs = [setting('gate', 'boolean', false), setting('dependent', 'text', '', { visibleWhen: { key: 'gate', value: true } }),
      setting('hp', 'range', 50, { warnWhen: { pluginId: 'nexus', key: 'hp', cmp: 'gte', message: 'Nexus happens first' } })];
    const p = plugin(defs); const other = plugin([setting('hp', 'number', 60)], 'nexus');
    const view = new SettingsView(p, [p, other], async () => defs);
    expect(view.element.querySelector<HTMLElement>('[data-key="dependent"]')!.hidden).toBe(true);
    expect(view.element.textContent).toContain('Nexus happens first');
    const changed = plugin([{ ...defs[0], value: true }, ...defs.slice(1)]);
    view.update(changed, [changed, plugin([setting('hp', 'number', 20)], 'nexus')]);
    expect(view.element.querySelector<HTMLElement>('[data-key="dependent"]')!.hidden).toBe(false);
    expect(view.element.querySelector<HTMLElement>('.warning')!.hidden).toBe(true);
  });

  it('restores rejected server values with the backend message; displays accepted clamped values', async () => {
    const defs = [setting('amount', 'number', 10)]; const p = plugin(defs);
    const save = vi.fn().mockRejectedValueOnce(new Error('Must be an integer')).mockResolvedValueOnce([setting('amount', 'number', 100)]);
    const view = new SettingsView(p, [p], save); document.body.append(view.element);
    const input = view.element.querySelector('input')!;
    input.value = '10.5'; input.dispatchEvent(new Event('change')); await flush();
    expect(input.value).toBe('10'); expect(view.element.textContent).toContain('Must be an integer');
    input.value = '200'; input.dispatchEvent(new Event('change')); await flush();
    expect(save).toHaveBeenLastCalledWith('amount', 200); expect(input.value).toBe('100');
  });

  it('debounces text, flushes on blur, sends true for buttons and disables buttons on disabled plugins', async () => {
    vi.useFakeTimers();
    const defs = [setting('text', 'text', ''), setting('action', 'button', false)]; const p = plugin(defs);
    const save = vi.fn().mockResolvedValue(defs); const view = new SettingsView(p, [p], save);
    const input = view.element.querySelector('input')!;
    input.value = 'a'; input.dispatchEvent(new Event('input'));
    input.value = 'ab'; input.dispatchEvent(new Event('input'));
    expect(save).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(350);
    expect(save).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledWith('text', 'ab');
    input.value = 'abc'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(350); expect(save).toHaveBeenCalledTimes(2);
    view.element.querySelector('button')!.click(); await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenLastCalledWith('action', true);
    view.update({ ...p, enabled: false }, [p]); expect(view.element.querySelector('button')!.disabled).toBe(true);
    view.dispose();
  });
});

it('renders plugin names, failures and status as text', () => {
  const api = { post: vi.fn(), get: vi.fn() };
  const cards = new PluginCards(api, () => {});
  cards.update([{ ...plugin([]), failed: '<img onerror="bad">', data: { status: { state: 'Waiting' }, recent: ['<img onerror="bad">'] } }]);
  expect(cards.element.querySelector('img')).toBeNull();
  expect(cards.element.textContent).toContain('<img onerror=');
  expect(cards.element.textContent).toContain('Waiting');
});

it('renders Chat Filter status.recent as text entries without duplicating them in generic status', () => {
  const cards = new PluginCards({ post: vi.fn(), get: vi.fn() }, () => {});
  const status = {
    counts: { advertising: 1, 'blocked-sender': 1 },
    recent: [
      { sender: '<img onerror="sender">', reason: 'advertising', ruleId: 'shop', message: '<img onerror="body">' },
      { sender: 'MutedPlayer', reason: 'blocked-sender' },
    ],
    preview: null, actionResult: '', conflicts: [], mutes: [],
  };
  cards.update([{ ...plugin([], 'chat-filter'), name: 'Chat Filter', data: { status } }]);
  const rows = cards.element.querySelectorAll('.plugin-status li');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain('<img onerror="sender">');
  expect(rows[0].textContent).toContain('advertising');
  expect(rows[0].textContent).toContain('<img onerror="body">');
  expect(rows[1].textContent).toContain('MutedPlayer');
  expect(rows[1].textContent).toContain('blocked-sender');
  expect(rows[1].textContent).not.toMatch(/undefined|null/);
  expect(cards.element.querySelector('img')).toBeNull();
  expect([...cards.element.querySelectorAll('dt')].map(node => node.textContent)).toEqual(['counts', 'preview', 'actionResult', 'conflicts', 'mutes']);
  expect(cards.element.querySelector('dl')!.textContent).not.toContain('MutedPlayer');
  // Optional channel/verdict metadata is displayed when supplied, never inferred.
  cards.data('chat-filter', 'chatFilterStatus', { ...status, recent: [{ sender: 'Player', channel: 'whisper', verdict: 'block', reason: 'advertising', message: 'Captured text' }] });
  expect(cards.element.querySelector('li')!.textContent).toContain('whisper');
  expect(cards.element.querySelector('li')!.textContent).toContain('block');
  expect(cards.element.querySelector('li')!.textContent).toContain('Captured text');
});

it('merges out-of-order log history by sequence without advancing beyond merged records', () => {
  const logs = new LogPanel();
  const record = (seq: number) => ({ seq, at: 0, level: 'info' as const, module: 'test', message: String(seq) });
  logs.add(record(1020));
  logs.merge(Array.from({ length: 1019 }, (_, index) => record(1019 - index)));
  logs.merge([record(1019), record(1020)]);
  const sequences = [...logs.rows.children].map(row => Number((row as HTMLElement).dataset.seq));
  expect(sequences).toEqual(Array.from({ length: 1000 }, (_, index) => index + 21));
  expect(logs.next).toBe(1020);
  logs.merge([]); expect(logs.next).toBe(1020);
});

it('caps logs at 1000, renders text, filters levels, and pauses autoscroll until the user returns to the bottom', () => {
  const logs = new LogPanel(); document.body.append(logs.element);
  Object.defineProperties(logs.rows, { scrollHeight: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 100 } });
  logs.add({ seq: 1, at: 0, level: 'info', module: 'test', message: '<img onerror="bad">' });
  expect(logs.rows.scrollTop).toBe(400); expect(logs.rows.querySelector('img')).toBeNull();
  expect(logs.rows.textContent).toContain('<img onerror=');
  logs.rows.scrollTop = 25; logs.rows.dispatchEvent(new Event('scroll'));
  for (let seq = 2; seq <= 1002; seq++) logs.add({ seq, at: 0, level: seq === 1002 ? 'error' : 'info', module: 'test', message: String(seq) });
  expect(logs.rows.children.length).toBe(1000); expect(logs.rows.scrollTop).toBe(25);
  logs.filter.value = 'error'; logs.filter.dispatchEvent(new Event('change'));
  expect(logs.rows.children.length).toBe(1);
  logs.rows.scrollTop = 300; logs.rows.dispatchEvent(new Event('scroll'));
  logs.add({ seq: 1003, at: 0, level: 'error', module: 'test', message: 'last' });
  expect(logs.rows.scrollTop).toBe(400);
});

it('confirms profile switching only when connected and restores selection on cancellation', async () => {
  const api = { post: vi.fn().mockResolvedValue({}), del: vi.fn() };
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  const picker = new ProfilePicker(api, () => {}, confirm);
  picker.update({ active: 'default', available: ['default', 'other'] }, 1);
  picker.select.value = 'other'; picker.select.dispatchEvent(new Event('change')); await flush();
  expect(confirm).toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled(); expect(picker.select.value).toBe('default');
  picker.select.value = 'other'; picker.select.dispatchEvent(new Event('change')); await flush();
  expect(api.post).toHaveBeenCalledWith('/api/profiles/select', { name: 'other' });
  picker.update({ active: 'default', available: ['default', 'other'] }, 0);
  picker.select.value = 'other'; picker.select.dispatchEvent(new Event('change')); await flush();
  expect(confirm).toHaveBeenCalledTimes(2);
});

it('waits for in-flight setting saves before selecting another profile', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const api = { post: vi.fn().mockResolvedValue({}), del: vi.fn() };
  const picker = new ProfilePicker(api, () => {}, () => true, () => pending);
  picker.update({ active: 'default', available: ['default', 'other'] }, 0);
  picker.select.value = 'other'; picker.select.dispatchEvent(new Event('change')); await flush();
  expect(api.post).not.toHaveBeenCalled();
  release(); await flush(); expect(api.post).toHaveBeenCalledWith('/api/profiles/select', { name: 'other' });
});
