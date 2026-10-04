// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { Readiness } from '../readiness.ts';
import type { AppState } from '../api.ts';
import { PluginCards } from '../plugins.ts';

it('shows the stopped/failed recovery path and honest helper/session state', async () => {
  const state: AppState = {
    proxy: { state: 'failed', port: null, error: 'Select a game folder' },
    game: { dir: null, candidates: ['C:\\Games\\Exalt'], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
  };
  const api = { post: vi.fn().mockResolvedValue(state), get: vi.fn() };
  const changed = vi.fn(); const view = new Readiness(api, changed); view.update(state);
  expect(view.element.textContent).toContain('Select a game folder');
  expect(view.element.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
  const buttons = [...view.element.querySelectorAll('button')];
  const start = buttons.find(button => button.textContent === 'Start proxy')!;
  expect(start.disabled).toBe(false); start.click(); await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledWith('/api/proxy/start', {});
  view.update({ ...state, proxy: { state: 'running', port: 2050, error: null }, game: { ...state.game, dir: 'C:\\Games\\Exalt', helper: { state: 'installed', backup: true } } });
  expect(buttons.find(button => button.textContent === 'Uninstall helper')!.disabled).toBe(true);
  expect(view.element.textContent).toContain('0 connected / 0 open');
  expect(view.element.textContent).toContain('installed');
  const cards = new PluginCards(api, changed); cards.update([]);
  expect(cards.element.textContent).toBe('Start the proxy to view and edit plugin settings');
});
