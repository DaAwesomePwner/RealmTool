// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { Tabs } from '../tabs.ts';
import { PluginCards } from '../plugins.ts';

afterEach(() => { document.body.replaceChildren(); });

const panels = () => ['one', 'two', 'three'].map(id => ({ id, label: id.toUpperCase(), panel: document.createElement('div') }));

it('shows one panel at a time, honours the initial tab and moves with arrow, Home and End keys', () => {
  const defs = panels(); const tabs = new Tabs(defs, 'two'); document.body.append(tabs.element);
  const onSelect = vi.fn(); tabs.onSelect = onSelect;
  const tab = (id: string) => tabs.element.querySelector<HTMLButtonElement>(`#tab-${id}`)!;
  expect(defs.map(d => d.panel.hidden)).toEqual([true, false, true]);
  expect(tab('two').getAttribute('aria-selected')).toBe('true'); expect(tab('two').tabIndex).toBe(0); expect(tab('one').tabIndex).toBe(-1);
  expect(defs[1].panel.getAttribute('aria-labelledby')).toBe('tab-two');
  tab('three').click(); expect(tabs.active).toBe('three'); expect(onSelect).toHaveBeenLastCalledWith('three');
  tab('three').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); expect(tabs.active).toBe('one');
  expect(document.activeElement).toBe(tab('one'));
  tab('one').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })); expect(tabs.active).toBe('three');
  tab('three').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })); expect(tabs.active).toBe('one');
  tab('one').dispatchEvent(new KeyboardEvent('keydown', { key: 'End' })); expect(tabs.active).toBe('three');
  expect(new Tabs(panels(), 'missing').active).toBe('one');
});

it('shows and clears tab badges', () => {
  const tabs = new Tabs(panels());
  const badge = tabs.element.querySelector<HTMLElement>('#tab-two .tab-badge')!;
  expect(badge.hidden).toBe(true);
  tabs.badge('two', '3', '3 new warnings'); expect(badge.hidden).toBe(false);
  expect(badge.textContent).toBe('3'); expect(badge.getAttribute('aria-label')).toBe('3 new warnings');
  tabs.badge('two', ''); expect(badge.hidden).toBe(true); expect(badge.hasAttribute('aria-label')).toBe(false);
});

it('lists plugins beside one visible card and keeps the selection across updates', () => {
  const cards = new PluginCards({ post: vi.fn(), get: vi.fn() }, () => {});
  const plugin = (id: string, enabled = true, failed: string | null = null) =>
    ({ id, name: id.toUpperCase(), category: 'utility', enabled, failed, settings: [], data: {} });
  cards.update([plugin('a'), plugin('b', false), plugin('c', true, 'broken')]);
  const links = () => [...cards.element.querySelectorAll<HTMLButtonElement>('.plugin-link')];
  const visible = () => [...cards.element.querySelectorAll<HTMLElement>('.plugin-card')].filter(card => !card.hidden).map(card => card.querySelector('h2')!.textContent);
  expect(links().map(link => link.textContent)).toEqual(['AOn', 'BOff', 'CFailed']);
  expect(visible()).toEqual(['A']); expect(links()[0].getAttribute('aria-current')).toBe('true');
  links()[1].click(); expect(visible()).toEqual(['B']); expect(links()[0].hasAttribute('aria-current')).toBe(false);
  cards.update([]); expect(cards.element.querySelector<HTMLElement>('.plugin-nav')!.hidden).toBe(true);
  cards.update([plugin('a'), plugin('b')]); expect(visible()).toEqual(['B']);
  cards.update([plugin('a')]); expect(visible()).toEqual(['A']); expect(links()).toHaveLength(1);
});
