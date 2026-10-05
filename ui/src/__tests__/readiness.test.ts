// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { Readiness } from '../readiness.ts';
import type { AppState } from '../api.ts';
import { PluginCards } from '../plugins.ts';

it('shows the stopped/failed recovery path and honest helper/session state', async () => {
  const state: AppState = {
    data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
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

it('offers refresh during a live session and displays progress, result and failure', async () => {
  const state: AppState = {
    data: { state: 'idle', gameBuild: 'A', catalogBuild: 'A', lastResult: null, error: null },
    proxy: { state: 'running', port: 2050, error: null },
    game: { dir: 'fixture', candidates: [], launcher: null, helper: { state: 'installed', backup: false } },
    sessions: { open: 1, connected: 1 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
  };
  const api = { post: vi.fn().mockResolvedValue({}) }, changed = vi.fn();
  const view = new Readiness(api, changed); view.update(state);
  const refresh = [...view.element.querySelectorAll('button')].find(b => b.textContent === 'Refresh game data')!;
  expect(refresh.disabled).toBe(false); refresh.click();
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/refresh-data', {});
  view.update({ ...state, data: { ...state.data, state: 'refreshing' } });
  expect(refresh.disabled).toBe(true); expect(view.element.textContent).toContain('Refreshing game data');
  const lastResult = { gameBuild: 'B', items: 2, projectiles: 3, tiles: 4, ms: 16_000 };
  view.update({ ...state, data: { ...state.data, lastResult } });
  expect(refresh.disabled).toBe(false); expect(view.element.textContent).toContain('2 items, 3 projectiles, 4 tiles (16000 ms)');
  view.update({ ...state, data: { ...state.data, state: 'failed', lastResult, error: 'fixture failure' } });
  expect(view.element.textContent).toContain('fixture failure');
  expect(view.element.textContent).toContain('2 items, 3 projectiles, 4 tiles (16000 ms)');
});
