// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginSnapshot } from '../../../src/plugins/snapshot.ts';
import { PluginCards } from '../plugins.ts';

const plugin = (id: string, enabled: boolean, failed: string | null = null): PluginSnapshot =>
  ({ id, name: id.toUpperCase(), category: 'Utility', enabled, failed, settings: [], data: {} });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function setup(post: (path: string, body: unknown) => Promise<unknown>, get: () => Promise<PluginSnapshot[]>) {
  const changed = vi.fn();
  const cards = new PluginCards({ post: vi.fn(post) as never, get: vi.fn(get) as never }, changed);
  document.body.append(cards.element);
  cards.update([plugin('a', true), plugin('b', false)]);
  const item = (id: string) => cards.element.querySelectorAll<HTMLElement>('.plugin-item')[id === 'a' ? 0 : 1];
  const listSwitch = (id: string) => item(id).querySelector<HTMLInputElement>('input.switch')!;
  const card = (id: string) => cards.element.querySelectorAll<HTMLElement>('.plugin-card')[id === 'a' ? 0 : 1];
  const detailSwitch = (id: string) => card(id).querySelector<HTMLInputElement>('.card-heading input')!;
  return { cards, changed, item, listSwitch, card, detailSwitch };
}

it('keeps the select button and the switch as sibling controls with switch semantics', () => {
  const { item, listSwitch, detailSwitch, card } = setup(async () => ({}), async () => []);
  const link = item('a').querySelector('.plugin-link')!;
  expect(link.querySelector('input, button')).toBeNull(); expect(listSwitch('a').closest('button')).toBeNull();
  expect(listSwitch('a').parentElement).toBe(link.parentElement);
  expect(listSwitch('a').getAttribute('role')).toBe('switch'); expect(listSwitch('a').getAttribute('aria-label')).toBe('Enable A');
  expect(detailSwitch('a').getAttribute('role')).toBe('switch');
  expect(card('a').querySelector('.tag')!.textContent).toBe('Utility');
  expect(item('b').dataset.state).toBe('off');
});

it('enables a plugin from the list without changing the selection and syncs the detail switch', async () => {
  let release!: () => void;
  const posted = new Promise<void>(resolve => { release = resolve; });
  const { cards, changed, item, listSwitch, card, detailSwitch } = setup(
    async () => { await posted; return {}; }, async () => [plugin('a', true), plugin('b', true)]);
  listSwitch('b').checked = true; listSwitch('b').dispatchEvent(new Event('change'));
  // Pending: both switches show the request and are disabled; the selection stays on A.
  expect(detailSwitch('b').checked).toBe(true);
  expect([listSwitch('b').disabled, detailSwitch('b').disabled]).toEqual([true, true]);
  cards.update([plugin('a', true), plugin('b', false)]);
  expect([listSwitch('b').checked, listSwitch('b').disabled]).toEqual([true, true]);
  release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect([listSwitch('b').checked, detailSwitch('b').checked]).toEqual([true, true]);
  expect([listSwitch('b').disabled, detailSwitch('b').disabled]).toEqual([false, false]);
  expect(item('b').dataset.state).toBe('on');
  expect(item('a').querySelector('.plugin-link')!.getAttribute('aria-current')).toBe('true');
  expect(card('a').hidden).toBe(false); expect(card('b').hidden).toBe(true);
});

it('sends the same request from both switches and rolls both back with the error on failure', async () => {
  const post = vi.fn(async () => { throw new Error('Plugin is busy'); });
  const { listSwitch, detailSwitch, item, card, cards } = setup(post, async () => []);
  detailSwitch('a').checked = false; detailSwitch('a').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(listSwitch('a').disabled).toBe(false));
  expect([listSwitch('a').checked, detailSwitch('a').checked]).toEqual([true, true]);
  expect(item('a').querySelector('[role="alert"]')!.textContent).toBe('Plugin is busy');
  expect(card('a').textContent).toContain('Plugin is busy');
  listSwitch('a').checked = false; listSwitch('a').dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
  expect(post.mock.calls[0]).toEqual(['/api/plugins/a/enabled', { enabled: false }]);
  await vi.waitFor(() => expect(listSwitch('a').disabled).toBe(false));
  expect([listSwitch('a').checked, detailSwitch('a').checked]).toEqual([true, true]);
  cards.update([plugin('a', true, 'crashed'), plugin('b', false)]);
  expect([listSwitch('a').disabled, detailSwitch('a').disabled]).toEqual([true, true]);
  expect(item('a').querySelector('.plugin-state')!.textContent).toBe('Failed');
});

it('keeps a rebuilt card disabled with the requested value until the pending request settles', async () => {
  let release!: () => void;
  const post = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; });
  const { cards, changed, listSwitch, detailSwitch } = setup(post, async () => [plugin('a', true), plugin('b', true)]);
  listSwitch('b').checked = true; listSwitch('b').dispatchEvent(new Event('change'));
  const old = listSwitch('b');
  // A new settings signature rebuilds B's card while its enable request is in flight.
  cards.update([plugin('a', true), { ...plugin('b', false), settings: [{ key: 'x', label: 'X', type: 'boolean', value: false }] }]);
  expect(listSwitch('b')).not.toBe(old);
  expect([listSwitch('b').checked, detailSwitch('b').checked]).toEqual([true, true]);
  expect([listSwitch('b').disabled, detailSwitch('b').disabled]).toEqual([true, true]);
  listSwitch('b').checked = false; listSwitch('b').dispatchEvent(new Event('change'));
  expect(post).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect([listSwitch('b').checked, listSwitch('b').disabled, detailSwitch('b').disabled]).toEqual([true, false, false]);
});

it('keeps focus on a list switch and a setting control across an update with unchanged order', () => {
  const { cards, listSwitch, card } = setup(async () => ({}), async () => []);
  const withSetting = (enabled: boolean) => [{ ...plugin('a', enabled), settings: [{ key: 'n', label: 'N', type: 'number' as const, value: 1 }] }, plugin('b', false)];
  cards.update(withSetting(true));
  listSwitch('b').focus(); expect(document.activeElement).toBe(listSwitch('b'));
  cards.update(withSetting(true)); cards.update(withSetting(false));
  expect(document.activeElement).toBe(listSwitch('b'));
  const input = card('a').querySelector<HTMLInputElement>('[data-key="n"] input')!;
  input.focus(); cards.update(withSetting(true));
  expect(document.activeElement).toBe(input);
  // A real reorder still moves the nodes into snapshot order.
  cards.update([...withSetting(true)].reverse());
  expect([...cards.element.querySelectorAll('.plugin-link-name')].map(n => n.textContent)).toEqual(['B', 'A']);
  expect([...cards.element.querySelectorAll('.plugin-card h2')].map(n => n.textContent)).toEqual(['B', 'A']);
});

it('gives the list and detail switches distinct accessible names from visible text', () => {
  const { listSwitch, detailSwitch } = setup(async () => ({}), async () => []);
  expect(listSwitch('a').getAttribute('aria-label')).toBe('Enable A');
  expect(detailSwitch('a').hasAttribute('aria-label')).toBe(false);
  const name = detailSwitch('a').getAttribute('aria-labelledby')!.split(' ').map(id => document.getElementById(id)!.textContent).join(' ');
  expect(name).toBe('Enabled A');
});
